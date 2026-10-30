/* Read-only freshness assessment: a completed request is not proof of current data. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MarketEnvironmentFreshness=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const MINUTE=60000,DAY=86400000;
  const CARDS=Object.freeze([
    {id:'caps',label:'沪深A股市值',selector:'kTmcDate',cadence:'intraday',market:'A'},
    {id:'ssePe',label:'上证估值',selector:'kSsePeDate',cadence:'intraday',market:'A'},
    {id:'szePe',label:'深证估值',selector:'kSzePeDate',cadence:'intraday',market:'A'},
    {id:'gemPe',label:'创业板估值',selector:'kGemPeDate',cadence:'intraday',market:'A'},
    {id:'starPe',label:'科创50估值',selector:'kStarPeDate',cadence:'intraday',market:'A'},
    {id:'amount',label:'沪深成交额',selector:'volumeKpiDate',cadence:'intraday',market:'A'},
    {id:'highLow52',label:'52周新高新低',selector:'highLow52KpiDate',cadence:'intraday',market:'A'},
    {id:'breadth',label:'涨跌家数',selector:'breadthKpiDate',cadence:'intraday',market:'A'},
    {id:'limits',label:'涨跌停家数',selector:'limitKpiDate',cadence:'intraday',market:'A'},
    {id:'hkAmount',label:'港股成交额',selector:'hkVolumeKpiDate',cadence:'intraday',market:'HK'},
    {id:'maBreadth',label:'均线广度',selector:'maBreadthDate',cadence:'intraday',market:'A'},
    {id:'risk',label:'波动与回撤',selector:'marketRiskDate',cadence:'intraday',market:'A'},
    {id:'median',label:'个股收益中位数',selector:'marketMedianDate',cadence:'intraday',market:'A'},
    {id:'concentration',label:'成交额集中度',selector:'marketConcentrationDate',cadence:'intraday',market:'A'},
    {id:'heat',label:'市场热度',selector:'marketHeatDate',cadence:'close',market:'A'},
    {id:'margin',label:'融资融券余额',selector:'marginKpiDate',cadence:'reported-daily',market:'A'},
    {id:'etf',label:'ETF份额变化',selector:'etfSharesDate',cadence:'reported-daily',market:'A',oldestDate:true},
    {id:'accounts',label:'个人开户数',selector:'aoPeriod',cadence:'monthly',market:'A'}
  ].map(Object.freeze));
  function clock(now){const d=new Date(now+8*60*MINUTE);return{date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};}
  function validDate(date){return typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;}
  function parseText(text,oldestDate=false){
    const value=String(text||''),dates=[...value.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]).filter(validDate);
    const time=value.match(/(?:^|[^\d])([01]\d|2[0-3]):([0-5]\d)(?!\d)/);
    return{date:oldestDate?dates.slice().sort()[0]||null:dates[0]||null,minute:time?Number(time[1])*60+Number(time[2]):null,text:value};
  }
  function stateAt(session,market,now){try{return session?.marketState?.(market,now)||null;}catch(_){return null;}}
  function previousSession(session,market,date){
    // Ask the verified exchange calendar for each day. Never infer open weekdays.
    let ms=Date.parse(date+'T16:30:00+08:00');
    for(let i=0;i<370;i++){
      ms-=DAY;const state=stateAt(session,market,ms);
      if(!state?.calendarKnown)return null;
      if(state.isTradingDay)return{date:clock(ms).date,closeMinute:state.closeMinute};
    }
    return null;
  }
  function expectation(session,market,now,cadence){
    const c=clock(now),state=stateAt(session,market,now);
    if(!state?.calendarKnown)return null;
    const previous=previousSession(session,market,c.date);
    const close=Number.isFinite(state.closeMinute)?state.closeMinute:(market==='HK'?970:900);
    const isOpen=state.isTradingDay&&c.minute>=570;
    if(cadence==='intraday'&&isOpen)return{date:c.date,closeMinute:close,state,previous,clock:c};
    if(c.minute>=close&&state.isTradingDay)return{date:c.date,closeMinute:close,state,previous,clock:c};
    if(!previous)return null;
    return{...previous,state,previous,clock:c};
  }
  function result(card,state,date,message){return{id:card.id,label:card.label,cadence:card.cadence,state,date:date||null,message};}
  function classify(card,text,now=Date.now(),session=root.PortfolioMarketSession){
    if(!Number.isFinite(now))return result(card,'unknown',null,'当前时间待确认');
    if(card.cadence==='monthly'){
      const match=String(text||'').match(/(\d{4})年\s*(1[0-2]|0?[1-9])月/),iso=String(text||'').match(/\b(\d{4})-(0[1-9]|1[0-2])\b/);
      const month=match?match[1]+'-'+match[2].padStart(2,'0'):iso?iso[1]+'-'+iso[2]:null;
      return month?result(card,'periodic',month,'按月披露 · 截至 '+month+'，未公布月份不推算'):result(card,'pending',null,'等待已公布月份');
    }
    const observed=parseText(text,card.oldestDate),expected=expectation(session,card.market,now,card.cadence);
    if(!expected)return result(card,'unknown',observed.date,'交易日历待确认 · 不判断是否最新');
    if(!observed.date)return result(card,'pending',null,'等待有效数据日期');
    if(observed.date>expected.clock.date)return result(card,'unknown',observed.date,'数据日期超前，待核验');
    if(card.cadence==='reported-daily'){
      // The closing bell is not a publication time for ETF clearing or margin data.
      if(observed.date>=expected.date)return result(card,'current',observed.date,'已到最近已披露交易日 · '+observed.date);
      if(expected.date===expected.clock.date&&expected.previous&&observed.date>=expected.previous.date)return result(card,'scheduled',observed.date,'截至 '+observed.date+' · 等待今日清算或交易所披露');
      return result(card,'stale',observed.date,'截至 '+observed.date+' · 待核验最新披露，最近已收盘交易日 '+expected.date);
    }
    if(observed.date<expected.date)return result(card,'stale',observed.date,'截至 '+observed.date+' · 待更新至 '+expected.date);
    if(card.cadence==='close'){
      if(observed.date>expected.date)return result(card,'pending',observed.date,'今日尚未收盘 · 等待完整收盘统计');
      return result(card,'current',observed.date,'收盘统计截至 '+observed.date);
    }
    if(observed.date>expected.date)return result(card,'pending',observed.date,'尚未进入连续交易 · 行情时点待确认');
    const {state,clock:c}=expected;
    if(observed.date!==c.date){
      if(observed.minute!==null&&observed.minute<expected.closeMinute-5)return result(card,'stale',observed.date,'上一交易日盘中快照 · 待补收盘数据');
      return result(card,'current',observed.date,'最近交易日收盘 · '+observed.date);
    }
    if(observed.minute===null)return result(card,'untimed',observed.date,'已到今日 · 数据源未提供具体行情时刻，不冒充逐分钟实时');
    if(observed.minute>c.minute)return result(card,'unknown',observed.date,'行情时间超前，待核验');
    let target=c.minute;
    if(state.phase==='lunch')target=card.market==='HK'?720:690;
    else if(state.phase==='after_close')target=expected.closeMinute;
    if(observed.minute<target-5)return result(card,'stale',observed.date,'行情截至 '+String(text).trim()+' · 待更新最新时点');
    return result(card,'current',observed.date,state.phase==='lunch'?'午间休市 · 已保留上午收盘数据':state.phase==='after_close'?'已到今日收盘行情':'盘中数据已到最近5分钟');
  }
  function inspect(now=Date.now()){
    return CARDS.map(card=>classify(card,root.document?.getElementById?.(card.selector)?.textContent||'',now,root.PortfolioMarketSession));
  }
  return{inspect,classify,parseText,CARDS};
});
