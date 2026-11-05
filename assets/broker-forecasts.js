/* Daily provider-extracted broker estimates. Validated means also supply the forecast PE denominator. */
(function(global){
  'use strict';
  const CACHE_MS=5*60000;
  const n=v=>v!==null&&v!==undefined&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?Number(v):null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const beijingDay=(now=Date.now())=>new Date(now+8*3600000).toISOString().slice(0,10);
  const currentYear=(now=Date.now())=>Number(beijingDay(now).slice(0,4));
  function day(v){
    const s=String(v||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
    const t=Date.parse(s+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===s?s:null;
  }
  function stamp(v){
    const s=String(v||'').trim();if(!day(s))return null;
    if(/^\d{4}-\d{2}-\d{2}$/.test(s))return Date.parse(s+'T00:00:00+08:00');
    const text=/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)?s.replace(' ','T')+'+08:00':s;
    const result=Date.parse(text);return Number.isFinite(result)?result:null;
  }
  function code(v,market){
    const s=String(v??'').trim(),length=market==='HK'?5:6;
    return /^\d+$/.test(s)&&s.length<=length?s.padStart(length,'0'):null;
  }
  function url(v){
    try{const u=new URL(String(v||''));return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname?u.href:null;}catch(_){return null;}
  }
  function resolveKey(stock,d={},ahMap=null,lookup=null){
    if(!stock)return null;
    const market=stock.mkt==='HK'?'HK':'A',stockCode=code(stock.code,market);if(!stockCode)return null;
    if(market==='A')return 'A:'+stockCode;
    const peer=code(d.aShareCode,'A');if(peer)return 'A:'+peer;
    // A complete live mapping is authoritative, including confirmed pure HK.
    if(ahMap&&typeof ahMap==='object'&&!Array.isArray(ahMap)){
      const mapped=code(ahMap[stockCode]?.aCode,'A');return mapped?'A:'+mapped:'HK:'+stockCode;
    }
    if(d.source==='HK')return 'HK:'+stockCode;
    // Daily snapshot routing lets this independent column arrive before the
    // browser's financial-data request, but never overrides a known live peer.
    const cached=lookup?.['HK:'+stockCode];
    if(typeof cached==='string'&&/^A:\d{6}$/.test(cached))return cached;
    if(cached==='HK:'+stockCode&&d.source!=='AH')return cached;
    return d.source==='AH'?null:'HK:'+stockCode;
  }
  function validSnapshot(d){
    return !!(d&&d.schemaVersion===1&&Number.isInteger(d.targetYear)&&d.targetYear>=2000&&d.targetYear<=2200&&d.stocks&&typeof d.stocks==='object'&&!Array.isArray(d.stocks));
  }
  function validateEntry(entry,key,year=currentYear(),now=Date.now()){
    const invalid=reason=>({valid:false,reason});
    if(!entry||typeof entry!=='object')return invalid('尚未取得当年券商净利润预测');
    if(!/^A:\d{6}$|^HK:\d{5}$/.test(String(key)))return invalid('证券标识待核验');
    const [market,stockCode]=key.split(':');
    if(entry.market!==market||code(entry.code,market)!==stockCode)return invalid('预测证券与当前证券不一致');
    if(entry.forecastYear!==year)return invalid('预测年份与当前年度不一致');
    if(!['ok','no_reports','source_error'].includes(entry.status))return invalid('数据状态待核验');
    if(entry.metric!=='parent_net_profit'&&!(market==='HK'&&entry.metric==='net_profit'))return invalid('预测净利润口径未核验');
    const count=n(entry.reportCount),reports=entry.reports;
    if(!Number.isInteger(count)||count<0||count>5||!Array.isArray(reports)||reports.length!==count)return invalid('机构预测样本数量不一致');
    if(count===0){
      if(n(entry.meanProfitYi)!==null||entry.meanProfitYi===0)return invalid('缺失预测不得填零');
      if(entry.status==='ok')return invalid('没有有效机构预测样本');
      return {valid:true,empty:true,status:entry.status,reports:[],count:0};
    }
    if(entry.status==='no_reports')return invalid('样本与状态不一致');
    const currency=String(entry.currency||'').toUpperCase();
    if(!['CNY','HKD','USD','EUR','GBP','JPY','SGD','TWD','AUD','CAD','CHF'].includes(currency))return invalid('预测币种未核验');
    const ids=new Set(),brokers=new Set(),checked=[];
    for(const raw of reports){
      if(!raw||typeof raw.id!=='string'||!raw.id.trim()||ids.has(raw.id.trim()))return invalid('预测标识缺失或重复');
      const value=n(raw.profitYi),link=url(raw.url),published=day(raw.publishedAt),publishedStamp=stamp(raw.publishedAt);
      if(raw.forecastYear!==year||String(raw.currency||'').toUpperCase()!==currency||value===null)return invalid('预测年份、币种或利润金额不一致');
      if(!published||published>beijingDay(now)||publishedStamp===null||publishedStamp>now+5*60000)return invalid('预测日期缺失或晚于核验时点');
      const broker=typeof raw.broker==='string'?raw.broker.trim().replace(/\s+/g,' ').toLowerCase():'';
      if(!link||!broker||brokers.has(broker))return invalid('预测来源或机构信息缺失、重复');
      // Provider detail tables legitimately share one URL across institutions.
      ids.add(raw.id.trim());brokers.add(broker);checked.push({...raw,id:raw.id.trim(),profitYi:value,url:link,currency,publishedDay:published,publishedStamp});
    }
    const mean=checked.reduce((sum,r)=>sum+r.profitYi,0)/count,supplied=n(entry.meanProfitYi);
    if(supplied===null||Math.abs(mean-supplied)>Math.max(1e-7,Math.abs(mean)*1e-9))return invalid('均值与最近机构预测样本不一致');
    checked.sort((a,b)=>b.publishedStamp-a.publishedStamp||a.id.localeCompare(b.id));
    return {valid:true,empty:false,count,reports:checked,mean,currency,status:entry.status,stale:entry.stale===true||entry.status==='source_error'};
  }
  function readForecast(stock,d,snapshot,now,ahMap){
    const year=currentYear(now),key=resolveKey(stock,d||{},ahMap,snapshot?.lookup);
    if(!key)return {year,key,status:'unresolved',reason:'等待A/H对应关系'};
    if(!validSnapshot(snapshot))return {year,key,status:'unavailable',reason:'当年券商预测待更新'};
    if(snapshot.targetYear!==year)return {year,key,status:'year_mismatch',reason:'预测年份与当前年度不一致'};
    const entry=snapshot.stocks[key],checked=validateEntry(entry,key,year,now);
    return {year,key,entry,checked,status:checked.valid?checked.status:'invalid',reason:checked.reason||
      (checked.empty?(checked.status==='source_error'?'预测源暂不可达':'暂无有效预测'):undefined)};
  }
  function estimateFromSnapshot(stock,d,snapshot,now=Date.now(),ahMap=null){
    const f=readForecast(stock,d,snapshot,now,ahMap),available=f.checked?.valid&&!f.checked.empty;
    return {profitYi:available?f.checked.mean:null,currency:available?f.checked.currency:null,
      forecastYear:f.year,key:f.key,count:available?f.checked.count:0,
      stale:available?!!f.checked.stale:!!(f.entry?.stale||f.status==='source_error'),status:f.status,
      ...(f.reason?{reason:f.reason}:{})};
  }
  const format=v=>Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  function placeholder(text,sub='',title=''){
    return '<span class="bf-empty" style="display:block;color:#8a96a6;font-size:12px;line-height:1.6"'+(title?' title="'+esc(title)+'"':'')+'>'+esc(text)+'</span>'+(sub?'<small style="display:block;font-size:10px;line-height:1.6;color:#94a3b8">'+esc(sub)+'</small>':'');
  }
  function renderCell(stock,d,snapshot,now=Date.now(),ahMap=null){
    const {year,key,entry,checked,status}=readForecast(stock,d,snapshot,now,ahMap);
    if(!key)return placeholder('等待A/H对应关系',year+'年');
    if(status==='unavailable')return placeholder('—',year+'年券商预测待更新');
    if(status==='year_mismatch')return placeholder('—',year+'年预测待更新','不使用其它年度预测冒充当年预测');
    if(!checked.valid)return placeholder('—',entry?'预测待校验':'暂无有效预测',checked.reason);
    const checkedDay=day(entry.lastChecked||snapshot.lastChecked),sourceAH=stock?.mkt==='HK'&&key.startsWith('A:');
    if(checked.empty)return placeholder(checked.status==='source_error'?'预测源暂不可达':'暂无有效预测',year+'年'+(checkedDay?' · 核验 '+checkedDay:''));
    const dates=checked.reports.map(r=>r.publishedDay),dateRange=dates.at(-1)===dates[0]?dates[0]:dates.at(-1)+'—'+dates[0];
    const stale=checked.stale?'<span class="bf-stale" style="display:block;margin-top:3px;font-size:10px;color:#a16207">上次有效缓存'+(day(entry.updatedAt)?' · '+esc(day(entry.updatedAt)):'')+'</span>':'';
    const metricLabel=entry.metric==='net_profit'?'纯利/亏损（来源口径）':'归母净利润';
    const meta=year+' · '+checked.currency+' · '+checked.count+'家'+(sourceAH?' · A股'+key.slice(2):'');
    const latest='<small class="bf-latest" style="display:block;font-size:10px;color:#8493a2" title="数据商标注的最新预测日期'+(checkedDay?'；后台核验 '+esc(checkedDay):'')+'">最新预测 '+esc(dates[0])+'</small>';
    const details=checked.reports.map(r=>{
      const updated=(r.dateType||r.publishedAtType)==='provider_updated_at',dateLabel=updated?'预测更新日':'预测/报告日期',period=year+(r.periodBasis==='fiscal_year_as_labelled'?'财年（来源口径）':'年');
      return '<li style="margin:8px 0;padding:0;list-style:none;border-top:1px solid #e2e8f0;padding-top:7px"><div style="display:flex;justify-content:space-between;gap:9px;font-size:11px;color:#475569"><b>'+esc(r.broker)+'</b><span title="'+dateLabel+'：数据商标注，不等于后台抓取日期">'+esc(r.publishedDay)+'</span></div><div style="font-size:11px;font-variant-numeric:tabular-nums;color:#166e68;margin-top:2px">'+format(r.profitYi)+' 亿元 · '+esc(checked.currency)+' · '+esc(period)+'</div><a href="'+esc(r.url)+'" target="_blank" rel="noopener noreferrer" style="display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;font-size:10px;color:#47799c;text-decoration:none" title="'+esc(r.title||'查看预测明细来源')+'">'+esc(r.title||'查看预测明细来源')+' ↗</a></li>';
    }).join('');
    return '<div class="bf-cell" style="min-width:154px;max-width:300px;line-height:1.55;text-align:right"><strong style="font-size:14px;font-weight:700;color:#166e68;font-variant-numeric:tabular-nums" title="最近'+checked.count+'家机构各自最新有效年度净利润预测的算术平均；A股归母，港股按来源纯利/亏损；作为预测PE分母，左侧机械预测仅作对照">'+format(checked.mean)+'</strong><small style="display:block;font-size:10px;color:#748397">'+esc(meta)+'</small>'+latest+stale+'<details class="bf-reports" data-bf-key="'+esc(key)+'" style="margin-top:3px;text-align:left"><summary style="cursor:pointer;font-size:10px;color:#64849c;text-align:right;list-style-position:inside" title="'+esc(dateRange)+'">预测明细 · '+checked.count+'家</summary><div style="padding:7px 9px;margin-top:6px;border:1px solid #d9e6e9;border-radius:7px;background:#f8fbfc"><div style="font-size:10px;color:#7a8d9b">数据商摘录的机构预测明细，非逐份原始PDF核验</div><div style="margin-top:3px;font-size:10px;color:#7a8d9b">'+esc(metricLabel)+'，非扣非机械估算；单位：亿元</div><ul style="margin:0;padding:0">'+details+'</ul></div></details></div>';
  }
  let data=null,inflight=null,lastAttempt=0;
  function runtimeMap(){try{if(typeof _VAL_AH_MAP!=='undefined')return _VAL_AH_MAP;}catch(_){}return global._VAL_AH_MAP||null;}
  function cell(stock,d){return renderCell(stock,d,data,Date.now(),runtimeMap());}
  function estimate(stock,d){return estimateFromSnapshot(stock,d,data,Date.now(),runtimeMap());}
  function redraw(){
    if(typeof document==='undefined')return;
    const opened=new Set([...document.querySelectorAll('#tVal details.bf-reports[open]')].map(e=>e.getAttribute('data-bf-key')));
    try{if(typeof global.renderValTable==='function')global.renderValTable();else if(typeof renderValTable==='function')renderValTable();}catch(e){if(global.console)console.warn('[券商预测显示]',e.message);}
    document.querySelectorAll('#tVal details.bf-reports').forEach(e=>{if(opened.has(e.getAttribute('data-bf-key')))e.open=true;});
  }
  async function refresh(force=false){
    if(inflight||(!force&&Date.now()-lastAttempt<CACHE_MS))return inflight;
    lastAttempt=Date.now();
    const task=(async()=>{
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
      try{
        const r=await fetch('data/broker_profit_forecasts.json?_='+Date.now(),{cache:'no-store',signal:ctrl.signal});
        if(!r.ok)throw Error('HTTP '+r.status);const next=await r.json();if(!validSnapshot(next))throw Error('预测快照结构无效');
        const nextTime=stamp(next.generatedAt||next.lastChecked),oldTime=stamp(data?.generatedAt||data?.lastChecked);
        if(data&&(next.targetYear<data.targetYear||next.targetYear===data.targetYear&&nextTime!==null&&oldTime!==null&&nextTime<oldTime))return;
        data=next;redraw();
      }catch(e){if(global.console)console.warn('[券商预测快照]',e.message);}finally{clearTimeout(timer);}
    })();inflight=task.finally(()=>{inflight=null;});return inflight;
  }
  const api={refresh,cell,estimate,estimateFromSnapshot,getData:()=>data,resolveKey,renderCell,validateEntry,validSnapshot,currentYear};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.BrokerForecasts=api;
  if(typeof document==='undefined')return;
  const tab=document.getElementById('tVal');if(!tab)return;
  const visible=()=>tab.classList.contains('active')&&!document.hidden;
  new MutationObserver(()=>{if(visible())refresh();}).observe(tab,{attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange',()=>{if(visible())refresh();});
  setInterval(()=>{if(visible())refresh();},CACHE_MS);
  if(visible())refresh();
})(typeof window==='undefined'?globalThis:window);
