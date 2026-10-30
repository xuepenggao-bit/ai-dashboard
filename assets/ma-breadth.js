/* Moving-average market breadth. Quotes are supplied by the shared full-market collector. */
(function(global){
  'use strict';
  const WINDOWS=[20,60,120],HISTORY_KEY='aiDashboard.maBreadth.v1',BASELINE_KEY='aiDashboard.maBreadthBaseline.v1';
  const HISTORY_URLS=['./data/market_ma_breadth.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/market_ma_breadth.json'];
  const BASELINE_URLS=['./data/market_ma_breadth_baseline.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/market_ma_breadth_baseline.json'];
  const METHOD='现价高于20/60/120交易日均线的股票占比 · 均线包含当日 · 前复权 · 沪深A股含ST、不含北交所 · 停牌及历史不足不计入对应窗口';
  const COLORS=['#2563eb','#d97706','#7c3aed'],DASHES=[[],[7,4],[2,4]];
  let rows=new Map(),meta={source:'腾讯财经前复权日线与盘中行情',methodology:METHOD,updatedAt:''};
  let chart=null,restored=false,historyPending=null,historyAt=0,failed=false;
  let baseline=null,baselinePending=null,baselineAt=0,adjustedDay='',adjustedCache=new Map();
  function clock(now=Date.now()){
    const d=new Date(now+8*3600000);
    return{date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};
  }
  function dateValid(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const stamp=Date.parse(value+'T00:00:00Z');
    return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value;
  }
  function minute(value){return typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):NaN;}
  function integer(value){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
  function windowsValid(value){return Array.isArray(value)&&value.length===3&&WINDOWS.every((w,i)=>value[i]===w);}
  function revision(value){const n=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(n)&&n<=Date.now()+300000?n:NaN;}
  function normalizeRow(raw,now=Date.now()){
    const c=clock(now),time=minute(raw?.asOf);
    if(!raw||!dateValid(raw.date)||raw.date>c.date||!['live','close'].includes(raw.status)||!integer(raw.universe)||!raw.universe||
      !Number.isFinite(time)||time<570||time>930||(raw.status==='close'&&time<900)||(raw.status==='live'&&time>900)||
      (raw.date===c.date&&time>c.minute+5))return null;
    const result={date:raw.date,asOf:raw.asOf,status:raw.status,universe:raw.universe,windows:{}};
    for(const w of WINDOWS){
      const v=raw.windows?.[String(w)];
      if(!v||!integer(v.above)||!integer(v.eligible)||v.eligible>raw.universe||v.above>v.eligible)return null;
      if(v.eligible===0){if(v.above!==0||v.pct!==null)return null;result.windows[w]={above:0,eligible:0,pct:null};continue;}
      if(typeof v.pct!=='number'||!Number.isFinite(v.pct)||v.pct<0||v.pct>100||Math.abs(v.pct-v.above/v.eligible*100)>.00011)return null;
      result.windows[w]={above:v.above,eligible:v.eligible,pct:v.pct};
    }
    return result;
  }
  function ordered(){return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);}
  function canReplace(previous,next,rev){
    if(!previous)return true;
    if(previous.status==='close'&&next.status!=='close')return false;
    if(previous.status==='live'&&next.status==='close')return true;
    if(next.asOf!==previous.asOf)return next.asOf>previous.asOf;
    return rev>previous._revision;
  }
  function saveHistory(){
    try{localStorage.setItem(HISTORY_KEY,JSON.stringify({schemaVersion:1,windows:WINDOWS,...meta,
      series:ordered().map(({_revision,...row})=>({...row,_cachedRevision:_revision}))}));}catch(e){}
  }
  function acceptPayload(payload,options={}){
    if(!payload||payload.schemaVersion!==1||!windowsValid(payload.windows)||!Array.isArray(payload.series)||
      typeof payload.source!=='string'||!payload.source.trim()||typeof payload.methodology!=='string'||!payload.methodology.trim())return false;
    const rev=revision(payload.updatedAt);if(!Number.isFinite(rev))return false;
    let valid=0,changed=false;
    for(const raw of payload.series){
      const row=normalizeRow(raw);if(!row)continue;valid++;
      const rowRevision=options.fromCache&&Number.isFinite(raw._cachedRevision)&&raw._cachedRevision<=Date.now()+300000?raw._cachedRevision:rev;
      if(canReplace(rows.get(row.date),row,rowRevision)){rows.set(row.date,{...row,_revision:rowRevision});changed=true;}
    }
    if(!valid)return false;
    if(changed){
      rows=new Map(ordered().map(row=>[row.date,row]));
      if(!Number.isFinite(Date.parse(meta.updatedAt))||rev>=Date.parse(meta.updatedAt))meta={source:payload.source,methodology:payload.methodology,updatedAt:payload.updatedAt};
      if(options.persist!==false)saveHistory();
    }
    failed=false;render();return true;
  }
  function restore(){
    if(restored)return;restored=true;
    try{acceptPayload(JSON.parse(localStorage.getItem(HISTORY_KEY)||'null'),{persist:false,fromCache:true});}catch(e){}
  }
  function validBaseline(data){
    if(!data||data.schemaVersion!==1||!windowsValid(data.windows)||!dateValid(data.asOfDate)||data.asOfDate>clock().date||
      !Number.isFinite(revision(data.updatedAt))||!Array.isArray(data.stocks)||!data.stocks.length)return false;
    const codes=new Set();
    return data.stocks.every(s=>{
      if(!s||typeof s.code!=='string'||!/^(sh(?:60|68)|sz(?:00|30))\d{4}$/.test(s.code)||codes.has(s.code)||
        !dateValid(s.lastDate)||s.lastDate>data.asOfDate||typeof s.close!=='number'||!Number.isFinite(s.close)||s.close<=0||!s.priorSums)return false;
      codes.add(s.code);
      return WINDOWS.every(w=>s.priorSums[w]===null||(typeof s.priorSums[w]==='number'&&Number.isFinite(s.priorSums[w])));
    });
  }
  function newerBaseline(current,next){return !current||next.asOfDate>current.asOfDate||
    (next.asOfDate===current.asOfDate&&Date.parse(next.updatedAt)>Date.parse(current.updatedAt));}
  function acceptBaseline(next,persist=true){
    if(!validBaseline(next))return false;
    if(newerBaseline(baseline,next)){
      baseline=next;
      if(persist)try{localStorage.setItem(BASELINE_KEY,JSON.stringify(next));}catch(e){}
    }
    return true;
  }
  async function fetchData(url){
    if(typeof _idxFetch==='function')return _idxFetch(url+'?_='+Date.now(),{timeout:8000,retries:0});
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);
    try{const response=await fetch(url+'?_='+Date.now(),{cache:'no-store',signal:ctrl.signal});
      if(!response.ok)throw Error('均线广度 HTTP '+response.status);return await response.json();
    }finally{clearTimeout(timer);}
  }
  async function loadBaseline(force=false){
    if(!baseline)try{acceptBaseline(JSON.parse(localStorage.getItem(BASELINE_KEY)||'null'),false);}catch(e){}
    if(!force&&baseline&&baselineAt&&Date.now()-baselineAt<300000)return baseline;
    if(baselinePending)return baselinePending;
    baselinePending=(async()=>{
      const results=await Promise.allSettled(BASELINE_URLS.map(fetchData));
      results.forEach(r=>{if(r.status==='fulfilled')acceptBaseline(r.value);});
      baselineAt=Date.now();if(!baseline)throw Error('均线广度收盘基准不可用');return baseline;
    })();
    try{return await baselinePending;}finally{baselinePending=null;}
  }
  function validateQuote(q,date){
    const time=minute(q?.time),c=clock();
    // An explicit zero-turnover quote is a suspension, not a missing quote.
    // Sources may retain its last traded date; exclude it before freshness.
    if(q?.volume===0&&dateValid(q.date)&&q.date<=date&&Number.isFinite(q.price)&&q.price>0&&
      Number.isFinite(q.previous)&&q.previous>0&&Number.isFinite(time)&&
      (q.date!==c.date||time<=c.minute+5))return;
    if(!q||q.date!==date||typeof q.price!=='number'||!Number.isFinite(q.price)||q.price<=0||
      typeof q.previous!=='number'||!Number.isFinite(q.previous)||q.previous<=0||
      typeof q.volume!=='number'||!Number.isFinite(q.volume)||q.volume<0||!Number.isFinite(time)||time<570||time>900||
      (date===c.date&&time>c.minute+5))throw Error('均线广度个股报价缺失、过期或无效');
  }
  function adjustedSums(daily,date,previousDate,stock,previousClose){
    if(!Array.isArray(daily)||!daily.length)throw Error('均线广度除权日线缺失');
    let prior=[],last='';
    for(const r of daily){
      if(!Array.isArray(r)||!dateValid(r[0])||r[0]<=last)throw Error('均线广度除权日线日期无效');
      last=r[0];if(r[0]>=date)continue;
      if(r[0]>previousDate)throw Error('均线广度除权日线交易日不一致');
      const close=Number(r[2]);if(r[2]===''||r[2]===null||r[2]===undefined||!Number.isFinite(close))throw Error('均线广度除权收盘价缺失');
      prior.push({date:r[0],close});
    }
    const final=prior[prior.length-1];
    if(!final||final.date!==stock.lastDate||Math.abs(final.close-previousClose)>.012)throw Error('均线广度除权基准仍不一致');
    const sums={};
    for(const w of WINDOWS)sums[w]=prior.length>=w-1?prior.slice(-(w-1)).reduce((sum,r)=>sum+r.close,0):null;
    return sums;
  }
  function movingAverage(priorSum,price,window){return (priorSum+price)/window;}
  async function applyLive(base,quotes,date,asOf,previousDate){
    restore();
    if(!validBaseline(base)||!dateValid(previousDate)||previousDate>=date||base.asOfDate!==previousDate||date!==clock().date)
      throw Error('均线广度必须使用上一交易日的完整基准');
    const time=minute(asOf);if(!Number.isFinite(time)||time<570||time>900||time>clock().minute+5)throw Error('均线广度观察时间无效');
    if(!quotes||typeof quotes.get!=='function')throw Error('均线广度报价集合缺失');
    const jobs=[];
    for(const stock of base.stocks){
      const q=quotes.get(stock.code);validateQuote(q,date);
      jobs.push({stock,q,sums:stock.priorSums,adjust:q.volume>0&&Math.abs(q.previous-stock.close)>.012});
    }
    if(adjustedDay!==date){adjustedDay=date;adjustedCache.clear();}
    const fixes=jobs.filter(j=>j.adjust);let cursor=0,stopped=false;
    const results=await Promise.allSettled(Array.from({length:Math.min(4,fixes.length)},async()=>{
      try{while(cursor<fixes.length&&!stopped){
        const job=fixes[cursor++],key=job.stock.code+'|'+job.q.previous+'|'+job.stock.lastDate;
        let sums=adjustedCache.get(key);
        if(!sums){
          if(!job.q.adjustedRows&&typeof _hl52Daily!=='function')throw Error('均线广度除权日线通道不可用');
          sums=adjustedSums(job.q.adjustedRows||await _hl52Daily(job.stock.code,180),date,previousDate,job.stock,job.q.previous);
          adjustedCache.set(key,sums);
        }
        job.sums=sums;
      }}catch(e){stopped=true;throw e;}
    }));
    const error=results.find(r=>r.status==='rejected');if(error)throw error.reason;
    if(clock().date!==date)throw Error('均线广度交易日已切换');
    const windows={};
    for(const w of WINDOWS){
      let above=0,eligible=0;
      for(const {q,sums} of jobs){
        if(q.volume===0||sums[w]===null)continue;
        const mean=movingAverage(sums[w],q.price,w);
        if(!Number.isFinite(mean))throw Error('均线广度均线无效');
        eligible++;if(q.price>mean)above++;
      }
      windows[w]={above,eligible,pct:eligible?Math.round(above/eligible*1000000)/10000:null};
    }
    const row={date,asOf,status:'live',universe:base.stocks.length,windows};
    return acceptPayload({schemaVersion:1,windows:WINDOWS,updatedAt:new Date().toISOString(),source:'腾讯财经前复权日线与盘中行情',methodology:METHOD,series:[row]});
  }
  function put(id,text){const el=typeof document!=='undefined'?document.getElementById(id):null;if(el)el.textContent=text;}
  function makeChart(){
    if(chart||typeof Chart!=='function'||typeof document==='undefined')return;
    const canvas=document.getElementById('cMaBreadth');if(!canvas)return;
    const guide={id:'maBreadthHalf',beforeDatasetsDraw(instance){
      const {ctx,chartArea,scales}=instance;if(!chartArea||!scales.y)return;
      const y=scales.y.getPixelForValue(50);ctx.save();ctx.setLineDash([5,5]);ctx.strokeStyle='#94a3b8';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(chartArea.left,y);ctx.lineTo(chartArea.right,y);ctx.stroke();ctx.restore();
    }};
    chart=new Chart(canvas.getContext('2d'),{type:'line',plugins:[guide],data:{labels:[],datasets:WINDOWS.map((w,i)=>({
      label:'高于'+w+'日均线',data:[],borderColor:COLORS[i],backgroundColor:COLORS[i],borderDash:DASHES[i],borderWidth:2.2,
      pointRadius:0,pointHoverRadius:4,pointBorderColor:'#fff',pointBorderWidth:1.5,tension:.16,spanGaps:false,
    }))},options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'bottom',labels:{usePointStyle:true,pointStyle:'line',color:'#475569',font:{size:12,weight:'600'},padding:22,
        generateLabels:instance=>instance.data.datasets.map((dataset,i)=>({text:dataset.label,strokeStyle:dataset.borderColor,
          fillStyle:dataset.borderColor,lineDash:dataset.borderDash,lineWidth:2.2,pointStyle:'line',hidden:!instance.isDatasetVisible(i),datasetIndex:i}))}},
        tooltip:{callbacks:{title:items=>ordered()[items[0]?.dataIndex]?.date||'',label:context=>{
          const row=ordered()[context.dataIndex],window=WINDOWS[context.datasetIndex],v=row?.windows[window];
          return context.dataset.label+': '+(v?.pct==null?'样本不足':v.pct.toFixed(2)+'% · '+v.above.toLocaleString('zh-CN')+'/'+v.eligible.toLocaleString('zh-CN')+' 家');
        },afterBody:items=>{const row=ordered()[items[0]?.dataIndex];return row?(row.status==='close'?'收盘':'盘中快照')+' '+row.asOf:'';}}}},
      scales:{x:{grid:{display:false},ticks:{color:'#64748b',font:{size:11},maxTicksLimit:12,maxRotation:0}},
        y:{min:0,max:100,grid:{color:'rgba(226,232,240,.8)'},ticks:{color:'#64748b',font:{size:11},stepSize:20,callback:value=>value+'%'}}},
    }});
  }
  function render(){
    if(typeof document==='undefined')return !!rows.size;
    const values=ordered();makeChart();if(!values.length)return false;
    const last=values[values.length-1],phase=last.status==='close'?'收盘':last.date===clock().date?'盘中快照':'历史盘中快照';
    put('maBreadthDate',last.date+' · '+phase+' '+last.asOf);
    put('maBreadthRange',values.length+'交易日 · '+values[0].date+' 至 '+last.date);
    for(const w of WINDOWS){const v=last.windows[w];put('maBreadthKpi'+w,v.pct==null?'—':v.pct.toFixed(1)+'%');
      put('maBreadthSample'+w,v.eligible?v.above.toLocaleString('zh-CN')+' / '+v.eligible.toLocaleString('zh-CN')+' 家':'暂无有效样本');}
    put('maBreadthFooter','来源：'+meta.source+' · '+meta.methodology+' · 虚线=50%参考线'+(failed?' · 本次读取未成功，保留已验证快照':''));
    if(chart){chart.data.labels=values.map(r=>r.date.slice(5));
      WINDOWS.forEach((w,i)=>{chart.data.datasets[i].data=values.map(r=>r.windows[w].pct);chart.data.datasets[i].pointRadius=values.map(r=>r.status==='live'?3.5:0);});
      chart.update('none');}
    return true;
  }
  async function refresh(force=false){
    restore();render();if(historyPending)return historyPending;
    if(!force&&historyAt&&Date.now()-historyAt<60000)return !!rows.size;
    historyAt=Date.now();
    historyPending=(async()=>{
      const results=await Promise.allSettled(HISTORY_URLS.map(async url=>{
        if(!acceptPayload(await fetchData(url)))throw Error('均线广度没有有效数据');return true;
      }));
      failed=results.every(r=>r.status==='rejected');
      if(!render()){
        put('maBreadthDate','正在获取有效历史数据');
        put('maBreadthFooter','来源：腾讯财经前复权日线 · '+METHOD+' · 缺失数据不显示为0，将自动重试');
      }
      return !failed;
    })();
    try{return await historyPending;}finally{historyPending=null;}
  }
  function visible(force=false){
    if(typeof document==='undefined'||document.hidden||!document.getElementById('t0')?.classList.contains('active'))return;
    if(chart)requestAnimationFrame(()=>chart.resize());
    refresh(force).catch(e=>console.warn('[均线广度]',e.message));
  }
  global.loadMaBreadthBaseline=loadBaseline;
  global.applyMaBreadthLiveQuotes=applyLive;
  global.refreshMaBreadth=refresh;
  global.renderMaBreadth=render;
  if(typeof module==='object'&&module.exports)module.exports={clock,dateValid,normalizeRow,validBaseline,newerBaseline,canReplace,acceptPayload,ordered,adjustedSums,movingAverage,applyLive,loadBaseline,acceptBaseline,refresh};
  if(typeof document!=='undefined'){
    const start=()=>{
      restore();render();visible(true);
      const tab=document.getElementById('t0');
      if(tab&&typeof MutationObserver==='function')new MutationObserver(()=>visible(false)).observe(tab,{attributes:true,attributeFilter:['class']});
      setInterval(()=>visible(false),60000);
      document.addEventListener('visibilitychange',()=>visible(false));
      global.addEventListener('pageshow',()=>visible(false));
      global.addEventListener('resize',()=>{if(chart&&tab?.classList.contains('active'))chart.resize();});
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
  }
})(typeof window!=='undefined'?window:globalThis);
