/* Manual-only recovery of stale market snapshots. No credentials are persisted here. */
(function(root,factory){
  const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.MarketBackfillRefresh=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const REPO='xuepenggao-bit/ai-dashboard',REQUEST_FILE='data/market_refresh_request.json',STATUS_FILE='data/market_refresh_status.json';
  const COOLDOWN_MS=120000,POLL_MS=15000,WATCH_MS=8*60000;
  const WORKFLOW_MAP=Object.freeze({
    caps:'refresh-market-kpis.yml',ssePe:'refresh-market-kpis.yml',szePe:'refresh-market-kpis.yml',gemPe:'refresh-market-kpis.yml',starPe:'refresh-market-kpis.yml',
    hkAmount:'refresh-market-kpis.yml',margin:'refresh-market-kpis.yml',
    amount:'refresh-market-breadth.yml',breadth:'refresh-market-breadth.yml',limits:'refresh-market-breadth.yml',
    highLow52:'refresh-high-low-52w.yml',maBreadth:'refresh-high-low-52w.yml',
    risk:'refresh-market-risk.yml',median:'refresh-market-quality.yml',concentration:'refresh-market-quality.yml',
    etf:'refresh-etf-shares.yml',heat:'refresh-market-heat.yml'
  });
  const WORKFLOWS=Object.freeze([...new Set(Object.values(WORKFLOW_MAP))]);
  const HEAT='refresh-market-heat.yml',WAITING=new Set(['queued','in_progress','waiting','pending','requested']);
  function candidates(items){return(Array.isArray(items)?items:[]).filter(x=>x&&x.cadence!=='monthly'&&['stale','pending','unknown'].includes(x.state));}
  function plan(items){
    const target=candidates(items),workflows=[...new Set(target.map(x=>WORKFLOW_MAP[x.id]).filter(Boolean))];
    return{items:target,workflows,unsupported:target.filter(x=>!WORKFLOW_MAP[x.id])};
  }
  function safeId(value){return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:null;}
  function utf8Encode(value){
    const bytes=new TextEncoder().encode(JSON.stringify(value));let text='';
    for(let i=0;i<bytes.length;i+=4096)text+=String.fromCharCode(...bytes.subarray(i,i+4096));
    return root.btoa(text);
  }
  function decodeContent(data){
    if(typeof data?.content!=='string')throw Error('后台状态格式无效');
    const text=root.atob(data.content.replace(/\s+/g,'')),bytes=Uint8Array.from(text,c=>c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function createController(options={}){
    const now=options.now||Date.now,repo=options.repo||REPO;
    if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('Invalid repository');
    const getToken=options.getToken||(()=>typeof root._getGithubToken==='function'?root._getGithubToken():''),
      inspect=options.inspect||(()=>root.MarketEnvironmentFreshness?.inspect(now())||[]),
      visible=options.visible||(()=>!root.document?.hidden&&!!root.document?.getElementById('t0')?.classList.contains('active')),
      refresh=options.refresh||(args=>typeof root.refreshMacro==='function'?root.refreshMacro(args):Promise.resolve()),
      later=options.setTimer||setTimeout,cancel=options.clearTimer||clearTimeout;
    const onStatus=options.onStatus||renderStatus;
    let batch=null,starting=null,polling=null,timer=null,destroyed=false,lastStatus={state:'idle',message:''},lastReload=0;
    const lastStarted=new Map();
    function publish(state,message,extra={}){
      const jobs=batch?[...batch.jobs.values()].map(x=>({...x})):[];
      lastStatus={state,message,requestId:batch?.requestId||null,mode:batch?.mode||null,jobs,...extra};
      try{onStatus(lastStatus);}catch(_){}return lastStatus;
    }
    async function api(path,method='GET',body){
      const token=String(getToken()||'').trim();if(!token){const e=Error('浏览器未连接GitHub，未触发后台刷新');e.status=401;e.missingToken=true;throw e;}
      const controller=new AbortController(),timeout=later(()=>controller.abort(),10000);
      try{
        const response=await(options.fetch||root.fetch)('https://api.github.com/repos/'+repo+'/'+path,{
          method,cache:'no-store',credentials:'omit',signal:controller.signal,
          headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2026-03-10',...(body?{'Content-Type':'application/json'}:{})},
          ...(body?{body:JSON.stringify(body)}:{})
        });
        if(!response.ok){const error=Error('GitHub HTTP '+response.status);error.status=response.status;throw error;}
        return{status:response.status,data:response.status===204?null:await response.json()};
      }finally{cancel(timeout);}
    }
    async function getFile(path){try{const response=await api('contents/'+path+'?ref=main&_='+now());return{sha:response.data.sha,value:decodeContent(response.data)};}catch(e){if(e.status===404)return null;throw e;}}
    function runMatches(run,file){return safeId(run?.id)&&(!run.path||run.path.split('/').pop()===file)&&(!run.head_branch||run.head_branch==='main');}
    function jobFromRun(file,run){return{workflow:file,runId:safeId(run.id),status:String(run.status||'queued'),conclusion:run.conclusion||null};}
    async function dispatch(file,notBefore=0){
      let runs=[];
      try{const list=await api('actions/workflows/'+encodeURIComponent(file)+'/runs?branch=main&per_page=10&_='+now());runs=(list.data?.workflow_runs||[]).filter(r=>runMatches(r,file));}catch(e){if(e.status===401)throw e;}
      const running=runs.find(r=>WAITING.has(r.status)&&(!notBefore||r.status==='queued'||Date.parse(r.run_started_at||r.created_at||'')>=notBefore));
      if(running){lastStarted.set(file,now());return{...jobFromRun(file,running),reused:true};}
      const started=now(),baseline=runs.map(r=>r.id);
      let response;
      try{response=await api('actions/workflows/'+encodeURIComponent(file)+'/dispatches','POST',{ref:'main',return_run_details:true});}
      catch(e){
        // Older API deployments can reject the optional response-details flag.
        if(e.status!==400&&e.status!==422)throw e;
        response=await api('actions/workflows/'+encodeURIComponent(file)+'/dispatches','POST',{ref:'main'});
      }
      lastStarted.set(file,started);
      const id=safeId(response.data?.workflow_run_id)||safeId(response.data?.id);
      return{workflow:file,runId:id,status:'queued',conclusion:null,requestedAt:started,baseline};
    }
    function statusJobs(payload){
      if(payload?.schemaVersion!==1||payload.requestId!==batch?.requestId||!Array.isArray(payload.jobs))return null;
      return payload.jobs.filter(job=>WORKFLOWS.includes(job?.workflow)&&batch.jobs.has(job.workflow)).map(job=>({
        workflow:job.workflow,runId:safeId(job.runId),status:['completed',...WAITING].includes(job.status)?job.status:'queued',
        conclusion:job.status==='completed'&&typeof job.conclusion==='string'?job.conclusion:null
      }));
    }
    async function requestByFile(workflows){
      const old=await getFile(REQUEST_FILE),prior=old?.value;
      const recent=prior?.schemaVersion===1&&typeof prior.requestId==='string'&&Array.isArray(prior.workflows)&&
        Number.isFinite(Date.parse(prior.requestedAt))&&now()-Date.parse(prior.requestedAt)>=0&&now()-Date.parse(prior.requestedAt)<COOLDOWN_MS&&
        workflows.every(file=>prior.workflows.includes(file));
      if(recent){batch.requestId=prior.requestId;batch.mode='request-file';return;}
      const value={schemaVersion:1,requestId:batch.requestId,requestedAt:new Date(now()).toISOString(),workflows,
        itemIds:batch.itemIds.filter(id=>WORKFLOW_MAP[id])};
      const body={message:'Request market snapshot backfill '+batch.requestId,branch:'main',content:utf8Encode(value),...(old?.sha?{sha:old.sha}:{})};
      try{await api('contents/'+REQUEST_FILE,'PUT',body);}
      catch(e){if(e.status!==409)throw e;const latest=await getFile(REQUEST_FILE);if(latest?.sha)body.sha=latest.sha;await api('contents/'+REQUEST_FILE,'PUT',body);}
      batch.mode='request-file';for(const file of workflows)lastStarted.set(file,now());
    }
    function schedule(){if(destroyed||!batch||!batch.active)return;if(timer!=null)cancel(timer);timer=later(()=>{timer=null;poll();},POLL_MS);}
    async function reload(force=false){
      if(!visible())return;
      if(force||now()-lastReload>=45000){lastReload=now();await refresh({force:true,reason:'backfill',backend:true});}
    }
    function remaining(){const ids=new Set(batch?.itemIds||[]);return candidates(inspect()).filter(x=>ids.has(x.id));}
    async function pollRun(job){
      let run;
      if(job.runId){run=(await api('actions/runs/'+job.runId+'?_='+now())).data;if(!runMatches(run,job.workflow))throw Error('后台任务身份不匹配');}
      else{
        const response=await api('actions/workflows/'+encodeURIComponent(job.workflow)+'/runs?branch=main&event=workflow_dispatch&per_page=10&_='+now());
        run=(response.data?.workflow_runs||[]).filter(r=>runMatches(r,job.workflow)&&!(job.baseline||[]).includes(r.id)&&Date.parse(r.created_at||'')>=job.requestedAt-5000).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))[0];
      }
      if(run)Object.assign(job,jobFromRun(job.workflow,run));
    }
    async function pollWork(){
      if(destroyed||!batch||!batch.active)return lastStatus;
      if(now()>=batch.deadline){batch.active=false;return publish('waiting','后台仍在运行，可稍后点击“刷新全部”继续核对；未把旧数据标为已更新。');}
      if(!visible()){schedule();return lastStatus;}
      try{
        const previouslyDone=[...batch.jobs.values()].filter(j=>j.status==='completed').length;
        if(batch.mode==='request-file'){
          const file=await getFile(STATUS_FILE),status=file?.value,jobs=statusJobs(status);
          if(jobs){for(const job of jobs)Object.assign(batch.jobs.get(job.workflow),job);
            if(status.state==='failed'){
              batch.active=false;await reload(true);return publish('partial','后台补数未完成，已保留有效数据；可稍后重试。',{remaining:remaining()});
            }
          }
        }else{
          for(const job of batch.jobs.values())if(job.status!=='completed'&&job.status!=='deferred')await pollRun(job);
          const heat=batch.jobs.get(HEAT),upstream=[...batch.jobs.values()].filter(j=>j.workflow!==HEAT);
          if(heat?.status==='deferred'&&upstream.every(j=>j.status==='completed')){
            const failed=upstream.some(j=>j.conclusion!=='success');
            if(failed)Object.assign(heat,{status:'completed',conclusion:'skipped',blockedByUpstream:true});
            else{
              await reload(true);const needed=remaining().some(item=>item.id==='heat');
              if(needed)Object.assign(heat,await dispatch(HEAT,now()));
              else Object.assign(heat,{status:'completed',conclusion:'success',alreadyCurrent:true});
            }
          }
        }
        const jobs=[...batch.jobs.values()],terminal=jobs.length&&jobs.every(j=>j.status==='completed');
        if(terminal){
          batch.active=false;await reload(true);const gaps=remaining(),failures=jobs.filter(j=>j.conclusion!=='success');
          if(failures.length)return publish('partial','后台任务未全部成功，已重新读取有效快照，仍待补齐。',{remaining:gaps});
          return gaps.length?publish('partial','后台已运行并重新读取；'+gaps.map(x=>x.label).join('、')+'仍待数据源更新。',{remaining:gaps}):publish('complete','后台补数完成，已核对最新数据。',{remaining:[]});
        }
        // Polling run status is cheap. Only a newly completed source job warrants
        // rereading charts; do not repeat whole-market scans every poll interval.
        if(jobs.filter(j=>j.status==='completed').length>previouslyDone)await reload();
        publish('running','后台补数进行中 · '+jobs.filter(j=>j.status==='completed').length+'/'+jobs.length+'项任务完成，完成后自动重新读取。');
      }catch(error){
        if(error.status===401||error.status===403){batch.active=false;return publish('permission','后台任务已提交，但暂无权限核对运行状态；没有将数据标记为已更新。');}
        publish('running','后台状态暂不可达，保留有效数据，稍后自动重试。');
      }
      schedule();return lastStatus;
    }
    function poll(){if(polling)return polling;polling=Promise.resolve().then(pollWork).finally(()=>{polling=null;});return polling;}
    function request(options={}){
      if(options.reason!=='manual')return Promise.resolve(lastStatus);
      if(starting)return starting;
      if(batch&&(batch.active||lastStatus.state==='waiting')){
        batch.active=true;batch.deadline=now()+WATCH_MS;publish('running','已有后台补数任务，继续核对进度，不重复触发。');schedule();return Promise.resolve(lastStatus);
      }
      const selected=plan(options.items||inspect());
      if(!selected.items.length)return Promise.resolve(publish('current','已核验，当前没有待后台补齐的数据。'));
      if(!selected.workflows.length)return Promise.resolve(publish('frontend','待补项由实时接口提供，已重试实时源；当前没有对应后台任务。',{unsupported:selected.unsupported}));
      if(!String(getToken()||'').trim())return Promise.resolve(publish('authentication','浏览器尚未连接GitHub：已重试实时源，但没有触发后台任务。'));
      const ready=selected.workflows.filter(file=>!lastStarted.has(file)||now()-lastStarted.get(file)>=COOLDOWN_MS);
      if(!ready.length)return Promise.resolve(publish('cooldown','刚刚已请求后台补数，暂不重复触发；数据源尚未更新时会保留有效快照。'));
      batch={requestId:(options.requestId||'market-'+now()+'-'+Math.random().toString(36).slice(2,8)),mode:'direct',active:true,
        startedAt:now(),deadline:now()+WATCH_MS,itemIds:selected.items.map(x=>x.id),jobs:new Map(ready.map(file=>[file,{workflow:file,runId:null,status:file===HEAT&&ready.length>1?'deferred':'queued',conclusion:null}]))};
      publish('starting','正在请求后台补数…',{unsupported:selected.unsupported});
      starting=(async()=>{
        try{
          for(const job of batch.jobs.values())if(job.status!=='deferred')Object.assign(job,await dispatch(job.workflow));
        }catch(error){
          if(error.status===403||error.status===404){
            try{await requestByFile(ready);for(const job of batch.jobs.values()){job.status='queued';job.runId=null;job.conclusion=null;}}
            catch(fallback){batch.active=false;return publish(fallback.status===401?'authentication':fallback.status===429?'rate_limited':'permission',fallback.status===429?'GitHub请求过于频繁，未确认后台任务，请稍后再试。':'现有GitHub连接无法触发后台刷新；已保留有效数据，请检查令牌的仓库写入权限。');}
          }else{batch.active=false;return publish(error.status===401?'authentication':error.status===429?'rate_limited':'error',error.status===401?'GitHub连接已失效，未触发后台刷新。':error.status===429?'GitHub请求过于频繁，请稍后重试。':'暂未确认后台请求成功，保留有效数据。');}
        }
        publish('running',batch.mode==='request-file'?'已通过仓库刷新请求启动后台补数，等待任务运行；完成后自动读取。':'后台刷新请求已接受，等待运行完成；尚未将数据标为最新。',{unsupported:selected.unsupported});schedule();return lastStatus;
      })().finally(()=>{starting=null;});return starting;
    }
    function destroy(){destroyed=true;if(timer!=null)cancel(timer);timer=null;if(batch)batch.active=false;}
    return{request,poll,getStatus:()=>lastStatus,destroy};
  }
  function renderStatus(status){
    const el=root.document?.getElementById('marketBackfillStatus');if(!el)return;
    el.textContent=status.message||'';el.style.color=['partial','authentication','permission','error','rate_limited','waiting'].includes(status.state)?'#9a670d':status.state==='complete'?'#087a59':'#476781';
    el.title=(status.jobs||[]).map(job=>job.workflow+'：'+job.status+(job.conclusion?' / '+job.conclusion:'')).join('\n');
  }
  let controller;
  function instance(){if(!controller)controller=createController();return controller;}
  return{WORKFLOW_MAP,WORKFLOWS,REQUEST_FILE,STATUS_FILE,COOLDOWN_MS,POLL_MS,WATCH_MS,plan,candidates,createController,renderStatus,
    request:options=>instance().request(options),poll:()=>instance().poll(),getStatus:()=>instance().getStatus()};
});
