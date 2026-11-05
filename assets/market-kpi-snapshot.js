/* Read-only, independently dated fallbacks for market KPI cards and histories. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.MarketKpiSnapshot=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const STORE='aiDashboard.marketKpiSnapshot.v1',DAY=86400000;
  const CAPS=['sh000002','sz399107','sz399102','sh000680'];
  const PE={sh000001:'000001.SH',sz399001:'399001.SZ',sz399006:'399006.SZ',sh000688:'000688.SH'};
  const URLS=['./data/market_kpis.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/market_kpis.json'];
  const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const clock=now=>{const d=new Date(now+28800000);return{date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};};
  function validDate(date,now){if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return false;const d=new Date(date+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===date&&d.getUTCDay()!==0&&d.getUTCDay()!==6&&date<=clock(now).date;}
  function validStamp(value,now){return number(value)!==null&&Number.isInteger(value)&&value>0&&value<=now+120000&&now-value<=21*DAY&&validDate(clock(value).date,now);}
  function quotes(part,kind,now){
    if(!part||!Array.isArray(part.quotes))return null;
    const rows=new Map();
    for(const q of part.quotes){
      if(!q||!validStamp(q.quoteTs,now))continue;
      const value=number(q[kind==='caps'?'totalCapYi':'pe']);
      if(kind==='caps'?!CAPS.includes(q.code)||value===null||value<100||value>3000000:!PE[q.code]||q.secucode!==PE[q.code]||value===null||value<=3||value>=2000)continue;
      const row=kind==='caps'?{code:q.code,totalCapYi:value,quoteTs:q.quoteTs}:{code:q.code,secucode:PE[q.code],pe:value,quoteTs:q.quoteTs};
      if(!rows.has(q.code)||row.quoteTs>rows.get(q.code).quoteTs)rows.set(q.code,row);
    }
    if(kind==='caps'){
      if(rows.size!==4||new Set([...rows.values()].map(q=>clock(q.quoteTs).date)).size!==1)return null;
      if(rows.get(CAPS[0]).totalCapYi<=rows.get(CAPS[3]).totalCapYi||rows.get(CAPS[1]).totalCapYi<=rows.get(CAPS[2]).totalCapYi)return null;
    }
    if(!rows.size)return null;
    return{quotes:(kind==='caps'?CAPS:Object.keys(PE)).filter(k=>rows.has(k)).map(k=>rows.get(k)),source:'腾讯财经'};
  }
  function history(part,kind,now){
    if(!part||!Array.isArray(part.series)||part.series.length<20||part.series.length>100)return null;
    let previous='';const rows=[];
    for(const raw of part.series){
      if(!raw||!validDate(raw.date,now)||raw.date<=previous)return null;
      const value=number(raw[kind==='hkAmount'?'amountYi':'balanceYi']);
      if(value===null||value<= (kind==='hkAmount'?0:100)||value>=1000000)return null;
      const row=kind==='hkAmount'?{date:raw.date,amountYi:value,status:raw.status}:{date:raw.date,balanceYi:value};
      if(kind==='hkAmount'){
        if(!['live','close'].includes(raw.status))return null;
        if(raw.asOf!=null){
          if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.asOf))return null;
          const m=+raw.asOf.slice(0,2)*60+(+raw.asOf.slice(3));
          if(m<570||raw.date===clock(now).date&&(m>clock(now).minute+1||raw.status==='close'&&m<970))return null;
          row.asOf=raw.asOf;
        }
        if(raw.date===clock(now).date&&!row.asOf)return null;
      }
      rows.push(row);previous=raw.date;
    }
    return{series:rows.slice(-60),source:kind==='hkAmount'?'腾讯财经':'东方财富'};
  }
  function validate(raw,now=Date.now()){
    if(!raw||raw.schemaVersion!==1||!Number.isFinite(now))return null;
    const result={schemaVersion:1};
    for(const kind of ['caps','pe','hkAmount','margin']){
      const part=kind==='caps'||kind==='pe'?quotes(raw[kind],kind,now):history(raw[kind],kind,now);
      if(part)result[kind]=part;
    }
    return Object.keys(result).length>1?result:null;
  }
  function merge(previous,incoming,now=Date.now()){
    const old=validate(previous,now),next=validate(incoming,now);if(!next)return old;
    const result=old?JSON.parse(JSON.stringify(old)):{schemaVersion:1};
    for(const kind of ['caps','pe','hkAmount','margin']){
      const part=next[kind];if(!part)continue;
      if(!result[kind]){result[kind]=part;continue;}
      if(kind==='caps'){
        const prior=new Map(result[kind].quotes.map(q=>[q.code,q]));
        if(part.quotes.every(q=>q.quoteTs>=prior.get(q.code).quoteTs)&&part.quotes.some(q=>q.quoteTs>prior.get(q.code).quoteTs))result[kind]=part;
      }else if(kind==='pe'){
        const rows=new Map(result[kind].quotes.map(q=>[q.code,q]));
        part.quotes.forEach(q=>{if(!rows.has(q.code)||q.quoteTs>rows.get(q.code).quoteTs)rows.set(q.code,q);});
        result[kind]={...part,quotes:[...rows.values()]};
      }else{
        const rows=new Map(result[kind].series.map(q=>[q.date,q]));
        for(const q of part.series){const prior=rows.get(q.date);
          if(!prior||kind==='hkAmount'&&prior.status!=='close'&&(q.status==='close'||(q.asOf||'')>(prior.asOf||'')))rows.set(q.date,q);
        }
        result[kind]={...part,series:[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60)};
      }
    }
    return result;
  }
  function createClient(options={}){
    const now=options.now||Date.now;let data=null,pending=null,lastAttempt=0,restored=false;
    const get=options.fetchJSON||async function(url){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),7000);try{const r=await root.fetch(url,{cache:'no-store',credentials:'omit',signal:ctrl.signal});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(timer);}};
    function restore(){if(restored)return;restored=true;try{data=validate(JSON.parse(options.storage?.getItem(STORE)||'null'),now());}catch(_){}}
    function getData(){restore();return data;}
    function apply(){restore();try{return options.apply?.(data)||0;}catch(_){return 0;}}
    function ingest(raw){restore();const next=merge(data,raw,now());if(!next||JSON.stringify(next)===JSON.stringify(data))return false;data=next;try{options.storage?.setItem(STORE,JSON.stringify(data));}catch(_){}apply();return true;}
    function refresh(force=false){
      restore();apply();if(pending)return pending;if(!force&&lastAttempt&&now()-lastAttempt<60000)return Promise.resolve(data||false);lastAttempt=now();
      const stamp=now();pending=Promise.allSettled((options.urls||URLS).map(async url=>{const raw=await get(url+'?_='+stamp);ingest(raw);})).then(()=>{apply();return data||false;}).finally(()=>{pending=null;});return pending;
    }
    return{getData,apply,refresh,ingest};
  }
  let client;function browser(){if(!client){let storage;try{storage=root.localStorage;}catch(_){}client=createClient({storage,apply:d=>typeof root._applyMarketKpiSnapshot==='function'?root._applyMarketKpiSnapshot(d):0});}return client;}
  return{STORE,CAPS,PE,URLS,clock,validate,merge,createClient,getData:()=>browser().getData(),apply:()=>browser().apply(),refresh:force=>browser().refresh(force)};
});
