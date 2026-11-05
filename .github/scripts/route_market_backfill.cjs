/* A bounded, allowlisted bridge for browsers whose saved PAT has Contents write only. */
'use strict';
const ALLOWED=Object.freeze(['refresh-high-low-52w.yml','refresh-market-breadth.yml','refresh-market-quality.yml','refresh-market-risk.yml','refresh-etf-shares.yml','refresh-market-kpis.yml','refresh-market-heat.yml']);
function validateRequest(raw,now=Date.now()){
  const stamp=Date.parse(raw?.requestedAt);
  if(raw?.schemaVersion!==1||!(/^[A-Za-z0-9_-]{8,96}$/).test(raw.requestId||'')||!Number.isFinite(stamp)||stamp>now+300000||now-stamp>2*86400000||
    !Array.isArray(raw.workflows)||!raw.workflows.length||raw.workflows.length>ALLOWED.length||raw.workflows.some(file=>!ALLOWED.includes(file)))throw Error('Invalid market backfill request');
  return{schemaVersion:1,requestId:raw.requestId,requestedAt:new Date(stamp).toISOString(),workflows:[...new Set(raw.workflows)]};
}
async function route(raw,options){
  const now=options.now||Date.now,request=validateRequest(raw,now()),wait=options.sleep|| (ms=>new Promise(resolve=>setTimeout(resolve,ms))),start=now();
  const jobs=request.workflows.map(workflow=>({workflow,runId:null,status:'waiting',conclusion:null}));
  const status={schemaVersion:1,requestId:request.requestId,state:'running',jobs,requestedAt:request.requestedAt};
  let last='';
  async function persist(){const signature=JSON.stringify(status);if(signature===last)return;last=signature;await options.writeStatus({...status,updatedAt:new Date(now()).toISOString(),jobs:jobs.map(job=>({...job}))});}
  async function launch(job){
    try{
      // A queued/in-progress collector is already a real retry; do not enqueue
      // another full-market scan just because another browser clicked too.
      const recent=await options.listRuns(job.workflow);
      const running=recent.find(run=>run.head_branch==='main'&&['queued','in_progress','waiting','pending','requested'].includes(run.status)&&Date.parse(run.created_at)>now()-2*3600000&&
        !(job.workflow==='refresh-market-heat.yml'&&upstream.length&&run.status==='in_progress'));
      if(running){job.runId=running.id;job.status=running.status;job.reused=true;return;}
      const excluded=new Set(recent.map(run=>run.id)),dispatched=await options.dispatch(job.workflow);
      if(Number.isSafeInteger(dispatched?.workflow_run_id)&&dispatched.workflow_run_id>0){job.runId=dispatched.workflow_run_id;job.status='queued';return;}
      // Older GitHub API versions return 204, which proves acceptance, not
      // completion. Locate a genuinely new run rather than taking latest blindly.
      job.status='accepted';
      for(let attempt=0;attempt<8&&!job.runId;attempt++){
        await wait(2500);const runs=await options.listRuns(job.workflow);
        const run=runs.find(run=>!excluded.has(run.id)&&run.head_branch==='main'&&run.event==='workflow_dispatch'&&Date.parse(run.created_at)>=start-5000);
        if(run){job.runId=run.id;job.status=run.status;}
      }
      if(!job.runId)throw Error('Workflow accepted but run is not visible yet');
    }catch(error){job.status='completed';job.conclusion='failure';job.message=error.status?'GitHub HTTP '+error.status:'后台任务未能启动';}
  }
  async function phase(list){
    await Promise.all(list.map(launch));await persist();
    while(list.some(job=>job.status!=='completed')){
      if(now()-start>=(options.maxMs||2400000)){status.monitoringStopped=true;status.message='后台任务仍在运行；页面可继续跟踪实际任务';await persist();return false;}
      await wait(options.pollMs||15000);
      await Promise.all(list.filter(job=>job.runId&&job.status!=='completed').map(async job=>{
        try{const run=await options.getRun(job.runId);if(run.id!==job.runId||run.head_branch!=='main')throw Error('Run identity mismatch');job.status=run.status;job.conclusion=run.conclusion||null;delete job.pollError;}
        catch(_){job.pollError='暂未取得任务状态，稍后重试';}
      }));await persist();
    }
    return true;
  }
  await persist();
  const upstream=jobs.filter(job=>job.workflow!=='refresh-market-heat.yml'),heat=jobs.filter(job=>job.workflow==='refresh-market-heat.yml');
  if(!await phase(upstream))return status;
  if(upstream.some(job=>job.conclusion!=='success')){
    for(const job of heat){job.status='completed';job.conclusion='skipped';job.message='上游尚未补齐，不以旧数据重算热度';}
  }else if(!await phase(heat))return status;
  status.state=jobs.every(job=>job.conclusion==='success')?'complete':'failed';await persist();return status;
}
async function main(){
  const fs=require('node:fs'),repo=process.env.GITHUB_REPOSITORY,token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'')||!token)throw Error('Missing repository authentication');
  const path='data/market_refresh_request.json';
  if(!fs.existsSync(path)){console.log('No market backfill request to process');return;}
  const raw=JSON.parse(fs.readFileSync(path,'utf8')),base='https://api.github.com/repos/'+repo;
  async function api(path,body,method='GET'){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{const response=await fetch(base+path,{method,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:controller.signal,body:body?JSON.stringify(body):undefined});
      if(!response.ok){const error=Error('GitHub HTTP '+response.status);error.status=response.status;throw error;}
      return response.status===204?null:await response.json();
    }finally{clearTimeout(timer);}
  }
  async function writeStatus(payload){
    const content=Buffer.from(JSON.stringify(payload,null,2)+'\n').toString('base64'),path='/contents/data/market_refresh_status.json';
    for(let attempt=0;attempt<4;attempt++){
      let sha;try{sha=(await api(path+'?ref=main')).sha;}catch(error){if(error.status!==404)throw error;}
      try{return await api(path,{message:'chore: track requested market data backfill',branch:'main',content,...(sha?{sha}:{})},'PUT');}catch(error){if(![409,422].includes(error.status)||attempt===3)throw error;}
    }
  }
  const result=await route(raw,{writeStatus,listRuns:async file=>(await api('/actions/workflows/'+file+'/runs?branch=main&per_page=20')).workflow_runs||[],
    dispatch:file=>api('/actions/workflows/'+file+'/dispatches',{ref:'main',return_run_details:true},'POST'),getRun:id=>api('/actions/runs/'+id)});
  console.log('Market backfill '+result.state+'; tracked '+result.jobs.length+' allowlisted collectors');
}
module.exports={ALLOWED,validateRequest,route};
if(require.main===module)main().catch(error=>{console.error(error.status?'GitHub HTTP '+error.status:error.message);process.exitCode=1;});
