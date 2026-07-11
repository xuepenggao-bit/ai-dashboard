const REPO = 'xuepenggao-bit/ai-dashboard';
const FILES = {
  portfolio: 'portfolio.json',
  preflight: 'data/preflight_log.json',
};
const WORKFLOWS = new Set(['refresh-aitrend.yml', 'refresh-ir.yml', 'refresh-kol.yml']);

function corsHeaders(request, env){
  const allowedOrigin = env.ALLOWED_ORIGIN || 'https://financial.qiwu.fun';
  const origin = request.headers.get('Origin');
  return {
    // 这不是鉴权；仅避免其他网页在浏览器中直接调用接口。
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(request, env, value, status=200){
  return new Response(JSON.stringify(value), {
    status,
    headers: {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...corsHeaders(request, env)},
  });
}

function utf8ToBase64(value){
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
  let binary = '';
  for(let i=0; i<bytes.length; i+=0x8000){
    binary += String.fromCharCode(...bytes.subarray(i, i+0x8000));
  }
  return btoa(binary);
}

function decodeContent(content){
  const binary = atob((content || '').replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function github(request, env, path, options={}){
  if(!env.GITHUB_TOKEN) throw new Error('Worker 未配置 GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      'Accept':'application/vnd.github+json',
      'Authorization':`Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version':'2022-11-28',
      ...(options.headers || {}),
    },
  });
  if(response.ok || response.status === 404 || response.status === 409) return response;
  const detail = await response.json().catch(()=>({}));
  throw new Error(`GitHub HTTP ${response.status}: ${detail.message || '请求失败'}`);
}

async function readFile(request, env, key){
  const file = FILES[key];
  const response = await github(request, env, `/repos/${REPO}/contents/${file}?_=${Date.now()}`);
  if(response.status === 404) return null;
  const result = await response.json();
  return {data:decodeContent(result.content), sha:result.sha};
}

async function writeFile(request, env, key){
  const file = FILES[key];
  const payload = await request.json().catch(()=>null);
  if(!payload || typeof payload.data !== 'object' || Array.isArray(payload.data)){
    return json(request, env, {message:'请求必须包含 JSON 对象 data'}, 400);
  }
  const response = await github(request, env, `/repos/${REPO}/contents/${file}`, {
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      message:key === 'portfolio' ? 'Update portfolio data' : `chore: preflight log ${new Date().toISOString().slice(0,10)}`,
      branch:'main',
      content:utf8ToBase64(payload.data),
      ...(typeof payload.sha === 'string' && payload.sha ? {sha:payload.sha} : {}),
    }),
  });
  if(response.status === 409){
    return json(request, env, {message:'GitHub 文件版本已更新，请重试'}, 409);
  }
  const result = await response.json();
  return json(request, env, {ok:true, sha:result.content?.sha || null});
}

async function dispatchWorkflow(request, env, filename){
  if(!WORKFLOWS.has(filename)) return json(request, env, {message:'不允许的工作流'}, 404);
  const response = await github(request, env,
    `/repos/${REPO}/actions/workflows/${encodeURIComponent(filename)}/dispatches`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ref:'main'}),
    });
  if(!response.ok && response.status !== 204) return json(request, env, {message:`GitHub HTTP ${response.status}`}, response.status);
  return json(request, env, {ok:true}, 202);
}

export default {
  async fetch(request, env){
    if(request.method === 'OPTIONS') return new Response(null, {status:204, headers:corsHeaders(request, env)});
    const pathname = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');
    try{
      if((pathname === 'portfolio' || pathname === 'preflight') && request.method === 'GET'){
        const data = await readFile(request, env, pathname);
        return data ? json(request, env, data) : json(request, env, {data:null, sha:null}, 404);
      }
      if((pathname === 'portfolio' || pathname === 'preflight') && request.method === 'PUT'){
        return writeFile(request, env, pathname);
      }
      if(pathname.startsWith('workflow/') && request.method === 'POST'){
        return dispatchWorkflow(request, env, decodeURIComponent(pathname.slice('workflow/'.length)));
      }
      return json(request, env, {message:'Not found'}, 404);
    }catch(error){
      console.error(error);
      return json(request, env, {message:error.message || '同步服务错误'}, 502);
    }
  },
};
