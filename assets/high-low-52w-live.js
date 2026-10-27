/* One bounded asynchronous quote scan shared by all full-market indicators. */
let _hl52LivePending=null,_hl52LiveAttempt=0,_hl52LiveSuccess=0,_hl52Baseline=null,_hl52BaselineAt=0;
let _hl52AdjustmentDate='',_hl52Adjustments=new Map();
function _hl52Status(message){if(typeof _setHighLow52LiveStatus==='function')_setHighLow52LiveStatus(message);}
const _hl52BaselineUrls=['./data/market_high_low_52w_baseline.json',
  'https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/market_high_low_52w_baseline.json'];

function _hl52Start(date){return new Date(Date.parse(date+'T00:00:00Z')-364*86400000).toISOString().slice(0,10);}
function _hl52ValidBaseline(data){
  if(!data||data.schemaVersion!==1||!/^\d{4}-\d{2}-\d{2}$/.test(data.asOfDate)||!Array.isArray(data.stocks)||data.stocks.length<4000)return false;
  const codes=new Set();
  return data.stocks.every(s=>{
    if(!s||!/^(sh(?:60|68)|sz(?:00|30))\d{4}$/.test(s.code)||codes.has(s.code)||
       !/^\d{4}-\d{2}-\d{2}$/.test(s.firstDate)||!Number.isFinite(s.close)||s.close<=0)return false;
    codes.add(s.code);
    return ['highs','lows'].every(key=>Array.isArray(s[key])&&s[key].length&&s[key].every((p,i)=>
      Array.isArray(p)&&/^\d{4}-\d{2}-\d{2}$/.test(p[0])&&p[0]<=data.asOfDate&&Number.isFinite(p[1])&&
      (!i||(p[0]>s[key][i-1][0]&&(key==='highs'?p[1]<s[key][i-1][1]:p[1]>s[key][i-1][1])))));
  });
}
async function _hl52LoadBaseline(force=false){
  if(!force&&_hl52Baseline&&Date.now()-_hl52BaselineAt<300000)return _hl52Baseline;
  const results=await Promise.allSettled(_hl52BaselineUrls.map(url=>_idxFetch(url+'?_='+Date.now(),{timeout:8000,retries:0})));
  for(const r of results){
    if(r.status!=='fulfilled'||!_hl52ValidBaseline(r.value))continue;
    const next=r.value;
    if(!_hl52Baseline||next.asOfDate>_hl52Baseline.asOfDate||
       (next.asOfDate===_hl52Baseline.asOfDate&&Date.parse(next.updatedAt)>Date.parse(_hl52Baseline.updatedAt)))_hl52Baseline=next;
  }
  _hl52BaselineAt=Date.now();
  if(!_hl52Baseline)throw Error('52周比较基准不可用');
  return _hl52Baseline;
}
function _hl52Quotes(text,codes){
  const quotes=new Map();
  for(const match of String(text).matchAll(/v_((?:sh|sz)\d{6})="([^"]*)"/g)){
    const f=match[2].split('~');if(f.length<35)continue;
    const stamp=f[30];
    if(!/^\d{14}$/.test(stamp))continue;
    const vals=[3,4,6].map(i=>f[i]===''?NaN:Number(f[i]));
    if(vals.some(v=>!Number.isFinite(v))||vals[0]<=0||vals[1]<=0||vals[2]<0)continue;
    const amount=f[37]===''?NaN:Number(f[37]),change=f[32]===''?NaN:Number(f[32]);
    quotes.set(match[1],{code:match[1],price:vals[0],previous:vals[1],volume:vals[2],high:f[33]===''?NaN:Number(f[33]),low:f[34]===''?NaN:Number(f[34]),
      amountYuan:Number.isFinite(amount)&&amount>=0?amount*10000:NaN,returnPct:Number.isFinite(change)?change:NaN,
      date:stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8),time:stamp.slice(8,10)+':'+stamp.slice(10,12)});
  }
  if(codes.some(code=>!quotes.has(code)))throw Error('52周统计报价未完整返回');
  return quotes;
}
async function _hl52GetQuotes(codes,requireComplete=true){
  return _hl52Quotes(await _idxFetch('https://qt.gtimg.cn/q='+codes.join(',')+'&_='+Date.now(),{gbk:true,timeout:6500,retries:1}),requireComplete?codes:[]);
}
async function _hl52Daily(code,count=400){
  let error;
  for(const host of ['https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get']){
    try{
      const payload=await _idxFetch(host+'?param='+code+',day,,,'+count+',qfq&_='+Date.now(),{timeout:6500,retries:0});
      const item=payload?.data?.[code],rows=item?.qfqday||item?.day;
      if(payload?.code!==0||!Array.isArray(rows)||!rows.length)throw Error('无有效复权日线');
      return rows;
    }catch(e){error=e;}
  }
  // The Tencent daily service can rate-limit independently of its quote
  // service. Use a whole forward-adjusted history from the alternate source.
  try{
    if(!/^(sh|sz)\d{6}$/.test(code))throw Error('股票代码无效');
    const market=code.startsWith('sh')?1:0;
    const begin=new Date(Date.now()-900*86400000).toISOString().slice(0,10).replace(/-/g,'');
    const url='https://push2his.eastmoney.com/api/qt/stock/kline/get?secid='+market+'.'+code.slice(2)+
      '&klt=101&fqt=1&beg='+begin+'&end=20500101&lmt='+count+'&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&_='+Date.now();
    let payload;
    try{payload=await _idxFetch(url,{timeout:6500,retries:0});}
    catch(e){if(typeof _idxJsonp!=='function')throw e;payload=await _idxJsonp(url,6500);}
    const item=payload?.data;
    if(payload?.rc!==0||item?.code!==code.slice(2)||item?.market!==market||!Array.isArray(item.klines)||!item.klines.length)throw Error('备用复权日线无效');
    const rows=item.klines.map(row=>String(row).split(','));
    if(rows.some(row=>row.length!==6||!/^\d{4}-\d{2}-\d{2}$/.test(row[0])||row.slice(1).some(v=>v===''||!Number.isFinite(Number(v)))))throw Error('备用复权日线字段无效');
    return rows.slice(-count);
  }catch(e){error=e;}
  throw Error('复权日线源暂不可达');
}
function _hl52Thresholds(stock,date){
  const start=_hl52Start(date),high=stock.highs.find(p=>p[0]>=start),low=stock.lows.find(p=>p[0]>=start);
  if(!high||!low)throw Error('52周窗口没有有效基准');
  return{high:high[1],low:low[1]};
}
function _hl52DailyThresholds(rows,date,previous,lastDate=previous){
  const start=_hl52Start(date),valid=rows.filter(r=>r[0]>=start&&r[0]<date);
  if(!valid.length||rows[0][0]>start||valid[valid.length-1][0]!==lastDate||lastDate>previous)throw Error('除权日线不足或过期');
  const highs=valid.map(r=>Number(r[3])),lows=valid.map(r=>Number(r[4]));
  if([...highs,...lows].some(v=>!Number.isFinite(v)))throw Error('除权价格缺失');
  return{high:Math.max(...highs),low:Math.min(...lows),close:Number(valid[valid.length-1][2])};
}
function _hl52Classify(quote,threshold,date){
  if(quote.date!==date)throw Error('个股源日期未更新，保留完整快照');
  if(quote.volume===0)return{high:0,low:0}; // Explicit zero turnover, not an absent quote.
  if(quote.time<'09:30'||!Number.isFinite(quote.high)||!Number.isFinite(quote.low)||quote.high<=0||quote.low<=0||quote.high<quote.low)throw Error('个股盘中高低价无效');
  return{high:Number(quote.high>=threshold.high-1e-7),low:Number(quote.low<=threshold.low+1e-7)};
}
function _hl52Minute(value){return typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):NaN;}
function _hl52Fresh(quote,clock){
  const minute=_hl52Minute(quote.time),reference=clock.minute>690&&clock.minute<780?690:Math.min(clock.minute,900);
  return quote.date===clock.date&&Number.isFinite(minute)&&minute>=reference-5&&minute<=clock.minute+1;
}
async function _hl52CollectLive(){
  const clock=_highLow52Clock(),date=clock.date;
  if(_hl52AdjustmentDate!==date){_hl52Adjustments.clear();_hl52AdjustmentDate=date;}
  const indices=await _hl52GetQuotes(['sh000001','sz399106']);
  const iq=[...indices.values()];
  if(iq.some(q=>q.time<'09:30'||!_hl52Fresh(q,clock))){_hl52Status('暂无有效当日实时行情 · 保留最近统计');return false;} // Includes real exchange holidays.
  const calendar=await _hl52Daily('sh000001',10);
  const previous=calendar.map(r=>r[0]).filter(d=>d<date).sort().pop();
  let baseline=await _hl52LoadBaseline();
  if(baseline.asOfDate===date){_hl52Status('今日收盘统计已完成');return true;}
  if(baseline.asOfDate!==previous)baseline=await _hl52LoadBaseline(true);
  if(baseline.asOfDate!==previous)throw Error('52周基准截至 '+baseline.asOfDate+'，需 '+previous+' 收盘基准');
  if(!baseline.validThrough||baseline.validThrough<date)throw Error('52周比较窗口已过期');
  const start=_hl52Start(date),eligible=baseline.stocks.filter(s=>s.firstDate<=start);
  if(eligible.length<4000)throw Error('52周有效样本不足');
  let maBaseline=null;
  if(typeof window.loadMaBreadthBaseline==='function'){
    try{
      const candidate=await window.loadMaBreadthBaseline(false);
      if(candidate.asOfDate===previous&&candidate.stocks.length>=4000)maBaseline=candidate;
      else console.warn('[均线广度] 上一交易日基准待更新');
    }catch(error){console.warn('[均线广度基准]',error.message);}
  }
  let qualityBaseline=null;
  if(typeof window.loadMarketQualityBaseline==='function'){
    try{
      let candidate=await window.loadMarketQualityBaseline(false);
      if(candidate.asOfDate!==previous&&candidate.asOfDate!==date)candidate=await window.loadMarketQualityBaseline(true);
      if(candidate.asOfDate===previous&&candidate.stocks.length>=4000)qualityBaseline=candidate;
    }catch(error){console.warn('[收益与成交集中度基准]',error.message);}
  }
  // MA and market-quality samples include younger listings. All consumers
  // share this worker pool; no second full-market quote scan is created.
  const requiredHighLow=new Map(eligible.map(stock=>[stock.code,stock]));
  const codes=[...new Set([...requiredHighLow.keys(),...(maBaseline?maBaseline.stocks.map(stock=>stock.code):[]),
    ...(qualityBaseline?qualityBaseline.stocks.map(stock=>stock.code):[])])];
  const allQuotes=new Map();
  const batches=[];
  for(let i=0;i<codes.length;i+=80)batches.push(codes.slice(i,i+80));
  let cursor=0,high=0,low=0,observed=0,completed=0,earliest='15:00';
  // At most four requests at a time; the chart and the rest of the dashboard
  // remain usable while a full-market scan completes in the background.
  const results=await Promise.allSettled(Array.from({length:4},async()=>{
    while(cursor<batches.length){
      if(document.hidden||!document.getElementById('t0')?.classList.contains('active'))throw Error('页面已离开，取消本轮');
      const batch=batches[cursor++];let quotes=new Map();
      try{quotes=await _hl52GetQuotes(batch,false);}catch(error){console.warn('[盘中批量行情]',error.message);}
      const missing=batch.filter(code=>!quotes.has(code));
      if(missing.length){try{for(const [code,q] of await _hl52GetQuotes(missing,false))quotes.set(code,q);}catch(error){console.warn('[盘中补查]',error.message);}}
      for(const [code,quote] of quotes)allQuotes.set(code,quote);
      for(const code of batch){
        const stock=requiredHighLow.get(code);
        if(!stock)continue;
        const quote=quotes.get(code);
        if(!quote)continue;
        try{
        if(quote.volume>0&&!_hl52Fresh(quote,_highLow52Clock()))throw Error('个股行情时间待更新');
        let threshold=_hl52Thresholds(stock,date);
        if(quote.volume>0&&Math.abs(quote.previous-stock.close)>.012){
          // Never apply unadjusted quotes to a previous-vintage adjusted price.
          // Re-read only affected stocks (e.g. ex-dividend/split) in today's basis.
          const key=stock.code+'|'+baseline.updatedAt+'|'+quote.previous+'|'+(stock.lastDate||previous);
          quote.adjustedRows=_hl52Adjustments.get(key)||await _hl52Daily(stock.code);
          threshold=_hl52DailyThresholds(quote.adjustedRows,date,previous,stock.lastDate||previous);
          if(Math.abs(quote.previous-threshold.close)>.012)throw Error('除权基准仍不一致');
          _hl52Adjustments.set(key,quote.adjustedRows);
        }
        const result=_hl52Classify(quote,threshold,date);high+=result.high;low+=result.low;observed++;
        if(quote.volume>0&&quote.time<earliest)earliest=quote.time;
        }catch(error){console.warn('[52周个股待核验]',code,error.message);}
      }
      completed+=batch.length;_hl52Status('正在统计 · '+completed.toLocaleString('zh-CN')+'/'+codes.length.toLocaleString('zh-CN')+' 只');
    }
  }));
  const failure=results.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
  if(_highLow52Clock().date!==date)throw Error('交易日已切换');
  const time=[...iq.map(q=>q.time),earliest,'15:00'].sort()[0];
  // Unknown observations are never zero or extrapolated. Only publish a
  // near-complete observation, with explicit coverage on the chart.
  let highLowUpdated=false;
  if(observed>=Math.ceil(eligible.length*.99)){
    highLowUpdated=_setHighLow52LivePoint({date,high,low,eligible:eligible.length,universe:baseline.stocks.length,
      observed,missing:eligible.length-observed,asOf:time,status:'live'},{source:'东方财富股票名单 · 腾讯财经复权日线 + 盘中行情'});
    _hl52Status('截至 '+time+' · '+(observed===eligible.length?'全样本核验':'覆盖 '+(observed/eligible.length*100).toFixed(2)+'% · '+(eligible.length-observed)+' 只待核验')+' · 盘中约每分钟更新');
  }else _hl52Status('本轮覆盖 '+(observed/eligible.length*100).toFixed(2)+'%，保留上次统计 · 将自动重试');
  let maUpdated=false;
  if(maBaseline&&typeof window.applyMaBreadthLiveQuotes==='function'){
    try{maUpdated=await window.applyMaBreadthLiveQuotes(maBaseline,allQuotes,date,time,previous);}
    catch(error){console.warn('[均线广度盘中统计]',error.message);}
  }
  let qualityUpdated=false;
  if(qualityBaseline&&typeof window.applyMarketQualityLiveQuotes==='function'){
    try{qualityUpdated=await window.applyMarketQualityLiveQuotes(qualityBaseline,allQuotes,date,time,previous);}
    catch(error){console.warn('[收益与成交集中度盘中统计]',error.message);}
  }
  return highLowUpdated;
}
function refreshHighLow52Live(force=false){
  const clock=_highLow52Clock(),day=new Date(clock.date+'T00:00:00Z').getUTCDay();
  if(document.hidden||!document.getElementById('t0')?.classList.contains('active')||
     day===0||day===6||clock.minute<570||clock.minute>960)return Promise.resolve(false);
  if(_hl52LivePending)return _hl52LivePending;
  const qualityClose=typeof window.marketQualityClosePending==='function'?window.marketQualityClosePending():null;
  if(qualityClose)return qualityClose;
  if(!force&&_hl52LiveAttempt&&Date.now()-_hl52LiveAttempt<60000)return Promise.resolve(false);
  _hl52LiveAttempt=Date.now();
  _hl52Status('正在读取盘中行情…');
  _hl52LivePending=_hl52CollectLive().then(ok=>{if(ok)_hl52LiveSuccess=Date.now();return ok;}).catch(e=>{
    console.warn('[52周盘中统计]',e.message);_hl52Status(e.message+' · 保留上次统计，将自动重试');return false;})
    .finally(()=>{_hl52LivePending=null;});
  return _hl52LivePending;
}
document.addEventListener('DOMContentLoaded',()=>{
  const run=()=>refreshHighLow52Live(false),macro=document.getElementById('t0');
  setTimeout(run,1800);setInterval(run,60000);
  if(macro&&typeof MutationObserver==='function')new MutationObserver(run).observe(macro,{attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange',run);
  window.addEventListener('pageshow',run);
});


