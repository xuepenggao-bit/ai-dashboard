/* Validated, non-regressing market risk and reported ETF share changes. */
(function(global){
  'use strict';
  const RISK_KEY='aiDashboard.marketRisk.v1',ETF_KEY='aiDashboard.etfShares.v1';
  const BASE='https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/';
  const RISK_URLS=['./data/market_risk.json',BASE+'market_risk.json'],ETF_URLS=['./data/etf_shares.json',BASE+'etf_shares.json'];
  const FUNDS=[{code:'510300',index:'沪深300',label:'华泰柏瑞沪深300 ETF',color:'#2563eb'},
    {code:'510500',index:'中证500',label:'南方中证500 ETF',color:'#7c3aed'},
    {code:'512100',index:'中证1000',label:'南方中证1000 ETF',color:'#0f766e'}];
  let riskRows=new Map(),riskBars=[],riskBarsRevision=0,riskMeta=null,etfRows=new Map(FUNDS.map(f=>[f.code,new Map()])),etfMeta=null;
  let riskVolChart=null,riskDrawChart=null,etfChart=null,restored=false,riskPending=null,etfPending=null;
  let riskAttempt=0,etfAttempt=0,liveAttempt=0,riskFailed=false,etfFailed=false,livePending=null,resizePending=false;
  function clock(now=Date.now()){const d=new Date(now+8*3600000);return{date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};}
  function dateValid(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const n=Date.parse(v+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===v;}
  function number(v){return typeof v==='number'&&Number.isFinite(v);}
  function positive(v){return number(v)&&v>0;}
  function minute(v){return typeof v==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)?+v.slice(0,2)*60+(+v.slice(3)):NaN;}
  function revision(v,now=Date.now()){const n=typeof v==='string'&&/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)?Date.parse(v):NaN;return Number.isFinite(n)&&n<=now+300000?n:NaN;}
  function cleanBars(raw){
    if(!Array.isArray(raw))return [];
    let last='';const result=[];
    for(const b of raw){if(!b||!dateValid(b.date)||b.date<=last||b.date>clock().date||[0,6].includes(new Date(b.date+'T00:00:00Z').getUTCDay())||!positive(b.close)||!positive(b.high)||!positive(b.low)||
      b.high<b.low||b.close>b.high+.001||b.close<b.low-.001||!positive(b.volume))return [];
      last=b.date;result.push({date:b.date,close:b.close,high:b.high,low:b.low,volume:b.volume});}
    return result;
  }
  function computeRisk(bars){
    const values=cleanBars(bars);if(values.length<60)return null;
    const last=values[values.length-1],closes=values.slice(-21).map(v=>v.close);
    const returns=closes.slice(1).map((v,i)=>Math.log(v/closes[i])),mean=returns.reduce((s,v)=>s+v,0)/20;
    const variance=returns.reduce((s,v)=>s+(v-mean)*(v-mean),0)/19;
    const peak60=Math.max(...values.slice(-60).map(v=>v.high));
    return{close:last.close,rv20:Math.sqrt(variance)*Math.sqrt(252)*100,peak60,drawdown60:(last.close/peak60-1)*100};
  }
  function riskRow(raw,now=Date.now()){
    const c=clock(now),time=minute(raw?.asOf);
    if(!raw||!dateValid(raw.date)||raw.date>c.date||!['live','close'].includes(raw.status)||!number(time)||time<570||time>930||
      (raw.status==='close'&&time<900)||(raw.status==='live'&&time>900)||(raw.date===c.date&&time>c.minute)||
      !positive(raw.close)||!number(raw.rv20)||raw.rv20<0||!positive(raw.peak60)||raw.peak60<raw.close-.001||
      !number(raw.drawdown60)||raw.drawdown60>0.00001||raw.drawdown60<=-100||Math.abs(raw.drawdown60-(raw.close/raw.peak60-1)*100)>.0011)return null;
    const result={date:raw.date,asOf:raw.asOf,status:raw.status,close:raw.close,rv20:raw.rv20,peak60:raw.peak60,drawdown60:Math.min(0,raw.drawdown60)};
    if(raw.status==='live'){
      if(!positive(raw.liveHigh)||!positive(raw.liveLow)||!positive(raw.liveVolume)||raw.liveHigh<raw.liveLow||raw.close>raw.liveHigh+.001||raw.close<raw.liveLow-.001||
        !number(raw.quoteTimestamp)||raw.quoteTimestamp>now||clock(raw.quoteTimestamp).date!==raw.date||clock(raw.quoteTimestamp).minute!==time||
        !dateValid(raw.previousDate)||raw.previousDate>=raw.date||!positive(raw.previousClose))return null;
      Object.assign(result,{liveHigh:raw.liveHigh,liveLow:raw.liveLow,liveVolume:raw.liveVolume,quoteTimestamp:raw.quoteTimestamp,previousDate:raw.previousDate,previousClose:raw.previousClose});
    }
    return result;
  }
  function canReplace(prev,next,rev){
    if(!prev)return true;if(prev.status==='close'&&next.status!=='close')return false;
    if(prev.status==='live'&&next.status==='close')return true;
    if(next.asOf!==prev.asOf)return next.asOf>prev.asOf;
    return rev>prev._revision;
  }
  function orderedRisk(){return [...riskRows.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);}
  function orderedEtf(code){return [...(etfRows.get(code)||new Map()).values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);}
  function safeMeta(p){return p&&p.schemaVersion===1&&typeof p.source==='string'&&p.source.trim()&&typeof p.methodology==='string'&&p.methodology.trim()&&number(revision(p.updatedAt));}
  function saveRisk(){try{localStorage.setItem(RISK_KEY,JSON.stringify({schemaVersion:1,...riskMeta,index:{code:'000985',name:'中证全指'},bars:riskBars,_barsRevision:riskBarsRevision,series:orderedRisk().map(({_revision,...r})=>({...r,_cachedRevision:_revision}))}));}catch(e){}}
  function acceptRisk(p,options={}){
    if(!safeMeta(p)||p.index?.code!=='000985'||!Array.isArray(p.series))return false;
    const rev=revision(p.updatedAt),bars=cleanBars(p.bars),published=clock(rev),atomic=!options.live&&!options.fromCache,staged=[];let changed=false;
    if(!options.live&&(bars.length<60||bars.length>200||bars.some(b=>b.date>published.date||(b.date===published.date&&published.minute<900))))return false;
    for(const raw of p.series){const row=riskRow(raw);if(!row){if(atomic)return false;continue;}
      if(row.date>published.date||(row.date===published.date&&minute(row.asOf)>published.minute)){if(atomic)return false;continue;}
      const prior=bars.filter(b=>b.date<=row.date),exact=prior[prior.length-1];let calc;
      if(row.status==='close'){
        if(exact?.date!==row.date||prior.length<60){if(atomic)return false;continue;}calc=computeRisk(prior);
      }else{
        if(!options.live&&!options.fromCache)return false;
        const closed=(options.live?riskBars:bars).filter(b=>b.date<row.date),baseline=closed[closed.length-1];
        if(baseline?.date!==row.previousDate||Math.abs(row.previousClose-baseline.close)>Math.max(.03,baseline.close*.00005))continue;
        // Cache carries the validated original quote inputs, so live points can be recomputed.
        calc=computeRisk([...closed,{date:row.date,close:row.close,high:row.liveHigh,low:row.liveLow,volume:row.liveVolume}]);
      }
      if(!calc||Math.abs(calc.close-row.close)>.00011||Math.abs(calc.rv20-row.rv20)>.00011||Math.abs(calc.peak60-row.peak60)>.00011||Math.abs(calc.drawdown60-row.drawdown60)>.00011){if(atomic)return false;continue;}
      const r=options.fromCache&&number(raw._cachedRevision)&&raw._cachedRevision<=rev?raw._cachedRevision:rev;
      staged.push({...row,_revision:r});
    }
    if(!staged.length)return false;
    // An externally fetched closed snapshot is all-or-nothing. No cache state is changed during validation.
    for(const row of staged)if(canReplace(riskRows.get(row.date),row,row._revision)){riskRows.set(row.date,row);changed=true;}
    const last=bars[bars.length-1],old=riskBars[riskBars.length-1],barRev=options.fromCache&&number(p._barsRevision)&&p._barsRevision<=rev?p._barsRevision:rev;
    if(!options.live&&last&&staged.some(r=>r.date===last.date&&r.status==='close')&&(!old||last.date>old.date||(last.date===old.date&&barRev>=riskBarsRevision))){riskBars=bars.slice(-200);riskBarsRevision=barRev;changed=true;}
    if(!riskMeta||rev>=revision(riskMeta.updatedAt))riskMeta={source:p.source,methodology:p.methodology,updatedAt:p.updatedAt};
    if(changed){riskRows=new Map(orderedRisk().map(r=>[r.date,r]));if(options.persist!==false)saveRisk();}
    riskFailed=false;renderRisk();return true;
  }
  function etfRow(raw,now=Date.now()){
    if(!raw||raw.status!=='reported'||!dateValid(raw.date)||raw.date>clock(now).date||!positive(raw.shares))return null;
    const knownChange=number(raw.deltaShares)&&number(raw.changePct)&&dateValid(raw.previousDate)&&raw.previousDate<raw.date;
    const unknownChange=raw.deltaShares===null&&raw.changePct===null&&(raw.previousDate===null||raw.previousDate===undefined||(dateValid(raw.previousDate)&&raw.previousDate<raw.date));
    if(!knownChange&&!unknownChange)return null;
    if(raw.metricStatus!==undefined&&!['baseline','daily_change','nonconsecutive','split_review'].includes(raw.metricStatus))return null;
    if(knownChange&&raw.metricStatus&&raw.metricStatus!=='daily_change')return null;
    if(unknownChange&&raw.metricStatus==='daily_change')return null;
    if(knownChange){const previous=raw.shares-raw.deltaShares;if(previous<=0||Math.abs(raw.changePct-raw.deltaShares/previous*100)>.0011)return null;}
    const navAvailable=positive(raw.nav)&&dateValid(raw.navDate)&&raw.navDate===raw.date;
    if(raw.nav!==null&&raw.nav!==undefined&&!positive(raw.nav))return null;
    if(raw.navDate!==null&&raw.navDate!==undefined&&!dateValid(raw.navDate))return null;
    let estimatedFlowYuan=null;
    if(knownChange&&navAvailable){if(!number(raw.estimatedFlowYuan)||Math.abs(raw.estimatedFlowYuan-raw.deltaShares*raw.nav)>Math.max(.02,Math.abs(raw.estimatedFlowYuan)*1e-8))return null;estimatedFlowYuan=raw.estimatedFlowYuan;}
    else if(raw.estimatedFlowYuan!==null&&raw.estimatedFlowYuan!==undefined)return null;
    return{date:raw.date,shares:raw.shares,previousDate:raw.previousDate||null,deltaShares:knownChange?raw.deltaShares:null,
      changePct:knownChange?raw.changePct:null,nav:positive(raw.nav)?raw.nav:null,navDate:raw.navDate||null,navSource:typeof raw.navSource==='string'?raw.navSource:'',
      sourceUrl:typeof raw.sourceUrl==='string'?raw.sourceUrl:'',estimatedFlowYuan,status:'reported',metricStatus:raw.metricStatus||(knownChange?'daily_change':'baseline')};
  }
  function saveEtf(){try{localStorage.setItem(ETF_KEY,JSON.stringify({schemaVersion:1,...etfMeta,coverage:'3只代表ETF，非全市场合计',funds:FUNDS.map(f=>({code:f.code,index:f.index,label:f.label,source:etfMeta?.source||'',series:orderedEtf(f.code).map(({_revision,...r})=>({...r,_cachedRevision:_revision}))}))}));}catch(e){}}
  function acceptEtf(p,options={}){
    if(!safeMeta(p)||!Array.isArray(p.funds))return false;const rev=revision(p.updatedAt);let valid=0,changed=false;
    for(const fund of p.funds){if(!FUNDS.some(f=>f.code===fund?.code)||!Array.isArray(fund.series))continue;
      const rows=etfRows.get(fund.code);
      for(const raw of fund.series){const row=etfRow(raw);if(!row)continue;
        const previous=rows.get(row.previousDate),previousRaw=fund.series.find(r=>r.date===row.previousDate);
        const priorShares=previous?.shares||(positive(previousRaw?.shares)?previousRaw.shares:null);
        if(row.deltaShares!==null&&priorShares!==null&&Math.abs(row.shares-priorShares-row.deltaShares)>Math.max(.1,row.shares*1e-9))continue;
        valid++;const r=options.fromCache&&number(raw._cachedRevision)&&raw._cachedRevision<=Date.now()+300000?raw._cachedRevision:rev;
        if(!rows.has(row.date)||r>rows.get(row.date)._revision){rows.set(row.date,{...row,_revision:r});changed=true;}
      }
      etfRows.set(fund.code,new Map(orderedEtf(fund.code).map(r=>[r.date,r])));
    }
    if(!valid)return false;if(!etfMeta||rev>=revision(etfMeta.updatedAt))etfMeta={source:p.source,methodology:p.methodology,updatedAt:p.updatedAt};
    if(changed&&options.persist!==false)saveEtf();etfFailed=false;renderEtf();return true;
  }
  function parseQuote(text){
    const match=typeof text==='string'?text.match(/v_sh000985="([^"]+)"/):null;if(!match)return null;
    const f=match[1].split('~'),stamp=f[30]||'';if(f.length<35||f[2]!=='000985'||!/^\d{14}$/.test(stamp))return null;
    const date=stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8),asOf=stamp.slice(8,10)+':'+stamp.slice(10,12),second=+stamp.slice(12);
    if(!dateValid(date)||!number(minute(asOf))||second>59)return null;
    const timestamp=Date.parse(date+'T'+asOf+':'+stamp.slice(12)+'+08:00');
    return{date,asOf,timestamp,
      price:parseFloat(f[3]),previous:parseFloat(f[4]),volume:parseFloat(f[6]),high:parseFloat(f[33]),low:parseFloat(f[34])};
  }
  function buildLive(bars,q,previousDate,now=Date.now()){
    const c=clock(now),valid=cleanBars(bars).filter(b=>b.date<c.date),base=valid[valid.length-1],time=minute(q?.asOf);
    if(!dateValid(previousDate)||previousDate>=c.date||!base||base.date!==previousDate||q?.date!==c.date||
      !number(time)||time<570||time>900||time>c.minute||!number(q.timestamp)||q.timestamp>now||clock(q.timestamp).date!==q.date||clock(q.timestamp).minute!==time||!positive(q.price)||!positive(q.previous)||!positive(q.volume)||
      !positive(q.high)||!positive(q.low)||q.high<q.low||q.price>q.high+.001||q.price<q.low-.001||
      Math.abs(q.previous-base.close)>Math.max(.03,base.close*.00005))return null;
    const all=[...valid,{date:c.date,close:q.price,high:q.high,low:q.low,volume:q.volume}],calc=computeRisk(all);
    return calc?{date:c.date,asOf:q.asOf,status:'live',...calc,liveHigh:q.high,liveLow:q.low,liveVolume:q.volume,quoteTimestamp:q.timestamp,previousDate,previousClose:q.previous}:null;
  }
  async function fetchData(url,opt={}){
    if(typeof _idxFetch==='function')return _idxFetch(url+(url.includes('?')?'&':'?')+'_='+Date.now(),{timeout:8000,retries:0,...opt});
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);
    try{const response=await fetch(url+(url.includes('?')?'&':'?')+'_='+Date.now(),{cache:'no-store',signal:ctrl.signal});
      if(!response.ok)throw Error('市场风险 HTTP '+response.status);return opt.gbk?new TextDecoder('gbk').decode(await response.arrayBuffer()):await response.json();
    }finally{clearTimeout(timer);}
  }
  async function previousTradingDate(today){
    let daily;
    if(typeof _hl52Daily==='function')daily=await _hl52Daily('sh000985',10);
    else{const p=await fetchData('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000985,day,,,10,qfq');
      if(p?.code!==0)throw Error('交易日历无效');daily=p.data?.sh000985?.qfqday||p.data?.sh000985?.day;}
    if(!Array.isArray(daily)||!daily.length)throw Error('上一交易日尚未验证');
    let last='';for(const r of daily){if(!Array.isArray(r)||!dateValid(r[0])||r[0]<=last||r[0]>today||[0,6].includes(new Date(r[0]+'T00:00:00Z').getUTCDay())||!positive(Number(r[2])))throw Error('交易日历日期无效');last=r[0];}
    const previous=daily.map(r=>r[0]).filter(d=>d<today).pop();if(!previous)throw Error('上一交易日缺失');return previous;
  }
  function active(){return typeof document!=='undefined'&&!document.hidden&&document.getElementById('t0')?.classList.contains('active');}
  async function refreshLive(force=false){
    if(!active()||livePending)return livePending;
    const c=clock();if(c.minute<570||c.minute>920||riskRows.get(c.date)?.status==='close')return false;
    if(!force&&liveAttempt&&Date.now()-liveAttempt<300000)return false;liveAttempt=Date.now();
    livePending=(async()=>{try{
      const [text,previous]=await Promise.all([fetchData('https://qt.gtimg.cn/q=sh000985',{gbk:true}),previousTradingDate(c.date)]);
      if(clock().date!==c.date)return false;
      const row=buildLive(riskBars,parseQuote(text),previous);if(!row)return false;
      return acceptRisk({schemaVersion:1,index:{code:'000985',name:'中证全指'},updatedAt:new Date().toISOString(),source:riskMeta?.source||'腾讯财经日线与盘中行情',
        methodology:riskMeta?.methodology||'20日对数收益样本标准差×√252；当前价格÷近60日最高价−1',bars:[],series:[row]},{live:true});
    }catch(e){console.warn('[市场风险盘中]',e.message);return false;}})();
    try{return await livePending;}finally{livePending=null;}
  }
  function restore(){if(restored)return;restored=true;try{acceptRisk(JSON.parse(localStorage.getItem(RISK_KEY)||'null'),{persist:false,fromCache:true});}catch(e){}
    try{acceptEtf(JSON.parse(localStorage.getItem(ETF_KEY)||'null'),{persist:false,fromCache:true});}catch(e){}}
  async function refreshRisk(force=false){
    restore();renderRisk();if(riskPending)return riskPending;if(!force&&riskAttempt&&Date.now()-riskAttempt<300000)return !!riskRows.size;
    riskAttempt=Date.now();riskPending=(async()=>{const result=await Promise.allSettled(RISK_URLS.map(async u=>{if(!acceptRisk(await fetchData(u)))throw Error('无有效风险数据');}));
      riskFailed=result.every(r=>r.status==='rejected');renderRisk();await refreshLive(force);return !riskFailed;})();
    try{return await riskPending;}finally{riskPending=null;}
  }
  async function refreshEtf(force=false){
    restore();renderEtf();if(etfPending)return etfPending;if(!force&&etfAttempt&&Date.now()-etfAttempt<1800000)return FUNDS.some(f=>orderedEtf(f.code).length);
    etfAttempt=Date.now();etfPending=(async()=>{const result=await Promise.allSettled(ETF_URLS.map(async u=>{if(!acceptEtf(await fetchData(u)))throw Error('无有效已披露份额');}));
      etfFailed=result.every(r=>r.status==='rejected');renderEtf();return !etfFailed;})();
    try{return await etfPending;}finally{etfPending=null;}
  }
  function put(id,text){const el=typeof document!=='undefined'?document.getElementById(id):null;if(el)el.textContent=text;}
  function signed(v,digits=2){return number(v)?(v>0?'+':'')+v.toFixed(digits):'—';}
  function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function createRiskCharts(){
    if(typeof Chart!=='function'||typeof document==='undefined')return;
    function create(id,key,label,color){const canvas=document.getElementById(id);if(!canvas)return null;
      return new Chart(canvas.getContext('2d'),{type:'line',data:{labels:[],datasets:[{label,data:[],borderColor:color,backgroundColor:color+'12',fill:true,borderWidth:2.2,pointRadius:0,pointHoverRadius:4,tension:.15,spanGaps:false}]},
        options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{callbacks:{title:items=>orderedRisk()[items[0]?.dataIndex]?.date||'',
          label:ctx=>label+'：'+ctx.parsed.y.toFixed(2)+'%',afterBody:items=>{const r=orderedRisk()[items[0]?.dataIndex];return r?(r.status==='close'?'收盘':'盘中快照')+' '+r.asOf+(key==='drawdown60'?' · 60日高点 '+r.peak60.toFixed(2):''):'';}}}},
        scales:{x:{grid:{display:false},ticks:{color:'#64748b',font:{size:11},maxTicksLimit:8,maxRotation:0}},y:{...(key==='rv20'?{min:0}:{max:0}),grid:{color:'rgba(226,232,240,.8)'},ticks:{color:'#64748b',font:{size:11},callback:v=>v+'%'}}}}});}
    if(!riskVolChart)riskVolChart=create('cMarketRiskVol','rv20','20日实际波动率','#2563eb');
    if(!riskDrawChart)riskDrawChart=create('cMarketRiskDrawdown','drawdown60','距60日高点回撤','#7c3aed');
  }
  function renderRisk(){
    if(typeof document==='undefined')return !!riskRows.size;createRiskCharts();const values=orderedRisk();
    if(!values.length){put('marketRiskDate',riskFailed?'本次读取未成功，将自动重试':'等待有效数据');return false;}
    const last=values[values.length-1];put('marketRiskDate',last.date+' · '+(last.status==='close'?'收盘':'盘中快照')+' '+last.asOf);
    put('marketRiskVol',last.rv20.toFixed(2)+'%');put('marketRiskDrawdown',last.drawdown60.toFixed(2)+'%');put('marketRiskPeak','近60日最高价 '+last.peak60.toFixed(2)+' · 当前指数 '+last.close.toFixed(2));
    put('marketRiskRange',values.length+'个交易日 · '+values[0].date+' 至 '+last.date);
    put('marketRiskFooter','来源：'+(riskMeta?.source||'腾讯财经')+' · 20日对数收益样本标准差（19为分母）×√252；回撤=当前指数÷近60交易日最高价−1。回撤不是区间最大回撤；盘中为估计，收盘后以完整日线为准。'+(riskFailed?' 本次读取未成功，保留已验证数据。':''));
    for(const [chart,key] of [[riskVolChart,'rv20'],[riskDrawChart,'drawdown60']]){if(!chart)continue;chart.data.labels=values.map(r=>r.date.slice(5));chart.data.datasets[0].data=values.map(r=>r[key]);chart.data.datasets[0].pointRadius=values.map(r=>r.status==='live'?3:0);chart.update('none');}
    return true;
  }
  function etfDates(){return [...new Set(FUNDS.flatMap(f=>orderedEtf(f.code).map(r=>r.date)))].sort().slice(-60);}
  function createEtfChart(){
    if(etfChart||typeof Chart!=='function'||typeof document==='undefined')return;const canvas=document.getElementById('cEtfShares');if(!canvas)return;
    etfChart=new Chart(canvas.getContext('2d'),{type:'bar',data:{labels:[],datasets:FUNDS.map(f=>({label:f.index+' · '+f.code,data:[],backgroundColor:f.color+'c8',borderColor:f.color,borderWidth:1,borderRadius:2,maxBarThickness:7}))},
      options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#475569',font:{size:12,weight:'600'},boxWidth:13,padding:20}},
        tooltip:{callbacks:{title:items=>etfDates()[items[0]?.dataIndex]||'',label:ctx=>ctx.dataset.label+'：'+signed(ctx.parsed.y,3)+' 亿份',afterBody:items=>{
          const date=etfDates()[items[0]?.dataIndex];return items.flatMap(item=>{const f=FUNDS[item.datasetIndex],r=etfRows.get(f.code)?.get(date);
            if(!r)return[];return [f.index+'：'+(r.estimatedFlowYuan===null?metricNote(r):'净申赎估算 '+signed(r.estimatedFlowYuan/1e8)+' 亿元'),
              r.estimatedFlowYuan!==null?'单位净值 '+r.nav.toFixed(4)+'（'+r.navDate+' · '+(r.navSource||'同日净值')+'）':''].filter(Boolean);});}}}},
        scales:{x:{grid:{display:false},ticks:{color:'#64748b',font:{size:11},maxTicksLimit:12,maxRotation:0}},y:{grid:{color:ctx=>ctx.tick.value===0?'#94a3b8':'rgba(226,232,240,.8)'},ticks:{color:'#64748b',font:{size:11},callback:v=>v+' 亿份'}}}}});
  }
  function metricNote(row){if(!row)return'尚未披露';if(row.metricStatus==='split_review')return'份额跳变待核实，未计算当日变化';if(row.metricStatus==='nonconsecutive')return'披露日不连续，未计算当日变化';if(row.metricStatus==='baseline')return'首个观测日，暂无可比基准';return row.estimatedFlowYuan===null?'当日单位净值未同步，申赎估算待披露':'按同日单位净值估算';}
  function renderEtf(){
    if(typeof document==='undefined')return FUNDS.some(f=>orderedEtf(f.code).length);createEtfChart();const kpis=document.getElementById('etfSharesKpis'),table=document.getElementById('etfSharesTable');
    let dates=[];const cards=[],rows=[];
    for(const fund of FUNDS){const values=orderedEtf(fund.code),last=values[values.length-1];if(last)dates.push(last.date);
      const shareChange=last?.deltaShares==null?'—':signed(last.deltaShares/1e8,3),changePct=last?.changePct==null?'—':signed(last.changePct)+'%',flow=last?.estimatedFlowYuan==null?'—':signed(last.estimatedFlowYuan/1e8);
      cards.push('<div class="environment-risk-kpi"><div class="etf-shares-fund-title">'+fund.index+'<small>'+fund.code+' · 代表 ETF</small></div><strong>'+shareChange+'<small>亿份</small></strong><div class="etf-shares-detail"><span>净份额变化 '+changePct+'</span><span>'+(last?last.date:'尚未披露')+'</span></div><div class="etf-shares-estimate">净申赎估算<b>'+flow+(flow==='—'?'':' 亿元')+'</b><span class="etf-shares-note">'+metricNote(last)+'</span></div></div>');
      rows.push('<tr><td title="'+escapeHtml(fund.label)+'">'+fund.index+' · '+fund.code+'</td><td>'+(last?last.date:'—')+'</td><td>'+(last?(last.shares/1e8).toFixed(3):'—')+'</td><td class="'+(last?.deltaShares>0?'etf-shares-up':last?.deltaShares<0?'etf-shares-down':'')+'">'+shareChange+'</td><td>'+changePct+'</td><td title="'+escapeHtml(metricNote(last)+(last?.navSource?' · '+last.navSource:''))+'">'+flow+'</td></tr>');
    }
    if(kpis)kpis.innerHTML=cards.join('');if(table)table.innerHTML=rows.join('');
    dates=[...new Set(dates)].sort();put('etfSharesDate',dates.length===1?'最新披露 '+dates[0]:dates.length?'各基金最新披露 '+dates[0]+' 至 '+dates[dates.length-1]:'等待已披露份额数据');
    put('etfSharesFooter','来源：'+(etfMeta?.source||'交易所公布的 ETF 份额与基金净值')+' · 仅覆盖3只代表 ETF，非对应指数全市场合计。每日份额净变化仅在相邻交易日观测完整时计算；跨缺失日或疑似拆份不计算当日变化。净申赎估算=份额净变化×同日单位净值，不等于实际资金净流入。交易所份额与同日单位净值（历史备源：天天基金）分开校验，净值未同步时不估算金额。点击图例可单独观察一只 ETF。'+(etfFailed?' 本次读取未成功，保留已验证披露记录。':''));
    const dateList=etfDates();put('etfSharesRange',dateList.length?'展示 '+dateList.length+' 个披露日 · '+dateList[0]+' 至 '+dateList[dateList.length-1]+' · 各基金可用历史范围不同，未披露或不可比观测留空':'尚无可用历史披露记录，缺失数据不显示为0');
    if(etfChart){etfChart.data.labels=dateList.map(d=>d.slice(5));FUNDS.forEach((f,i)=>{etfChart.data.datasets[i].data=dateList.map(d=>{const r=etfRows.get(f.code)?.get(d);return r?.deltaShares==null?null:r.deltaShares/1e8;});});etfChart.update('none');}
    return !!dates.length;
  }
  function resize(){if(resizePending)return;resizePending=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{resizePending=false;if(active())for(const c of [riskVolChart,riskDrawChart,etfChart])c?.resize();}));}
  function visible(force=false){if(!active())return;restore();renderRisk();renderEtf();resize();refreshRisk(force).catch(e=>console.warn('[市场风险]',e.message));refreshEtf(force).catch(e=>console.warn('[ETF份额]',e.message));}
  global.refreshMarketRisk=refreshRisk;global.refreshEtfShares=refreshEtf;global.renderMarketRisk=renderRisk;global.renderEtfShares=renderEtf;
  if(typeof module==='object'&&module.exports)module.exports={clock,dateValid,cleanBars,computeRisk,riskRow,canReplace,acceptRisk,orderedRisk,getRiskBars:()=>riskBars.map(r=>({...r})),etfRow,acceptEtf,orderedEtf,parseQuote,buildLive,signed,etfDates,metricNote};
  if(typeof document!=='undefined'){const start=()=>{restore();renderRisk();renderEtf();visible(true);const tab=document.getElementById('t0');
      if(tab&&typeof MutationObserver==='function')new MutationObserver(()=>visible(false)).observe(tab,{attributes:true,attributeFilter:['class']});
      setInterval(()=>visible(false),60000);document.addEventListener('visibilitychange',()=>visible(false));global.addEventListener('pageshow',()=>visible(false));global.addEventListener('resize',resize);};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();}
})(typeof window!=='undefined'?window:globalThis);
