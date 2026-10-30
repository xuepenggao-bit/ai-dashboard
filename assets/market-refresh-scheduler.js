(function(root){
  'use strict';
  function createController(options={}){
    const now=options.now||Date.now,active=options.active||(()=>!root.document?.hidden&&root.document?.getElementById('t0')?.classList.contains('active'));
    const getReport=options.getReport||(()=>root.refreshMacro?.lastReport),busy=options.busy||(()=>!!root.refreshMacro?.pending);
    const full=options.full||(()=>root.refreshMacro({force:false,reason:'auto'})),kpis=options.kpis||(()=>root.fetchMacroKpis(true));
    let fullAt=0,kpiAt=0,fullPending=null,kpiPending=null;
    function ensure(){
      if(!active())return Promise.resolve(false);
      const time=now(),last=getReport(),reportAt=Number.isFinite(last?.startedAt)&&last.startedAt<=time?last.startedAt:0;
      if(busy())return Promise.resolve(false);
      // Date-aware module checks remain independent. Slow, disclosed data is
      // rechecked every five minutes; this does not force a new all-stock scan.
      if(!fullPending&&!kpiPending&&time-Math.max(fullAt,reportAt)>=300000){
        fullAt=time;fullPending=Promise.resolve().then(full).catch(()=>false).finally(()=>{fullPending=null;});return fullPending;
      }
      if(!kpiPending&&!fullPending&&time-Math.max(kpiAt,fullAt,reportAt)>=60000){
        kpiAt=time;kpiPending=Promise.resolve().then(kpis).catch(()=>false).finally(()=>{kpiPending=null;});return kpiPending;
      }
      return fullPending||kpiPending||Promise.resolve(false);
    }
    return{ensure};
  }
  function renderFreshness(){
    const el=root.document?.getElementById('marketFreshnessStatus');if(!el||!root.MarketEnvironmentFreshness)return;
    const items=root.MarketEnvironmentFreshness.inspect(),stale=items.filter(item=>item.state==='stale'),pending=items.filter(item=>item.state==='pending');
    el.textContent=stale.length?'待补齐：'+stale.map(item=>item.label).join('、'):
      pending.length?'盘中统计正在更新 · '+pending.map(item=>item.label).join('、'):'盘中指标约每分钟更新 · 日频、月频指标按实际披露更新';
    el.style.color=stale.length?'#b45309':'#64748b';el.title=items.map(item=>item.label+'：'+item.message).join('\n');
    return items;
  }
  const api={createController,renderFreshness};root.MarketEnvironmentRefresh=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root.document){const start=()=>{const controller=createController(),run=()=>{if(root.document.hidden||!root.document.getElementById('t0')?.classList.contains('active'))return;controller.ensure();renderFreshness();};
    const tab=root.document.getElementById('t0');if(tab&&typeof root.MutationObserver==='function')new root.MutationObserver(run).observe(tab,{attributes:true,attributeFilter:['class']});
    root.setInterval(run,5000);root.document.addEventListener('visibilitychange',run);root.addEventListener('focus',run);root.addEventListener('pageshow',run);run();};
    if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start,{once:true});else start();}
})(typeof window!=='undefined'?window:globalThis);
