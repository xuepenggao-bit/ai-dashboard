/* Portfolio-only minute curves. Independent of the price/market-panel refresh paths. */
(function(root,factory){
  const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.PortfolioSparklines=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const STORE='aiDashboard.portfolioSparklines.v1',REFRESH_MS=60000,MAX_ROWS=80;
  const keyValid=k=>/^(?:sh|sz)\d{6}$|^hk\d{5}$/.test(k||'');
  const finite=v=>v==null||String(v).trim()===''?NaN:Number(v);
  function keyForStock(stock){
    const market=String(stock?.mkt||'').toLowerCase(),code=String(stock?.code||'');
    const key=market+code;return keyValid(key)?key:null;
  }
  function clock(now=Date.now()){const d=new Date(now+28800000);return{date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};}
  function dateValid(date){return /^\d{4}-\d{2}-\d{2}$/.test(date||'')&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;}
  function minute(time){return /^(?:[01]\d|2[0-3])[0-5]\d$/.test(time||'')?Number(time.slice(0,2))*60+Number(time.slice(2)):NaN;}
  function inSession(key,time){const m=minute(time);return m>=570&&m<=(key.startsWith('hk')?720:690)||m>=780&&m<=(key.startsWith('hk')?970:900);}
  function validate(raw,now=Date.now()){
    if(!raw||!keyValid(raw.key)||!dateValid(raw.date)||raw.date>clock(now).date||
      now-Date.parse(raw.date+'T00:00:00+08:00')>21*86400000||!(raw.previousClose>0)||!Number.isFinite(raw.previousClose)||
      !Array.isArray(raw.points)||!raw.points.length||raw.points.length>400)return null;
    const c=clock(now),points=[];let last='';
    for(const p of raw.points){
      if(!p||!inSession(raw.key,p.time)||p.time<=last||!(p.price>0)||!Number.isFinite(p.price)||
        p.price/raw.previousClose>100||raw.date===c.date&&minute(p.time)>c.minute+1)return null;
      last=p.time;points.push({time:p.time,price:p.price});
    }
    const t=points[points.length-1].time;
    const quoteTimestamp=Date.parse(raw.date+'T'+t.slice(0,2)+':'+t.slice(2)+':00+08:00');
    return{key:raw.key,date:raw.date,previousClose:raw.previousClose,points,quoteTimestamp,
      source:['腾讯财经','东方财富'].includes(raw.source)?raw.source:'已验证分时缓存'};
  }
  function build(key,date,previousClose,points,source,now){
    const seen=new Map();
    if(!Array.isArray(points))throw Error('分钟数据缺失');
    for(const p of points){if(!inSession(key,p.time))continue;if(seen.has(p.time))throw Error('重复分钟');seen.set(p.time,p);}
    const row=validate({key,date,previousClose,points:[...seen.values()].sort((a,b)=>a.time.localeCompare(b.time)),source},now);
    if(!row)throw Error('个股分钟数据校验失败');return row;
  }
  function parseTencent(payload,key,now=Date.now()){
    const node=payload?.data?.[key],day=node?.data,qt=node?.qt?.[key];
    if(payload?.code!==0||!day||!Array.isArray(qt)||String(qt[2])!==key.slice(2))throw Error('腾讯证券不匹配');
    // HK uses "YYYY/MM/DD HH:mm:ss" while A quotes use YYYYMMDDHHmmss.
    const date=String(day.date||''),stamp=String(qt[30]||'').replace(/\D/g,'');
    if(!/^\d{8}$/.test(date)||!/^\d{14}$/.test(stamp)||stamp.slice(0,8)!==date)throw Error('腾讯日期不匹配');
    const iso=date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6);
    const sourceTs=Date.parse(iso+'T'+stamp.slice(8,10)+':'+stamp.slice(10,12)+':'+stamp.slice(12,14)+'+08:00');
    if(!Number.isFinite(sourceTs)||sourceTs>now+60000)throw Error('腾讯行情时间无效');
    const points=Array.isArray(day.data)?day.data.map(row=>{const p=String(row).trim().split(/\s+/);return{time:p[0],price:finite(p[1])};}):null;
    const row=build(key,iso,finite(qt[4]),points,'腾讯财经',now);
    if(row.quoteTimestamp>sourceTs+60000)throw Error('腾讯分钟晚于行情');return row;
  }
  function parseEastmoney(payload,key,now=Date.now()){
    const d=payload?.data,market=key.startsWith('hk')?116:key.startsWith('sh')?1:0;
    if(payload?.rc!==0||String(d?.code)!==key.slice(2)||Number(d.market)!==market||!Array.isArray(d.trends))throw Error('东方财富证券不匹配');
    let date='';
    const points=d.trends.map(row=>{
      const p=String(row).split(','),m=p[0].match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/);
      if(!m||date&&date!==m[1])throw Error('东方财富分钟日期不匹配');date=m[1];
      return{time:m[2]+m[3],price:finite(p[2])};
    });
    return build(key,date,finite(d.preClose),points,'东方财富',now);
  }
  function newer(old,row){
    if(!old)return true;if(row.date!==old.date)return row.date>old.date;
    const a=old.points[old.points.length-1],b=row.points[row.points.length-1];
    return b.time>a.time||b.time===a.time&&row.points.length>=old.points.length;
  }
  function marketState(key,now=Date.now()){
    return root.PortfolioMarketSession?.marketState(key.startsWith('hk')?'HK':'A',now)||
      {date:clock(now).date,phase:'unknown',calendarKnown:false};
  }
  function display(row,state={},now=Date.now()){
    if(state.isClosed||state.status==='market_closed')return{row:null,status:'market_closed',label:'休市'};
    if(state.status==='suspended')return{row:null,status:'suspended',label:'停牌'};
    if(['before_open','preopen','auction'].includes(state.phase)||state.status==='preopen')return{row:null,status:'preopen',label:'未开盘'};
    if(state.status==='no_trade')return{row:null,status:'missing',label:'尚未成交'};
    if(state.calendarKnown===false)return{row:null,status:'missing',label:'交易日历待确认'};
    if(!row)return{row:null,status:'missing',label:'分时待更新'};
    const c=clock(now),t=row.points[row.points.length-1].time,m=minute(t),hm=t.slice(0,2)+':'+t.slice(2);
    if(row.date!==c.date)return{row,status:'stale',label:row.date.slice(5)+' · 上次行情'};
    const target=state.phase==='lunch'?(row.key.startsWith('hk')?720:690):state.phase==='after_close'?(row.key.startsWith('hk')?(state.continuousCloseMinute||(state.closeMinute||970)-10):900):Math.min(c.minute,row.key.startsWith('hk')?970:900);
    return m<target-5?{row,status:'stale',label:hm+' · 截至'}:{row,status:'ready',label:''};
  }
  function complete(row,state,now){
    if(!row||row.date!==clock(now).date)return false;
    const last=minute(row.points[row.points.length-1].time);
    if(state.phase==='lunch')return last>=(row.key.startsWith('hk')?720:690);
    if(state.phase==='after_close')return last>=(row.key.startsWith('hk')?(state.continuousCloseMinute||(state.closeMinute||970)-10):900);
    return false;
  }
  function freshEnough(row,now=Date.now()){
    const c=clock(now),hk=row.key.startsWith('hk'),morning=hk?720:690,close=hk?960:900;
    if(row.date!==c.date)return false;
    const target=c.minute>=morning&&c.minute<780?morning:Math.min(c.minute,close);
    return minute(row.points[row.points.length-1].time)>=target-3;
  }
  function createClient(options={}){
    const now=options.now||Date.now,rows=new Map(),pending=new Map(),attempts=new Map(),checked=new Map(),queue=[];
    let running=0,restored=false,saveTimer=null;
    const get=options.fetchJSON||async function(url){
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),3500);
      try{const r=await root.fetch(url,{cache:'no-store',credentials:'omit',signal:ctrl.signal});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(timer);}
    };
    function accept(raw){const row=validate(raw,now());if(!row||!newer(rows.get(row.key),row))return false;rows.set(row.key,row);return true;}
    function restore(){if(restored)return;restored=true;try{const p=JSON.parse(options.storage?.getItem(STORE)||'null');if(p?.schemaVersion===1&&Array.isArray(p.series))p.series.slice(0,MAX_ROWS).forEach(accept);}catch(_){}}
    function snapshot(){return{schemaVersion:1,series:[...rows.values()].sort((a,b)=>b.quoteTimestamp-a.quoteTimestamp).slice(0,MAX_ROWS)};}
    function save(){try{options.storage?.setItem(STORE,JSON.stringify(snapshot()));}catch(_){}}
    function persist(){if(!options.storage||saveTimer!=null)return;saveTimer=setTimeout(()=>{saveTimer=null;save();},500);}
    function read(key){restore();return rows.get(key)||null;}
    async function fetchOne(key){
      if(!keyValid(key))throw Error('证券代码无效');
      const secid=(key.startsWith('hk')?'116.':key.startsWith('sh')?'1.':'0.')+key.slice(2),stamp=now();
      const em='https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid='+secid+
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&iscca=0&_='+stamp;
      const tx='https://web.ifzq.gtimg.cn/appstock/app/minute/query?code='+key+'&_='+stamp;
      const providers=key.startsWith('hk')?[[em,parseEastmoney],[tx,parseTencent]]:[[tx,parseTencent],[em,parseEastmoney]];
      let best=null,error;
      for(const [url,parse]of providers){
        try{const row=parse(await get(url),key,now());if(newer(best,row))best=row;
          // A current-session curve takes priority; an old-session response must
          // not stop the fallback from supplying today's curve.
          if(freshEnough(row,now()))return row;
        }catch(e){error=e;}
      }
      if(options.jsonp)try{const row=parseEastmoney(await options.jsonp(em),key,now());if(newer(best,row))best=row;}catch(e){error=e;}
      if(best)return best;throw error||Error('分时源不可达');
    }
    function drain(){while(running<3&&queue.length){const job=queue.shift();running++;
      Promise.resolve().then(async()=>{
        if(job.allowed&&!job.allowed())return read(job.key);
        attempts.set(job.key,now());
        try{const row=await fetchOne(job.key);if(accept(row)){checked.set(job.key,now());persist();options.onUpdate?.(job.key);}return read(job.key);}
        catch(_){return read(job.key);}
      }).then(job.resolve,job.reject).finally(()=>{pending.delete(job.key);running--;drain();});
    }}
    function refresh(key,state={},allowed){
      restore();if(!keyValid(key))return Promise.resolve(null);
      const shown=display(read(key),state,now());
      const closeTime=Date.parse(clock(now()).date+'T00:00:00+08:00')+(state.closeMinute|| (key.startsWith('hk')?970:900))*60000;
      const settled=complete(read(key),state,now())&&(state.phase!=='after_close'||(checked.get(key)||0)>=closeTime);
      if(['market_closed','suspended','preopen'].includes(shown.status)||state.status==='no_trade'||state.calendarKnown===false||settled)return Promise.resolve(read(key));
      if(pending.has(key))return pending.get(key);
      const last=attempts.get(key);if(last!=null&&now()-last<REFRESH_MS)return Promise.resolve(read(key));
      const promise=new Promise((resolve,reject)=>queue.push({key,resolve,reject,allowed}));pending.set(key,promise);drain();return promise;
    }
    return{read,refresh,fetchOne,accept,snapshot,save,isPending:key=>pending.has(key)};
  }
  let client,observer,tabObserver,rosterObserver,slots=[],visibleSlots=new Set(),visibleKeys=new Set(),scheduled=false,started=false;
  function active(){return !!root.document&&!root.document.hidden&&root.document.getElementById('tPort')?.classList.contains('active');}
  function browser(){if(!client){let storage;try{storage=root.localStorage;}catch(_){}
    client=createClient({storage,onUpdate:paintKey,jsonp:url=>typeof root._idxJsonp==='function'?root._idxJsonp(url,3500):Promise.reject(Error('JSONP unavailable'))});}return client;}
  function slotState(el){const state=marketState(el.dataset.sparkKey);return{...state,status:['market_closed','suspended','preopen','no_trade'].includes(el.dataset.sparkStatus)?el.dataset.sparkStatus:state.status};}
  function paint(el){
    if(!root.PortfolioSparklineView)return;
    const key=el.dataset.sparkKey,data=browser().read(key),state=slotState(el),d=display(data,state),status=!data&&d.status==='missing'&&browser().isPending(key)?'loading':d.status;
    const html=root.PortfolioSparklineView.render(d.row,{name:el.dataset.sparkName||key,mkt:el.dataset.sparkMarket,status,label:status==='loading'?'加载分时…':d.label});
    if(el.innerHTML!==html)el.innerHTML=html;
  }
  function paintKey(key){slots.filter(el=>el.dataset.sparkKey===key&&el.isConnected).forEach(paint);}
  function tick(){
    scheduled=false;if(!active())return;
    const used=new Set();for(const el of slots){const key=el.dataset.sparkKey;if(!el.isConnected||!visibleKeys.has(key)||used.has(key))continue;used.add(key);
      const task=browser().refresh(key,slotState(el),()=>active()&&visibleKeys.has(key));paintKey(key);task.then(()=>paintKey(key));
    }
  }
  function schedule(){if(scheduled)return;scheduled=true;setTimeout(tick,350);}
  function mount(){
    if(!root.document)return;const elements=[...root.document.querySelectorAll('#portSectors [data-spark-key]')];
    slots=elements;visibleSlots=new Set();visibleKeys=new Set();if(observer)observer.disconnect();
    for(const el of slots){paint(el);if(observer)observer.observe(el);else visibleKeys.add(el.dataset.sparkKey);}
    schedule();
  }
  function start(){
    if(started||!root.document)return;started=true;
    if(root.IntersectionObserver)observer=new root.IntersectionObserver(entries=>{
      for(const entry of entries){if(!slots.includes(entry.target))continue;if(entry.isIntersecting)visibleSlots.add(entry.target);else visibleSlots.delete(entry.target);}
      visibleKeys=new Set([...visibleSlots].map(el=>el.dataset.sparkKey));
      schedule();
    },{rootMargin:'200px 80px'});
    const host=root.document.getElementById('portSectors'),tab=root.document.getElementById('tPort');
    // Observe only the roster container, not SVG changes inside each cell.
    if(host&&root.MutationObserver){rosterObserver=new root.MutationObserver(mount);rosterObserver.observe(host,{childList:true});}
    if(tab&&root.MutationObserver){tabObserver=new root.MutationObserver(()=>{if(active())mount();});tabObserver.observe(tab,{attributes:true,attributeFilter:['class']});}
    root.document.addEventListener('visibilitychange',()=>{if(active())mount();});
    root.addEventListener?.('pageshow',()=>{if(active())mount();});
    setInterval(()=>{if(active()){slots.forEach(paint);schedule();}},REFRESH_MS);mount();
  }
  if(root.document){if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start);else setTimeout(start,0);}
  return{STORE,REFRESH_MS,keyForStock,clock,minute,inSession,validate,parseTencent,parseEastmoney,newer,display,complete,freshEnough,createClient,mount};
});
