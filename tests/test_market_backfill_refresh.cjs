const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const Model=require('../assets/market-backfill-refresh.js');
const NOW=Date.parse('2026-11-05T16:30:00+08:00');
const item=(id='risk',state='stale',cadence='intraday')=>({id,state,cadence,label:id});
const response=(status,data={})=>({status,ok:status>=200&&status<300,json:async()=>data});
const file=value=>({sha:'sha-current',content:Buffer.from(JSON.stringify(value)).toString('base64')});
function harness(options={}){
  const state={now:NOW,token:'test-only-token',items:options.items||[item()],requests:[],statuses:[],refreshes:[],runs:new Map(),nextId:100,visible:true,timers:new Set(),mode:'running'};
  const fetch=async(url,config)=>{
    const p=new URL(url),route=p.pathname.replace('/repos/xuepenggao-bit/ai-dashboard/',''),body=config.body?JSON.parse(config.body):null;
    const request={route,url,method:config.method,body,config};state.requests.push(request);
    const custom=options.fetch&&await options.fetch(request,state);if(custom)return custom;
    if(route.match(/^actions\/workflows\/.+\/runs$/))return response(200,{workflow_runs:[]});
    if(route.match(/^actions\/workflows\/.+\/dispatches$/)){
      const workflow=decodeURIComponent(route.split('/')[2]),id=++state.nextId;
      state.runs.set(id,{id,path:'.github/workflows/'+workflow,head_branch:'main',status:'in_progress',conclusion:null});
      return response(200,{workflow_run_id:id});
    }
    if(route.match(/^actions\/runs\/\d+$/))return response(200,state.runs.get(Number(route.split('/')[2])));
    if(route.startsWith('contents/'))return response(404);
    throw Error('Unexpected API route '+route);
  };
  const controller=Model.createController({now:()=>state.now,getToken:()=>state.token,inspect:()=>state.items,
    visible:()=>state.visible,fetch,onStatus:value=>state.statuses.push(value),
    setTimer:(fn,delay)=>{const t={fn,delay};state.timers.add(t);return t;},clearTimer:t=>state.timers.delete(t),
    refresh:async args=>{state.refreshes.push(args);if(options.refresh)await options.refresh(args,state);}});
  const finish=(conclusion='success')=>{for(const run of state.runs.values())Object.assign(run,{status:'completed',conclusion});};
  return{state,controller,finish};
}

test('only stale supported daily/intraday indicators map to deduplicated allowlisted jobs',()=>{
  const p=Model.plan([item('highLow52'),item('maBreadth'),item('median'),item('concentration'),item('caps'),item('hkAmount'),item('margin'),item('heat'),item('accounts','pending','monthly'),item('etf','scheduled'),item('risk','current'),item('unmapped')]);
  assert.deepEqual(p.workflows,['refresh-high-low-52w.yml','refresh-market-quality.yml','refresh-market-kpis.yml','refresh-market-heat.yml']);
  assert.deepEqual(p.unsupported.map(x=>x.id),['unmapped']);
  assert.ok(Model.WORKFLOWS.every(name=>/^refresh-[a-z0-9-]+\.yml$/.test(name)));
  assert.equal(Model.WORKFLOW_MAP.amount,'refresh-market-breadth.yml');
  assert.equal(Model.WORKFLOW_MAP.ssePe,'refresh-market-kpis.yml');
});

test('automatic refresh and monthly expected-publication gaps never dispatch jobs',async()=>{
  const h=harness({items:[item('accounts','pending','monthly')]});
  await h.controller.request({reason:'auto'});assert.equal(h.state.requests.length,0);
  assert.equal((await h.controller.request({reason:'manual'})).state,'current');assert.equal(h.state.requests.length,0);
});

test('no saved token reports no backend trigger instead of fake successful refresh',async()=>{
  const h=harness();h.state.token='';const status=await h.controller.request({reason:'manual'});
  assert.equal(status.state,'authentication');assert.match(status.message,/没有触发/);assert.equal(h.state.requests.length,0);
});

test('accepted 200 dispatch is not completion; token stays only in request headers',async()=>{
  const h=harness();const status=await h.controller.request({reason:'manual'});
  assert.equal(status.state,'running');assert.equal(status.jobs[0].runId,101);assert.equal(status.jobs[0].status,'queued');
  const dispatched=h.state.requests.find(x=>x.method==='POST');
  assert.deepEqual(dispatched.body,{ref:'main',return_run_details:true});
  for(const request of h.state.requests){assert.equal(request.config.headers.Authorization,'Bearer test-only-token');assert.equal(request.config.cache,'no-store');assert.equal(request.url.includes('test-only-token'),false);}
  assert.equal(JSON.stringify(h.state.statuses).includes('test-only-token'),false);
  await h.controller.poll();assert.equal(h.controller.getStatus().state,'running');
  assert.ok(h.state.refreshes.every(x=>x.force===true&&x.reason==='backfill'&&x.backend===true));
});

test('concurrent manual clicks share one request and monitoring never redispatches an active batch',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({fetch:async request=>{if(request.route.includes('/dispatches'))await gate;}});
  const a=h.controller.request({reason:'manual'}),b=h.controller.request({reason:'manual'});assert.equal(a,b);
  release();await Promise.all([a,b]);await h.controller.request({reason:'manual'});
  assert.equal(h.state.requests.filter(x=>x.method==='POST').length,1);
});

test('an already queued/in-progress workflow is reused without dispatching another run',async()=>{
  const h=harness({fetch:async request=>request.route.includes('/runs')&&!request.route.startsWith('actions/runs/')?response(200,{workflow_runs:[{id:55,path:'.github/workflows/refresh-market-risk.yml',head_branch:'main',status:'in_progress',conclusion:null}]}):null});
  const result=await h.controller.request({reason:'manual'});
  assert.equal(result.jobs[0].runId,55);assert.equal(result.jobs[0].reused,true);assert.equal(h.state.requests.some(x=>x.method==='POST'),false);
});

test('old 204 dispatch response resolves only a new matching workflow run, not an old successful run',async()=>{
  let listing=0;
  const h=harness({fetch:async request=>{
    if(request.route.includes('/dispatches'))return response(204);
    if(request.route.includes('/runs'))return response(200,{workflow_runs:++listing===1?[{id:1,path:'.github/workflows/refresh-market-risk.yml',head_branch:'main',created_at:new Date(NOW-60000).toISOString(),status:'completed',conclusion:'success'}]:[
      {id:2,path:'.github/workflows/refresh-market-risk.yml',head_branch:'main',created_at:new Date(NOW).toISOString(),status:'in_progress',conclusion:null},
      {id:3,path:'.github/workflows/refresh-market-risk.yml',head_branch:'other',created_at:new Date(NOW).toISOString(),status:'completed',conclusion:'success'}]});
  }});
  await h.controller.request({reason:'manual'});assert.equal(h.controller.getStatus().jobs[0].runId,null);
  await h.controller.poll();assert.equal(h.controller.getStatus().jobs[0].runId,2);assert.equal(h.controller.getStatus().state,'running');
});

test('unsupported return details is retried once without the optional flag',async()=>{
  let posts=0;const h=harness({fetch:async request=>request.method==='POST'&&++posts===1?response(422):null});
  await h.controller.request({reason:'manual'});const calls=h.state.requests.filter(x=>x.method==='POST');
  assert.equal(calls.length,2);assert.deepEqual(calls[1].body,{ref:'main'});
});

test('403 Actions scope falls back to a small contents-write request without putting token in JSON',async()=>{
  let saved;
  const h=harness({fetch:async request=>{
    if(request.route.startsWith('actions/'))return response(403);
    if(request.method==='PUT'){saved=JSON.parse(Buffer.from(request.body.content,'base64').toString('utf8'));return response(201,{commit:{sha:'request-sha'}});}
  }});
  const status=await h.controller.request({reason:'manual',requestId:'request-test'});
  assert.equal(status.state,'running');assert.equal(status.mode,'request-file');
  assert.equal(saved.schemaVersion,1);assert.equal(saved.requestId,'request-test');assert.deepEqual(saved.workflows,['refresh-market-risk.yml']);
  assert.deepEqual(saved.itemIds,['risk']);assert.equal(JSON.stringify(saved).includes('test-only-token'),false);
});

test('recent matching repository request is reused across browsers without another file write',async()=>{
  const h=harness({fetch:async request=>{
    if(request.route.startsWith('actions/'))return response(403);
    if(request.route==='contents/'+Model.REQUEST_FILE)return response(200,file({schemaVersion:1,requestId:'other-browser',requestedAt:new Date(NOW-10000).toISOString(),workflows:['refresh-market-risk.yml']}));
  }});
  const status=await h.controller.request({reason:'manual'});assert.equal(status.requestId,'other-browser');assert.equal(h.state.requests.some(x=>x.method==='PUT'),false);
});

test('permission failure, invalid authentication and rate limiting remain honest non-success states',async()=>{
  for(const code of [401,403,429]){
    const h=harness({fetch:async request=>request.route.startsWith('actions/')||request.method==='PUT'?response(code):null});
    const status=await h.controller.request({reason:'manual'});
    assert.equal(status.state,code===401?'authentication':code===429?'rate_limited':'permission');
    assert.equal(status.state==='complete',false);
  }
});

test('successful run is not treated as refreshed data when source freshness still has gaps',async()=>{
  const h=harness();await h.controller.request({reason:'manual'});h.finish();await h.controller.poll();
  const status=h.controller.getStatus();assert.equal(status.state,'partial');assert.match(status.message,/仍待数据源更新/);assert.equal(status.remaining[0].id,'risk');
  assert.ok(h.state.refreshes.length>=1);
});

test('successful jobs plus verified fresh data completes; failures never claim data updated',async()=>{
  const h=harness({refresh:async(_args,state)=>{if([...state.runs.values()].every(x=>x.status==='completed'))state.items=[item('risk','current')];}});
  await h.controller.request({reason:'manual'});h.finish();await h.controller.poll();assert.equal(h.controller.getStatus().state,'complete');
  const broken=harness();await broken.controller.request({reason:'manual'});broken.finish('failure');await broken.controller.poll();
  assert.equal(broken.controller.getStatus().state,'partial');assert.match(broken.controller.getStatus().message,/未全部成功/);
});

test('repository status must match request id and actual child jobs; a boolean completion flag is not proof',async()=>{
  let status;
  const h=harness({fetch:async request=>{
    if(request.route.startsWith('actions/'))return response(403);
    if(request.method==='PUT')return response(201,{});
    if(request.route==='contents/'+Model.STATUS_FILE)return response(200,file(status));
  }});
  await h.controller.request({reason:'manual',requestId:'mine'});
  status={schemaVersion:1,requestId:'other',state:'complete',jobs:[{workflow:'refresh-market-risk.yml',runId:200,status:'completed',conclusion:'success'}]};
  await h.controller.poll();assert.equal(h.controller.getStatus().state,'running');assert.equal(h.controller.getStatus().jobs[0].runId,null);
  status={schemaVersion:1,requestId:'mine',state:'complete',jobs:[]};await h.controller.poll();assert.equal(h.controller.getStatus().state,'running');
  status.jobs=[{workflow:'refresh-market-risk.yml',runId:200,status:'completed',conclusion:'success'}];
  h.state.items=[item('risk','current')];await h.controller.poll();assert.equal(h.controller.getStatus().state,'complete');
});

test('heat is recomputed only after upstream jobs finish and then verified again',async()=>{
  const h=harness({items:[item('risk'),item('heat')],refresh:async(_args,state)=>{
    const heat=[...state.runs.values()].find(x=>x.path.endsWith('/refresh-market-heat.yml'));
    if(heat?.status==='completed')state.items=[item('risk','current'),item('heat','current')];
  }});
  await h.controller.request({reason:'manual'});assert.equal(h.state.requests.filter(x=>x.method==='POST').length,1);
  assert.equal(h.controller.getStatus().jobs.find(x=>x.workflow==='refresh-market-heat.yml').status,'deferred');
  h.finish();await h.controller.poll();assert.equal(h.state.requests.filter(x=>x.method==='POST').length,2);assert.equal(h.controller.getStatus().state,'running');
  h.finish();await h.controller.poll();assert.equal(h.controller.getStatus().state,'complete');
});

test('hidden page pauses polling and eight-minute watch expiry reports still running, not failure',async()=>{
  const h=harness();await h.controller.request({reason:'manual'});const calls=h.state.requests.length;
  h.state.visible=false;await h.controller.poll();assert.equal(h.state.requests.length,calls);
  h.state.now+=Model.WATCH_MS;await h.controller.poll();assert.equal(h.controller.getStatus().state,'waiting');assert.match(h.controller.getStatus().message,/仍在运行/);
  h.state.visible=true;await h.controller.request({reason:'manual'});assert.equal(h.state.requests.filter(x=>x.method==='POST').length,1);assert.equal(h.controller.getStatus().state,'running');
});

test('failed upstream prevents a misleading heat recomputation from stale inputs',async()=>{
  const h=harness({items:[item('risk'),item('heat')]});
  await h.controller.request({reason:'manual'});h.finish('failure');await h.controller.poll();
  assert.equal(h.state.requests.filter(x=>x.method==='POST').length,1);
  const heat=h.controller.getStatus().jobs.find(x=>x.workflow==='refresh-market-heat.yml');
  assert.equal(heat.conclusion,'skipped');assert.equal(heat.blockedByUpstream,true);assert.equal(h.controller.getStatus().state,'partial');
});

test('a heat run started before upstream completed is not reused as proof of a new recomputation',async()=>{
  const h=harness({items:[item('risk'),item('heat')],fetch:async request=>
    request.route==='actions/workflows/refresh-market-heat.yml/runs'?response(200,{workflow_runs:[{
      id:44,path:'.github/workflows/refresh-market-heat.yml',head_branch:'main',status:'in_progress',conclusion:null,
      created_at:new Date(NOW-60000).toISOString(),run_started_at:new Date(NOW-60000).toISOString()
    }]}):null});
  await h.controller.request({reason:'manual'});h.finish();await h.controller.poll();
  assert.equal(h.state.requests.filter(x=>x.method==='POST').length,2);
  assert.notEqual(h.controller.getStatus().jobs.find(x=>x.workflow==='refresh-market-heat.yml').runId,44);
});

test('a recently completed attempt is throttled but a later explicit retry may rerun a still-stale source',async()=>{
  const h=harness();await h.controller.request({reason:'manual'});h.finish();await h.controller.poll();
  const status=await h.controller.request({reason:'manual'});assert.equal(status.state,'cooldown');assert.equal(h.state.requests.filter(x=>x.method==='POST').length,1);
  h.state.now+=Model.COOLDOWN_MS;await h.controller.request({reason:'manual'});assert.equal(h.state.requests.filter(x=>x.method==='POST').length,2);
});

test('controller has no local token storage, hardcoded credential or workflow-name escape',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../assets/market-backfill-refresh.js'),'utf8');
  assert.doesNotMatch(source,/localStorage|github_pat_|ghp_[A-Za-z0-9]{10}/);
  assert.throws(()=>Model.createController({repo:'example/../../escape'}));
  assert.equal(Model.plan([item('evil.yml')]).workflows.length,0);
});
