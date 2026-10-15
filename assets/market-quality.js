/* One validated market-wide snapshot feeds median returns and concentration. */
(function(global){
  'use strict';
  const CACHE_KEY='aiDashboard.marketQuality.v1';
  const URLS=['./data/market_quality.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/market_quality.json'];
  const BASELINE_URLS=['./data/market_quality_baseline.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/market_quality_baseline.json'];
  const CODE=/^(?:sh(?:60|68)|sz(?:00|30))\d{4}$/;
  let rows=new Map(),meta=null,restored=false,pending=null,attempt=0,failed=false;
  let medianChart=null,concentrationChart=null,resizePending=false;
  let baseline=null,baselineAttempt=0,baselinePending=null;
  function finite(v){return typeof v==='number'&&Number.isFinite(v);}
  function clock(now=Date.now()){const d=new Date(now+8*3600000);return{date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};}
  function dateValid(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const t=Date.parse(v+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;}
  function minutes(v){return typeof v==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)?Number(v.slice(0,2))*60+Number(v.slice(3)):NaN;}
  function revision(v,now=Date.now()){if(typeof v!=='string'||!/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return NaN;const n=Date.parse(v);return finite(n)&&n<=now+300000?n:NaN;}
  function quantile(values,p){if(!Array.isArray(values)||!values.length||!finite(p)||p<0||p>1||values.some(v=>!finite(v)))return NaN;
    const sorted=values.slice().sort((a,b)=>a-b),index=(sorted.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);}
  function computeStatistics(stocks){
    if(!Array.isArray(stocks)||stocks.length<20||stocks.some(s=>!finite(s?.returnPct)||s.returnPct<=-100||!finite(s.amountYuan)||s.amountYuan<=0))return null;
    const returns=stocks.map(s=>s.returnPct),amounts=stocks.map(s=>s.amountYuan).sort((a,b)=>b-a),totalAmountYuan=amounts.reduce((s,v)=>s+v,0),top20AmountYuan=amounts.slice(0,20).reduce((s,v)=>s+v,0);
    if(!finite(totalAmountYuan)||!finite(top20AmountYuan))return null;
    return{eligibleCount:stocks.length,medianReturnPct:quantile(returns,.5),q25ReturnPct:quantile(returns,.25),q75ReturnPct:quantile(returns,.75),totalAmountYuan,top20AmountYuan,top20SharePct:top20AmountYuan/totalAmountYuan*100,top20Count:20};
  }
  function normalizeRow(raw,now=Date.now()){
    const c=clock(now),time=minutes(raw?.asOf),day=dateValid(raw?.date)?new Date(raw.date+'T00:00:00Z').getUTCDay():-1;
    if(!raw||!dateValid(raw.date)||raw.date>c.date||day===0||day===6||!['close','live'].includes(raw.status)||!finite(time)||time<570||time>900||
      (raw.status==='close'&&time!==900)||(raw.date===c.date&&time>c.minute)||!Number.isInteger(raw.eligibleCount)||raw.eligibleCount<20||!Number.isInteger(raw.universeCount)||raw.universeCount<4000||raw.eligibleCount>raw.universeCount||
      !finite(raw.medianReturnPct)||raw.medianReturnPct<=-100||!finite(raw.totalAmountYuan)||raw.totalAmountYuan<=0||!finite(raw.top20AmountYuan)||raw.top20AmountYuan<=0||raw.top20AmountYuan>raw.totalAmountYuan||
      raw.top20Count!==20||!finite(raw.top20SharePct)||raw.top20SharePct<=0||raw.top20SharePct>100||Math.abs(raw.top20SharePct-raw.top20AmountYuan/raw.totalAmountYuan*100)>.00011)return null;
    const hasQuartiles=finite(raw.q25ReturnPct)&&finite(raw.q75ReturnPct);
    if((raw.q25ReturnPct!=null||raw.q75ReturnPct!=null)&&!hasQuartiles)return null;
    if(hasQuartiles&&(raw.q25ReturnPct<=-100||raw.q25ReturnPct>raw.medianReturnPct||raw.q75ReturnPct<raw.medianReturnPct))return null;
    return{date:raw.date,asOf:raw.asOf,status:raw.status,eligibleCount:raw.eligibleCount,universeCount:raw.universeCount,medianReturnPct:raw.medianReturnPct,
      q25ReturnPct:hasQuartiles?raw.q25ReturnPct:null,q75ReturnPct:hasQuartiles?raw.q75ReturnPct:null,totalAmountYuan:raw.totalAmountYuan,top20AmountYuan:raw.top20AmountYuan,top20SharePct:raw.top20SharePct,top20Count:20};
  }
  function canReplace(previous,next,rev){if(!previous)return true;if(previous.status==='close'&&next.status==='live')return false;if(previous.status==='live'&&next.status==='close')return true;return next.asOf>previous.asOf||(next.asOf===previous.asOf&&rev>previous._revision);}
  function orderedRows(){return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);}
  function save(){try{localStorage.setItem(CACHE_KEY,JSON.stringify({schemaVersion:1,...meta,scope:'沪深A股',series:orderedRows().map(({_revision,...r})=>({...r,_cachedRevision:_revision}))}));}catch(e){}}
  function acceptPayload(payload,options={}){
    const rev=revision(payload?.updatedAt),published=finite(rev)?clock(rev):null;
    if(!payload||payload.schemaVersion!==1||!finite(rev)||payload.scope!=='沪深A股'||typeof payload.source!=='string'||!payload.source.trim()||typeof payload.methodology!=='string'||!payload.methodology.trim()||!Array.isArray(payload.series)||!payload.series.length)return false;
    const staged=[];let previous='';
    for(const raw of payload.series){const row=normalizeRow(raw);if(!row||row.date<=previous||row.date>published.date||(row.date===published.date&&minutes(row.asOf)>published.minute))return false;previous=row.date;
      const r=options.fromCache&&finite(raw._cachedRevision)&&raw._cachedRevision<=rev?raw._cachedRevision:rev;staged.push({...row,_revision:r});}
    let changed=false;for(const row of staged)if(canReplace(rows.get(row.date),row,row._revision)){rows.set(row.date,row);changed=true;}
    rows=new Map(orderedRows().map(r=>[r.date,r]));if(!meta||rev>=revision(meta.updatedAt))meta={updatedAt:payload.updatedAt,source:payload.source,methodology:payload.methodology};
    if(changed&&options.persist!==false)save();failed=false;render();return true;
  }
  function computeLiveQuotes(baseline,quotes,date,time,previous,now=Date.now()){
    const c=clock(now),asOf=minutes(time);
    if(!normalizeBaseline(baseline,now)||baseline.asOfDate!==previous||!dateValid(previous)||previous>=date||!dateValid(date)||date!==c.date||!finite(asOf)||asOf<570||asOf>900||asOf>c.minute||!quotes||typeof quotes.get!=='function')return null;
    const seen=new Set(),stocks=[];let earliest=time;
    for(const item of baseline.stocks){const code=typeof item==='string'?item:item?.code;if(!CODE.test(code)||seen.has(code))return null;seen.add(code);const q=quotes.get(code);
      if(!q||q.date!==date||!finite(q.price)||q.price<=0||!finite(q.previous)||q.previous<=0||!finite(q.volume)||q.volume<0||!finite(q.amountYuan)||q.amountYuan<0)return null;
      if(q.volume===0){if(q.amountYuan!==0)return null;continue;}
      const qt=minutes(q.time);if(!finite(qt)||qt<570||qt>900||qt>c.minute||q.amountYuan<=0)return null;
      const computedReturn=(q.price/q.previous-1)*100,returnPct=q.returnPct===undefined?computedReturn:q.returnPct;if(!finite(returnPct)||returnPct<=-100||Math.abs(returnPct-computedReturn)>.02)return null;
      if(q.time<earliest)earliest=q.time;stocks.push({returnPct,amountYuan:q.amountYuan});}
    const statistics=computeStatistics(stocks);if(!statistics||statistics.eligibleCount<4000)return null;
    return normalizeRow({date,asOf:earliest,status:'live',universeCount:seen.size,...statistics},now);
  }
  function applyLiveQuotes(baseline,quotes,date,time,previous){
    const row=computeLiveQuotes(baseline,quotes,date,time,previous);if(!row)return false;
    return acceptPayload({schemaVersion:1,updatedAt:new Date().toISOString(),scope:'沪深A股',source:meta?.source||'东方财富股票名单 · 腾讯财经日线与盘中行情',methodology:meta?.methodology||'有效交易个股收益中位数；成交额前20只股票成交额÷同范围总成交额',series:[row]});
  }
  function active(){return typeof document!=='undefined'&&!document.hidden&&document.getElementById('t0')?.classList.contains('active');}
  function normalizeBaseline(payload,now=Date.now()){
    const rev=revision(payload?.updatedAt,now),published=finite(rev)?clock(rev):null;
    if(!payload||payload.schemaVersion!==1||payload.scope!=='沪深A股'||!finite(rev)||!dateValid(payload.asOfDate)||payload.asOfDate>published.date||(payload.asOfDate===published.date&&published.minute<900)||!Array.isArray(payload.stocks)||payload.stocks.length<4000)return null;
    const seen=new Set(),stocks=[];for(const item of payload.stocks){if(!item||!CODE.test(item.code)||seen.has(item.code)||!dateValid(item.lastDate)||item.lastDate>payload.asOfDate||!finite(item.close)||item.close<=0)return null;seen.add(item.code);stocks.push({code:item.code,lastDate:item.lastDate,close:item.close});}
    return{schemaVersion:1,updatedAt:payload.updatedAt,asOfDate:payload.asOfDate,scope:'沪深A股',stocks};
  }
  async function loadBaseline(force=false){
    if(baselinePending)return baselinePending;if(!force&&baseline&&Date.now()-baselineAttempt<300000)return baseline;baselineAttempt=Date.now();
    baselinePending=(async()=>{const results=await Promise.allSettled(BASELINE_URLS.map(fetchData));for(const result of results){const candidate=result.status==='fulfilled'?normalizeBaseline(result.value):null;if(candidate&&(!baseline||candidate.asOfDate>baseline.asOfDate||(candidate.asOfDate===baseline.asOfDate&&revision(candidate.updatedAt)>revision(baseline.updatedAt))))baseline=candidate;}if(!baseline)throw Error('市场统计完整股票范围待更新');return baseline;})();
    try{return await baselinePending;}finally{baselinePending=null;}
  }
  function restore(){if(restored)return;restored=true;try{acceptPayload(JSON.parse(localStorage.getItem(CACHE_KEY)||'null'),{fromCache:true,persist:false});}catch(e){}}
  async function fetchData(url){const suffix=(url.includes('?')?'&':'?')+'_='+Date.now();if(typeof _idxFetch==='function')return _idxFetch(url+suffix,{timeout:8000,retries:0});
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);try{const response=await fetch(url+suffix,{cache:'no-store',signal:ctrl.signal});if(!response.ok)throw Error('市场统计 HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}}
  async function refresh(force=false){restore();render();if(!active())return false;if(pending)return pending;if(!force&&attempt&&Date.now()-attempt<300000)return!!rows.size;attempt=Date.now();
    pending=(async()=>{const results=await Promise.allSettled(URLS.map(async url=>{if(!acceptPayload(await fetchData(url)))throw Error('全市场统计未通过校验');}));failed=results.every(r=>r.status==='rejected');render();return!failed;})();try{return await pending;}finally{pending=null;}}
  function put(id,value){const el=typeof document!=='undefined'?document.getElementById(id):null;if(el)el.textContent=value;}
  function signed(value,digits=2){return finite(value)?(value>0?'+':'')+value.toFixed(digits):'—';}
  function createCharts(){
    if(typeof Chart!=='function'||typeof document==='undefined')return;
    function options(label,concentration){return{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{filter:item=>item.datasetIndex===(concentration?0:2),callbacks:{title:items=>orderedRows()[items[0]?.dataIndex]?.date||'',label:ctx=>label+'：'+(concentration?'':ctx.parsed.y>0?'+':'')+ctx.parsed.y.toFixed(2)+'%',afterBody:items=>{const row=orderedRows()[items[0]?.dataIndex];if(!row)return'';return[(row.status==='close'?'收盘':'盘中快照')+' '+row.asOf,'有效交易股票 '+row.eligibleCount.toLocaleString()+' / '+row.universeCount.toLocaleString(),concentration?'前20只 '+(row.top20AmountYuan/1e8).toFixed(2)+' 亿元 · 全市场 '+(row.totalAmountYuan/1e8).toFixed(2)+' 亿元':row.q25ReturnPct!==null?'25%—75%分位：'+signed(row.q25ReturnPct)+'% 至 '+signed(row.q75ReturnPct)+'%':''].filter(Boolean);}}}},scales:{x:{grid:{display:false},ticks:{color:'#64748b',font:{size:12},maxTicksLimit:10,maxRotation:0}},y:{...(concentration?{min:0,suggestedMax:20}:{}),grid:{color:ctx=>ctx.tick.value===0?'#94a3b8':'rgba(226,232,240,.8)'},ticks:{color:'#64748b',font:{size:12},callback:v=>v+'%'}}}};}
    const medianCanvas=document.getElementById('cMarketMedian');if(!medianChart&&medianCanvas)medianChart=new Chart(medianCanvas.getContext('2d'),{type:'line',data:{labels:[],datasets:[
      {label:'25%分位',data:[],borderWidth:0,pointRadius:0,fill:false,tension:.12},
      {label:'75%分位',data:[],borderWidth:0,pointRadius:0,fill:'-1',backgroundColor:'rgba(37,99,235,.10)',tension:.12},
      {label:'个股收益中位数',data:[],borderColor:'#2563eb',borderWidth:2.2,pointRadius:0,pointHoverRadius:4,tension:.12,spanGaps:false}]},options:options('个股收益中位数',false)});
    const concentrationCanvas=document.getElementById('cMarketConcentration');if(!concentrationChart&&concentrationCanvas)concentrationChart=new Chart(concentrationCanvas.getContext('2d'),{type:'line',data:{labels:[],datasets:[{label:'成交额前20只股票占比',data:[],borderColor:'#0f766e',backgroundColor:'rgba(15,118,110,.08)',fill:true,borderWidth:2.2,pointRadius:0,pointHoverRadius:4,tension:.12,spanGaps:false}]},options:options('成交额前20只股票占比',true)});
  }
  function render(){
    if(typeof document==='undefined')return!!rows.size;createCharts();const values=orderedRows();if(!values.length){for(const id of ['marketMedianDate','marketConcentrationDate'])put(id,failed?'本次读取未成功，将自动重试':'等待有效数据');return false;}
    const last=values[values.length-1],dateLabel=last.date+' · '+(last.status==='close'?'收盘':'盘中快照')+' '+last.asOf,range=values.length+'个交易日 · '+values[0].date+' 至 '+last.date;
    put('marketMedianDate',dateLabel);put('marketConcentrationDate',dateLabel);put('marketMedianValue',signed(last.medianReturnPct)+'%');
    const medianValue=document.getElementById('marketMedianValue');if(medianValue){medianValue.classList.toggle('quality-positive',last.medianReturnPct>0);medianValue.classList.toggle('quality-negative',last.medianReturnPct<0);}
    put('marketMedianQuartiles',last.q25ReturnPct!==null?'中间50%的股票收益：'+signed(last.q25ReturnPct)+'% 至 '+signed(last.q75ReturnPct)+'%':'按有效交易股票的当日涨跌幅排序取中位数');
    put('marketMedianCoverage','有效交易股票 '+last.eligibleCount.toLocaleString()+' / '+last.universeCount.toLocaleString()+' 只');put('marketConcentrationValue',last.top20SharePct.toFixed(2)+'%');
    put('marketConcentrationTop20','前20只成交额 '+(last.top20AmountYuan/1e8).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+' 亿元');
    put('marketConcentrationTotal','沪深 A 股成交额 '+(last.totalAmountYuan/1e8).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+' 亿元');
    put('marketMedianRange',range);put('marketConcentrationRange',range);
    const source='来源：'+(meta?.source||'市场日线与行情')+'。',failure=failed?' 本次读取未成功，保留最近有效数据。':'';
    const liveNote=last.status==='live'?' 盘中按最近完整股票名单估算，收盘后按当日股票名单校准。':'';
    put('marketMedianFooter',source+'按沪深 A 股有效交易个股的当日涨跌幅计算中位数及25%—75%分位区间，含ST，不含北交所、B股、基金及已退市证券；停牌、无成交或无有效昨收的股票不参与计算。'+liveNote+failure);
    put('marketConcentrationFooter',source+'每日按成交额重新排序取前20只，其成交额合计÷同范围有效交易股票成交额合计×100%；分子与分母使用同一股票范围和同一时点。'+liveNote+failure);
    if(medianChart){medianChart.data.labels=values.map(r=>r.date.slice(5));['q25ReturnPct','q75ReturnPct','medianReturnPct'].forEach((key,i)=>{medianChart.data.datasets[i].data=values.map(r=>r[key]);});medianChart.data.datasets[2].pointRadius=values.map(r=>r.status==='live'?3:0);medianChart.update('none');}
    if(concentrationChart){concentrationChart.data.labels=values.map(r=>r.date.slice(5));concentrationChart.data.datasets[0].data=values.map(r=>r.top20SharePct);concentrationChart.data.datasets[0].pointRadius=values.map(r=>r.status==='live'?3:0);concentrationChart.update('none');}return true;
  }
  function resize(){if(resizePending)return;resizePending=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{resizePending=false;if(active())for(const chart of [medianChart,concentrationChart])chart?.resize();}));}
  function visible(){if(!active())return;restore();render();resize();refresh(false).catch(error=>console.warn('[市场统计]',error.message));}
  global.refreshMarketQuality=refresh;global.renderMarketQuality=render;global.applyMarketQualityLiveQuotes=applyLiveQuotes;global.loadMarketQualityBaseline=loadBaseline;
  if(typeof module==='object'&&module.exports)module.exports={clock,dateValid,quantile,computeStatistics,normalizeRow,canReplace,acceptPayload,orderedRows,computeLiveQuotes,normalizeBaseline,signed};
  if(typeof document!=='undefined'){const start=()=>{restore();render();visible();const tab=document.getElementById('t0');if(tab&&typeof MutationObserver==='function')new MutationObserver(visible).observe(tab,{attributes:true,attributeFilter:['class']});setInterval(visible,60000);document.addEventListener('visibilitychange',visible);global.addEventListener('pageshow',visible);global.addEventListener('resize',resize);};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();}
})(typeof window!=='undefined'?window:globalThis);
