/* Shared deterministic market-temperature model. Higher scores describe warmer trading conditions, not expected returns. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MarketHeatModel=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='2026-10-15-v1';
  const MIN_COVERAGE=85;
  const DEFINITIONS=[
    {id:'ma20',label:'20日均线广度',group:'市场广度',weight:8,unit:'%',formula:'收盘价高于20日均线的股票占有效样本比例，直接作为0—100分'},
    {id:'ma60',label:'60日均线广度',group:'市场广度',weight:4,unit:'%',formula:'收盘价高于60日均线的股票占有效样本比例，直接作为0—100分'},
    {id:'ma120',label:'120日均线广度',group:'市场广度',weight:3,unit:'%',formula:'收盘价高于120日均线的股票占有效样本比例，直接作为0—100分'},
    {id:'advanceRatio',label:'上涨股票占比',group:'市场广度',weight:8,unit:'%',formula:'上涨家数÷（上涨家数+下跌家数）×100；平盘不计入分母；涨跌均为零时50分'},
    {id:'newHighLowBalance',label:'52周新高新低强弱',group:'市场广度',weight:6,unit:'%',formula:'（新高家数−新低家数）÷52周有效股票数×100；-5%、0%、+5%对应0、50、100分'},
    {id:'limitBalance',label:'涨跌停强弱',group:'市场广度',weight:6,unit:'%',formula:'（涨停家数−跌停家数）÷当日有成交且收益有效的沪深A股数×100；-2%、0%、+2%对应0、50、100分；分母来自同日个股收益统计，不推算未知平盘家数'},
    {id:'medianReturn',label:'个股收益中位数',group:'赚钱效应',weight:20,unit:'%',formula:'中位数收益-3%、0%、+3%分别对应0、50、100分，区间线性映射并封顶封底'},
    {id:'amountRatio20',label:'成交活跃度',group:'成交热度',weight:20,unit:'倍',formula:'当日成交额÷此前20个已收盘交易日平均成交额；0.5、1、1.5倍对应0、50、100分；不含当日均值，不回填未来数据'},
    {id:'concentration',label:'头部成交拥挤度',group:'成交热度',weight:5,unit:'%',formula:'成交额前20只股票占比5%、12.5%、20%对应0、50、100分；拥挤只代表热度，不代表市场健康'},
    {id:'drawdown',label:'60日高点位置',group:'趋势位置',weight:10,unit:'%',formula:'中证全指距离最近60日高点回撤-20%到0%线性映射至0到100分'},
    {id:'margin5d',label:'融资余额5日变化',group:'资金需求',weight:5,unit:'%',formula:'使用严格早于评分日的最近已披露沪深两市融资余额，相比5个交易日前变化；-3%、0%、+3%对应0、50、100分；交易所融资需求代理指标，证券范围遵循源站口径'},
    {id:'etf5d',label:'代表ETF份额5日变化',group:'资金需求',weight:5,unit:'%',formula:'使用严格早于评分日的最近已披露份额，三只代表ETF各自5交易日份额增速等权平均；-3%、0%、+3%对应0、50、100分；非全市场合计'}
  ];
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const round=v=>Math.round(v*1e6)/1e6;
  const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
  function dateValid(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const n=Date.parse(s+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s;}
  function tradingDateValid(s){if(!dateValid(s))return false;const d=new Date(s+'T00:00:00Z').getUTCDay();return d!==0&&d!==6;}
  function clock(now=Date.now()){const d=new Date(now+8*3600000);return {date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};}
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  function getSeries(source){return Array.isArray(source)?source:Array.isArray(source?.series)?source.series:[];}
  function indexed(source){const result=new Map();for(const row of getSeries(source)){if(!dateValid(row?.date)||result.has(row.date))continue;result.set(row.date,row);}return result;}
  function sorted(source){return [...indexed(source).values()].sort((a,b)=>a.date.localeCompare(b.date));}
  function balanceScore(a,b){return finite(a)&&finite(b)&&a>=0&&b>=0?(a+b===0?50:a/(a+b)*100):null;}
  function centered(value,range){return finite(value)?clamp(50+value/range*50):null;}
  function phase(score){return score===null?'样本不足':score<20?'低温':score<40?'偏冷':score<60?'适中':score<80?'偏热':'高温';}
  function definition(id){return DEFINITIONS.find(d=>d.id===id);}
  function makeComponent(id,score,value,date,options={}){
    const def=definition(id),available=finite(score)&&finite(value)&&dateValid(date);
    return {...def,value:available?round(value):null,score:available?round(clamp(score)):null,contribution:available?round(def.weight*clamp(score)/100):null,
      available,sourceDate:available?date:null,date:available?date:null,availableOn:available?(options.availableOn||date):null,
      availability:available?(options.availability||'当日收盘数据'):'缺少有效数据',reason:available?'':options.reason||'该日数据未披露或未通过校验'};
  }
  function onDate(row,date){return row&&row.date===date;}
  function validClose(row){return row&&(!row.status||row.status==='close')&&(!row.asOf||row.asOf>='15:00');}
  function calendarOf(input){
    if(Array.isArray(input.calendar)&&input.calendar.length){
      const days=input.calendar.filter(tradingDateValid),unique=[...new Set(days)].sort();
      if(unique.length!==input.calendar.length)throw new Error('support trading calendar is invalid or duplicated');
      if(unique.some((d,i)=>d!==input.calendar[i]))throw new Error('support trading calendar must be chronological');
      return unique;
    }
    const dates=new Set();
    for(const source of [input.quality,input.amountHistory,input.ma,input.breadth,input.highLow,input.risk])for(const r of getSeries(source))if(tradingDateValid(r?.date)&&validClose(r))dates.add(r.date);
    for(const d of input.etf?.tradingDates||[])if(tradingDateValid(d))dates.add(d);
    return [...dates].sort();
  }
  function priorDate(date,calendar){const i=calendar.indexOf(date);return i>0?calendar[i-1]:null;}
  function nextDate(date,calendar){const i=calendar.indexOf(date);return i>=0&&i+1<calendar.length?calendar[i+1]:null;}
  function consecutiveWindow(rows,endDate,calendar,n){
    const i=calendar.indexOf(endDate);if(i<n-1)return null;
    const byDate=indexed(rows),expected=calendar.slice(i-n+1,i+1),selected=expected.map(d=>byDate.get(d));
    return selected.every(Boolean)?selected:null;
  }
  function laggedWindow(source,date,calendar,rawKey,options={}){
    const prior=priorDate(date,calendar);if(!prior)return null;
    const rows=sorted(source).filter(r=>r.date<=prior&&finite(r[rawKey])&&r[rawKey]>0&&(!r.availableOn||dateValid(r.availableOn)&&r.availableOn<=date));
    if(!rows.length)return null;
    const latest=rows[rows.length-1];
    // A stale balance must not silently be carried forward as current funding demand.
    if(latest.date!==prior)return null;
    const window=consecutiveWindow(rows,latest.date,calendar,6);
    if(!window)return null;
    // Historical files can mark their first retained row "baseline" or a once-missing
    // previous row "nonconsecutive". A fully restored raw-share calendar supersedes
    // those bookkeeping flags; a split-review flag remains an exclusion.
    if(options.checkActions&&window.slice(1).some((r,i)=>r.metricStatus==='split_review'||Math.abs(r[rawKey]/window[i][rawKey]-1)>.3))return null;
    const start=window[0][rawKey],end=latest[rawKey],growth=(end/start-1)*100;
    const availableOn=latest.availableOn||nextDate(latest.date,calendar);
    if(!dateValid(availableOn)||availableOn>date)return null;
    return {growth,date:latest.date,availableOn,start,end};
  }
  function amountScore(date,input,calendar){
    const byDate=indexed(input.amountHistory),quality=indexed(input.quality);
    for(const [d,r] of quality)if(finite(r.totalAmountYuan)&&r.totalAmountYuan>0)byDate.set(d,{date:d,amountYuan:r.totalAmountYuan});
    const current=byDate.get(date),at=calendar.indexOf(date);
    if(at<20||!finite(current?.amountYuan)||current.amountYuan<=0)return null;
    const expected=calendar.slice(at-20,at),previous=expected.map(d=>byDate.get(d)?.amountYuan);
    if(previous.some(x=>!finite(x)||x<=0))return null;
    const average=previous.reduce((a,b)=>a+b,0)/20,ratio=current.amountYuan/average;
    return {ratio,score:clamp((ratio-.5)*100),average};
  }
  function buildRow(date,input,maps,calendar){
    const {quality,ma,breadth,highLow,risk}=maps,q=quality.get(date),m=ma.get(date),b=breadth.get(date),h=highLow.get(date),r=risk.get(date),components=[];
    for(const w of [20,60,120]){
      const v=m?.windows?.[String(w)],valid=validClose(m)&&finite(v?.pct)&&finite(v.above)&&finite(v.eligible)&&v.eligible>0&&v.above>=0&&v.above<=v.eligible&&Math.abs(v.pct-v.above/v.eligible*100)<.001;
      components.push(makeComponent('ma'+w,valid?v.pct:null,valid?v.pct:null,date));
    }
    const adv=validClose(b)&&count(b?.up)&&count(b?.down)?balanceScore(b?.up,b?.down):null;
    components.push(makeComponent('advanceRatio',adv,adv,date));
    const high=validClose(h)&&count(h?.high)&&count(h?.low)&&count(h?.eligible)&&h.eligible>0&&h.high<=h.eligible&&h.low<=h.eligible?(h.high-h.low)/h.eligible*100:null;
    components.push(makeComponent('newHighLowBalance',centered(high,5),high,date));
    const total=validClose(q)&&count(q?.eligibleCount)&&q.eligibleCount>0?q.eligibleCount:null;
    const limits=validClose(b)&&count(b?.limitUp)&&count(b?.limitDown)&&total>0&&b.limitUp<=total&&b.limitDown<=total?(b.limitUp-b.limitDown)/total*100:null;
    components.push(makeComponent('limitBalance',centered(limits,2),limits,date));
    const median=validClose(q)&&finite(q?.medianReturnPct)&&q.medianReturnPct>-100?q.medianReturnPct:null;
    components.push(makeComponent('medianReturn',centered(median,3),median,date));
    const amount=validClose(q)?amountScore(date,input,calendar):null;
    components.push(makeComponent('amountRatio20',amount?.score,amount?.ratio,date,{reason:'当日及此前20个连续交易日成交额不完整'}));
    const concentration=validClose(q)&&finite(q?.top20SharePct)&&q.top20SharePct>0&&q.top20SharePct<=100?q.top20SharePct:null;
    components.push(makeComponent('concentration',finite(concentration)?clamp((concentration-5)/15*100):null,concentration,date));
    const dd=validClose(r)&&finite(r?.drawdown60)&&r.drawdown60<=0&&r.drawdown60>-100?r.drawdown60:null;
    components.push(makeComponent('drawdown',finite(dd)?clamp((dd+20)*5):null,dd,date));
    const margin=laggedWindow(input.margin,date,calendar,'balanceYuan');
    components.push(makeComponent('margin5d',margin?centered(margin.growth,3):null,margin?.growth,margin?.date,{availableOn:margin?.availableOn,availability:'采用上一交易日已披露融资余额',reason:'上一交易日融资余额或连续5日基准未完整披露'}));
    const funds=input.etf?.funds||[],expectedEtfs=['510300','510500','512100'],validFunds=funds.length===3&&new Set(funds.map(f=>f.code)).size===3&&funds.every(f=>expectedEtfs.includes(f.code));
    const fundResults=validFunds?funds.map(f=>laggedWindow(f.series,date,calendar,'shares',{checkActions:true})):[];
    const etf=fundResults.length===3&&fundResults.every(Boolean)&&new Set(fundResults.map(x=>x.date)).size===1?{growth:fundResults.reduce((s,x)=>s+x.growth,0)/3,date:fundResults[0].date,availableOn:fundResults.reduce((d,x)=>x.availableOn>d?x.availableOn:d,'')}:null;
    components.push(makeComponent('etf5d',etf?centered(etf.growth,3):null,etf?.growth,etf?.date,{availableOn:etf?.availableOn,availability:'采用上一交易日已披露份额',reason:'三只代表ETF的连续5日份额未完整披露，或有拆份/异常待核验'}));
    const coveragePct=components.reduce((s,c)=>s+(c.available?c.weight:0),0),required=['ma20','ma60','medianReturn','amountRatio20','drawdown'],coreReady=required.every(id=>components.find(c=>c.id===id).available);
    const score=coveragePct>=MIN_COVERAGE&&coreReady?round(components.reduce((s,c)=>s+(c.contribution||0),0)/coveragePct*100):null;
    const rv20=validClose(r)&&finite(r?.rv20)&&r.rv20>=0?r.rv20:null;
    const groups=[...new Set(DEFINITIONS.map(x=>x.group))].map(label=>{const items=components.filter(c=>c.group===label),weight=items.reduce((s,c)=>s+c.weight,0),availableWeight=items.reduce((s,c)=>s+(c.available?c.weight:0),0),contribution=round(items.reduce((s,c)=>s+(c.contribution||0),0));return {id:label,label,weight,availableWeight,score:availableWeight?round(contribution/availableWeight*100):null,contribution};});
    return {date,asOf:'15:00',status:'close',score,phase:phase(score),coveragePct,coverage:coveragePct,availableWeight:coveragePct,coreReady,components,groups,
      contexts:{rv20,volatilityStress:rv20===null?'未取得':rv20>=30?'高波动':rv20>=20?'波动偏高':'波动平稳'},
      ...(amount?{activityReference:{meanPrevious20AmountYuan:round(amount.average),window:20,excludesCurrent:true}}:{})};
  }
  function build(input,options={}){
    if(!input||typeof input!=='object')throw new Error('market heat input is required');
    const maps={quality:indexed(input.quality),ma:indexed(input.ma),breadth:indexed(input.breadth),highLow:indexed(input.highLow),risk:indexed(input.risk)},calendar=calendarOf(input);
    const now=clock(options.nowMs),target=sorted(input.quality).filter(r=>validClose(r)&&tradingDateValid(r.date)&&r.date<=now.date&&(r.date!==now.date||now.minute>=900)).map(r=>r.date).slice(-(options.limit||60));
    if(!target.length)throw new Error('no closed market-quality trading dates');
    const series=target.map(date=>buildRow(date,input,maps,calendar));
    return {schemaVersion:1,modelVersion:VERSION,updatedAt:options.updatedAt||new Date().toISOString(),scope:'沪深A股',
      source:'本页沪深A股市场广度、个股收益、成交额、趋势位置及已披露资金数据；中证全指风险趋势含其官方成分范围',
      methodology:'收盘综合热度，固定权重100分；市场广度35、赚钱效应20、成交热度25、趋势位置10、资金需求10。仅使用评分日及此前可获得数据；缺项不作零分，有效权重至少85且20/60日均线广度、个股收益中位数、成交活跃度及60日高点位置齐备才出分；有效项按其权重重新归一至100分。分数越高代表交易环境更热，不代表预期收益或市场健康。',
      componentDefinitions:DEFINITIONS.map(x=>({...x})),minimumCoveragePct:MIN_COVERAGE,
      contextOnly:[{label:'20日实际波动率',reason:'高波动可能来自恐慌下跌，单独显示压力，不计作偏多热度'},{label:'个人开户数、估值、宏观与海外指标',reason:'月频发布时间与历史口径不足，或不能唯一映射为A股日频热度，作为本页背景观察，不回填成每日得分'}],series};
  }
  function expectedScore(id,value){
    if(!finite(value))return null;
    if(['ma20','ma60','ma120','advanceRatio'].includes(id))return value>=0&&value<=100?value:null;
    if(id==='newHighLowBalance')return value>=-100&&value<=100?centered(value,5):null;
    if(id==='limitBalance')return value>=-100&&value<=100?centered(value,2):null;
    if(['medianReturn','margin5d','etf5d'].includes(id))return value>-100?centered(value,3):null;
    if(id==='amountRatio20')return value>0?clamp((value-.5)*100):null;
    if(id==='concentration')return value>0&&value<=100?clamp((value-5)/15*100):null;
    if(id==='drawdown')return value>-100&&value<=0?clamp((value+20)*5):null;
    return null;
  }
  function validatePublishedRow(row,options={}){
    const now=clock(options.nowMs);
    if(!row||!tradingDateValid(row.date)||row.date>now.date||(row.date===now.date&&now.minute<900)||row.status!=='close'||row.asOf!=='15:00'||!Array.isArray(row.components)||row.components.length!==DEFINITIONS.length||!finite(row.score)||row.score<0||row.score>100)return false;
    let availableWeight=0,contributions=0;const ids=new Set();
    for(const c of row.components){
      const d=definition(c?.id);if(!d||ids.has(c.id)||c.weight!==d.weight||typeof c.available!=='boolean')return false;ids.add(c.id);
      if(!c.available){if(c.value!==null||c.score!==null||c.contribution!==null)return false;continue;}
      const expected=expectedScore(c.id,c.value);
      if(!finite(expected)||!finite(c.score)||Math.abs(c.score-expected)>.0002||!finite(c.contribution)||Math.abs(c.contribution-c.score*c.weight/100)>.00002||!tradingDateValid(c.sourceDate)||c.sourceDate>row.date||!tradingDateValid(c.availableOn)||c.availableOn>row.date||c.availableOn<c.sourceDate)return false;
      if(['margin5d','etf5d'].includes(c.id)?c.sourceDate>=row.date:c.sourceDate!==row.date)return false;
      availableWeight+=c.weight;contributions+=c.contribution;
    }
    const required=['ma20','ma60','medianReturn','amountRatio20','drawdown'];
    return availableWeight>=MIN_COVERAGE&&row.coveragePct===availableWeight&&row.coreReady===true&&required.every(id=>row.components.find(c=>c.id===id)?.available)&&Math.abs(row.score-contributions/availableWeight*100)<.0002;
  }
  function combineSupport(input,support){
    if(!support||support.schemaVersion!==1||support.scope!=='沪深A股'||!Array.isArray(support.calendar)||!Array.isArray(support.amountHistory?.series)||!Array.isArray(support.margin?.series)||!Array.isArray(support.etf?.funds))throw new Error('market heat support schema is invalid');
    const result={...input,calendar:support.calendar,amountHistory:support.amountHistory,margin:support.margin};
    const funds=new Map((input.etf?.funds||[]).map(f=>[f.code,{...f,series:f.series||[]}]));
    for(const f of support.etf.funds){const prior=funds.get(f.code)||{},rows=indexed(prior.series);for(const r of f.series||[])rows.set(r.date,{...(rows.get(r.date)||{}),...r});funds.set(f.code,{...prior,...f,series:[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date))});}
    result.etf={...(input.etf||{}),...(support.etf||{}),tradingDates:support.calendar,funds:[...funds.values()]};
    return result;
  }
  function retainPublished(previous,next,options={}){
    if(!next||next.modelVersion!==VERSION||!Array.isArray(next.series))throw new Error('computed market heat schema invalid');
    const rows=new Map();
    if(previous?.modelVersion===VERSION)for(const r of previous.series||[])if(validatePublishedRow(r,options))rows.set(r.date,r);
    let rejected=0;
    for(const r of next.series){
      if(!validatePublishedRow(r,options)){rejected++;continue;}
      const old=rows.get(r.date);if(old&&old.coveragePct>r.coveragePct)continue;
      rows.set(r.date,r);
    }
    const series=[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);
    if(series.length<60)throw new Error('fewer than 60 valid closed market-heat observations; existing output preserved');
    const previousLast=previous?.series?.at(-1)?.date;
    if(previousLast&&series.at(-1).date<previousLast)throw new Error('market heat date regression; existing output preserved');
    return {...next,series,asOf:series.at(-1).date,refreshStatus:{rejectedIncompleteDates:rejected,latestClosedDate:series.at(-1).date,mode:'close_only',note:'各源分批更新期间保留已验证收盘数据，待核心指标齐备后更新当日得分'}};
  }
  return {VERSION,MIN_COVERAGE,DEFINITIONS,dateValid,tradingDateValid,clock,balanceScore,centered,phase,makeComponent,calendarOf,laggedWindow,amountScore,buildRow,build,expectedScore,scoreValue:expectedScore,validatePublishedRow,combineSupport,retainPublished};
});
