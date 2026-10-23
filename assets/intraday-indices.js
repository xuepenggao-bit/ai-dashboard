/* Shared, validated minute curves for market style and sector rotation. */
(function(root,factory){
  const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.IntradayIndices=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const GROUPS={style:['sz399372','sz399374','sz399376','sz399373','sz399375','sz399377'],rotation:['sh000993','sz980027','sz399441','sz399364','sz399321','sz399402']};
  const KEYS=Object.values(GROUPS).flat(),STORE='aiDashboard.intradayIndices.v1';
  const SNAPSHOTS=['./data/intraday_indices.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/intraday_indices.json'];
  function clock(now=Date.now()){const d=new Date(now+28800000);return{date:d.toISOString().slice(0,10).replace(/-/g,''),minute:d.getUTCHours()*60+d.getUTCMinutes()};}
  function dateValid(s){if(!/^\d{8}$/.test(s||''))return false;const iso=s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6),stamp=Date.parse(iso+'T00:00:00Z');return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===iso;}
  function minute(s){if(!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(s||''))return NaN;return +s.slice(0,2)*60+(+s.slice(2));}
  function session(s){const m=minute(s);return m>=570&&m<=690||m>=780&&m<=900;}
  function valid(raw,now=Date.now()){
    if(!raw||!KEYS.includes(raw.key)||!dateValid(raw.date)||raw.date>clock(now).date||!Number.isFinite(raw.previousClose)||raw.previousClose<=0||!Array.isArray(raw.points)||!raw.points.length||raw.points.length>242)return null;
    const today=clock(now),points=[];let last='';
    for(const p of raw.points){if(!p||!session(p.time)||p.time<=last||!Number.isFinite(p.price)||p.price<=0||!Number.isFinite(p.pct)||Math.abs(p.pct-(p.price/raw.previousClose-1)*100)>.00001||Math.abs(p.pct)>50||raw.date===today.date&&minute(p.time)>today.minute+1)return null;last=p.time;points.push({time:p.time,price:p.price,pct:p.pct});}
    const iso=raw.date.slice(0,4)+'-'+raw.date.slice(4,6)+'-'+raw.date.slice(6),t=points.at(-1).time;
    const quoteTimestamp=raw.quoteTimestamp??Date.parse(iso+'T'+t.slice(0,2)+':'+t.slice(2)+':00+08:00');
    if(!Number.isFinite(quoteTimestamp)||quoteTimestamp>now+60000||clock(quoteTimestamp).date!==raw.date)return null;
    return{key:raw.key,code:raw.key.slice(2),date:raw.date,previousClose:raw.previousClose,points,quoteTimestamp,source:['腾讯财经','东方财富'].includes(raw.source)?raw.source:'已验证行情快照'};
  }
  function build(key,date,previousClose,raw,source,now,quoteTimestamp){
    if(!Array.isArray(raw))throw Error('分钟数据缺失');const seen=new Map();
    for(const p of raw){if(!session(p.time))continue;if(!Number.isFinite(p.price)||p.price<=0)throw Error('分钟价格无效');if(seen.has(p.time))throw Error('重复分钟');seen.set(p.time,{...p,pct:(p.price/previousClose-1)*100});}
    const row=valid({key,date,previousClose,points:[...seen.values()].sort((a,b)=>a.time.localeCompare(b.time)),source,quoteTimestamp},now);if(!row)throw Error('分钟行情校验失败');return row;
  }
  function parseTencent(payload,key,now=Date.now()){
    const node=payload?.data?.[key],day=node?.data,qt=node?.qt?.[key];
    if(payload?.code!==0||!day||!Array.isArray(qt)||qt[2]!==key.slice(2)||String(qt[30]||'').slice(0,8)!==day.date)throw Error('腾讯分钟与昨收日期不匹配');
    const stamp=String(qt[30]);if(!/^\d{14}$/.test(stamp))throw Error('腾讯行情时间无效');
    const quoteTimestamp=Date.parse(stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8)+'T'+stamp.slice(8,10)+':'+stamp.slice(10,12)+':'+stamp.slice(12)+'+08:00');
    return build(key,day.date,Number(qt[4]),Array.isArray(day.data)?day.data.map(row=>{const p=String(row).trim().split(/\s+/);return{time:p[0],price:Number(p[1])};}):null,'腾讯财经',now,quoteTimestamp);
  }
  function parseEastmoney(payload,key,now=Date.now()){
    const d=payload?.data;if(payload?.rc!==0||d?.code!==key.slice(2)||d.market!==(key.startsWith('sh')?1:0)||!Array.isArray(d.trends)||!d.trends.length)throw Error('东方财富指数不匹配');
    let date='';const points=d.trends.map(row=>{const p=String(row).split(','),match=p[0].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);if(!match)throw Error('分钟日期无效');const day=match[1]+match[2]+match[3];if(date&&date!==day)throw Error('混合交易日');date=day;return{time:match[4]+match[5],price:Number(p[2])};});
    return build(key,date,Number(d.preClose),points,'东方财富',now,Number.isFinite(d.time)?d.time*1000:undefined);
  }
  function newer(old,row){return !old||row.date>old.date||row.date===old.date&&(row.points.at(-1).time>old.points.at(-1).time||row.points.at(-1).time===old.points.at(-1).time&&row.points.length>=old.points.length&&row.quoteTimestamp>=old.quoteTimestamp);}
  function createClient(options={}){
    const now=options.now||Date.now,storage=options.storage,rows=new Map(),pending={},attempts={};let snapshotPending=null,snapshotAttempt=0,restored=false,running=0;const queue=[];
    const get=options.fetchJSON||async function(url){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),5000);try{const r=await root.fetch(url,{cache:'no-store',signal:ctrl.signal});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(timer);}};
    function accept(raw){let row;try{row=valid(raw,now());}catch(_){return false;}if(!row||!newer(rows.get(row.key),row))return false;rows.set(row.key,row);return true;}
    function ingest(payload){if(payload?.schemaVersion!==1||!Array.isArray(payload.series))return false;let changed=false;for(const row of payload.series)changed=accept(row)||changed;return changed;}
    function payload(){return{schemaVersion:1,updatedAt:new Date(now()).toISOString(),series:[...rows.values()]};}
    function save(){try{storage?.setItem(STORE,JSON.stringify(payload()));}catch(_){}}
    function restore(){if(restored)return;restored=true;try{ingest(JSON.parse(storage?.getItem(STORE)||'null'));}catch(_){}}
    function group(name){restore();const all=(GROUPS[name]||[]).map(k=>rows.get(k)).filter(Boolean),date=all.map(r=>r.date).sort().pop();const series=all.filter(r=>r.date===date);return series.length?{date,series,partial:series.length<GROUPS[name].length}:null;}
    function limited(task){return new Promise((resolve,reject)=>{queue.push({task,resolve,reject});drain();});}
    function drain(){while(running<4&&queue.length){const job=queue.shift();running++;Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{running--;drain();});}}
    async function fetchOne(key){
      let first;try{return parseTencent(await get('https://ifzq.gtimg.cn/appstock/app/minute/query?code='+key+'&_='+now()),key,now());}catch(e){first=e;}
      const url='https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid='+(key.startsWith('sh')?'1.':'0.')+key.slice(2)+'&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&iscca=0&_='+now();
      try{return parseEastmoney(await get(url),key,now());}catch(e){if(options.jsonp)return parseEastmoney(await options.jsonp(url),key,now());throw Error(key+': '+first.message+' / '+e.message);}
    }
    async function snapshots(){
      if(options.snapshots===false)return false;if(snapshotPending)return snapshotPending;if(snapshotAttempt&&now()-snapshotAttempt<300000)return false;snapshotAttempt=now();
      snapshotPending=Promise.allSettled(SNAPSHOTS.map(async u=>{const changed=ingest(await get(u+'?_='+now()));if(changed)save();return changed;}));try{return await snapshotPending;}finally{snapshotPending=null;}
    }
    function refresh(name,onUpdate=()=>{},force=false){
      restore();onUpdate(group(name));if(pending[name])return pending[name];if(!force&&attempts[name]&&now()-attempts[name]<60000)return Promise.resolve(group(name));attempts[name]=now();
      pending[name]=(async()=>{const backup=snapshots().then(()=>onUpdate(group(name)));const jobs=GROUPS[name].map(key=>limited(async()=>{const row=await fetchOne(key);if(accept(row)){save();onUpdate(group(name));}}));await Promise.allSettled([...jobs,backup]);const result=group(name);onUpdate(result);return result;})().finally(()=>{delete pending[name];});return pending[name];
    }
    return{refresh,group,ingest,payload,fetchOne};
  }
  let client;
  function browser(){if(!client){let storage;try{storage=root.localStorage;}catch(_){}client=createClient({storage,fetchJSON:(url)=>root._idxFetch(url,{timeout:4500,retries:0}),jsonp:(url)=>root._idxJsonp(url,4000)});}return client;}
  function label(data,now=Date.now()){
    if(!data?.series?.length)return'';const times=data.series.map(s=>s.points.at(-1).time).sort(),c=clock(now);const t=times[0],time=t.slice(0,2)+':'+t.slice(2),date=data.date.slice(4,6)+'-'+data.date.slice(6);
    let phase=data.date<c.date?'上次行情':t==='1500'?'收盘':c.minute>=690&&c.minute<780&&t>='1130'?'午间休市':'行情';
    if(data.date===c.date&&minute(t)<Math.min(c.minute>=690&&c.minute<780?690:c.minute,900)-5)phase='部分延迟';
    return date+' '+time+' · '+phase+(data.partial?' · '+data.series.length+'/6':'');
  }
  return{GROUPS,KEYS,clock,valid,parseTencent,parseEastmoney,newer,createClient,browser,label};
});
