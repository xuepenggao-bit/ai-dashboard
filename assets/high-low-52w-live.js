/* Complete, asynchronous 52-calendar-week live breadth. No missing quote = 0. */
let _hl52LivePending=null,_hl52LiveAttempt=0,_hl52Baseline=null,_hl52BaselineAt=0;
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
    const vals=[3,4,6,33,34].map(i=>f[i]===''?NaN:Number(f[i]));
    if(vals.some(v=>!Number.isFinite(v))||vals[0]<=0||vals[1]<=0||vals[2]<0)continue;
    quotes.set(match[1],{code:match[1],price:vals[0],previous:vals[1],volume:vals[2],high:vals[3],low:vals[4],
      date:stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8),time:stamp.slice(8,10)+':'+stamp.slice(10,12)});
  }
  if(codes.some(code=>!quotes.has(code)))throw Error('52周统计报价未完整返回');
  return quotes;
}
async function _hl52GetQuotes(codes){
  return _hl52Quotes(await _idxFetch('https://qt.gtimg.cn/q='+codes.join(',')+'&_='+Date.now(),{gbk:true,timeout:6500,retries:1}),codes);
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
  throw error;
}
function _hl52Thresholds(stock,date){
  const start=_hl52Start(date),high=stock.highs.find(p=>p[0]>=start),low=stock.lows.find(p=>p[0]>=start);
  if(!high||!low)throw Error('52周窗口没有有效基准');
  return{high:high[1],low:low[1]};
}
function _hl52DailyThresholds(rows,date,previous){
  const start=_hl52Start(date),valid=rows.filter(r=>r[0]>=start&&r[0]<date);
  if(!valid.length||rows[0][0]>start||valid[valid.length-1][0]!==previous)throw Error('除权日线不足或过期');
  const highs=valid.map(r=>Number(r[3])),lows=valid.map(r=>Number(r[4]));
  if([...highs,...lows].some(v=>!Number.isFinite(v)))throw Error('除权价格缺失');
  return{high:Math.max(...highs),low:Math.min(...lows),close:Number(valid[valid.length-1][2])};
}
function _hl52Classify(quote,threshold,date){
  if(quote.date!==date)throw Error('个股源日期未更新，保留完整快照');
  if(quote.volume===0)return{high:0,low:0}; // Explicit zero turnover, not an absent quote.
  if(quote.time<'09:30'||quote.high<=0||quote.low<=0||quote.high<quote.low)throw Error('个股盘中高低价无效');
  return{high:Number(quote.high>=threshold.high-1e-7),low:Number(quote.low<=threshold.low+1e-7)};
}
async function _hl52CollectLive(){
  const clock=_highLow52Clock(),date=clock.date;
  const indices=await _hl52GetQuotes(['sh000001','sz399106']);
  const iq=[...indices.values()];
  if(iq.some(q=>q.date!==date||q.time<'09:30'))return false; // Includes real exchange holidays.
  const calendar=await _hl52Daily('sh000001',10);
  const previous=calendar.map(r=>r[0]).filter(d=>d<date).sort().pop();
  let baseline=await _hl52LoadBaseline();
  if(baseline.asOfDate===date)return false; // Completed snapshot is already available.
  if(baseline.asOfDate!==previous)baseline=await _hl52LoadBaseline(true);
  if(baseline.asOfDate!==previous)throw Error('52周收盘基准待更新');
  if(!baseline.validThrough||baseline.validThrough<date)throw Error('52周比较窗口已过期');
  const start=_hl52Start(date),eligible=baseline.stocks.filter(s=>s.firstDate<=start);
  if(eligible.length<4000)throw Error('52周有效样本不足');
  const batches=[];
  for(let i=0;i<eligible.length;i+=80)batches.push(eligible.slice(i,i+80));
  let cursor=0,high=0,low=0,stopped=false;
  // At most four requests at a time; the chart and the rest of the dashboard
  // remain usable while a full-market scan completes in the background.
  const results=await Promise.allSettled(Array.from({length:4},async()=>{
    try{while(cursor<batches.length&&!stopped){
      if(document.hidden||!document.getElementById('t0')?.classList.contains('active'))throw Error('页面已离开，取消本轮');
      const batch=batches[cursor++],quotes=await _hl52GetQuotes(batch.map(s=>s.code));
      for(const stock of batch){
        const quote=quotes.get(stock.code);
        let threshold=_hl52Thresholds(stock,date);
        if(quote.volume>0&&Math.abs(quote.previous-stock.close)>.012){
          // Never apply unadjusted quotes to a previous-vintage adjusted price.
          // Re-read only affected stocks (e.g. ex-dividend/split) in today's basis.
          threshold=_hl52DailyThresholds(await _hl52Daily(stock.code),date,previous);
          if(Math.abs(quote.previous-threshold.close)>.012)throw Error('除权基准仍不一致');
        }
        const result=_hl52Classify(quote,threshold,date);high+=result.high;low+=result.low;
      }
    }}catch(e){stopped=true;throw e;}
  }));
  const failure=results.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
  if(_highLow52Clock().date!==date)throw Error('交易日已切换');
  const time=[...iq.map(q=>q.time),'15:00'].sort()[0];
  return _setHighLow52LivePoint({date,high,low,eligible:eligible.length,universe:baseline.stocks.length,
    asOf:time,status:'live'},{source:'东方财富股票名单 · 腾讯财经复权日线 + 盘中行情'});
}
function refreshHighLow52Live(force=false){
  const clock=_highLow52Clock(),day=new Date(clock.date+'T00:00:00Z').getUTCDay();
  if(document.hidden||!document.getElementById('t0')?.classList.contains('active')||
     day===0||day===6||clock.minute<570||clock.minute>960)return Promise.resolve(false);
  if(_hl52LivePending)return _hl52LivePending;
  if(!force&&_hl52LiveAttempt&&Date.now()-_hl52LiveAttempt<300000)return Promise.resolve(false);
  _hl52LiveAttempt=Date.now();
  _hl52LivePending=_hl52CollectLive().catch(e=>{console.warn('[52周盘中统计]',e.message);return false;})
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
