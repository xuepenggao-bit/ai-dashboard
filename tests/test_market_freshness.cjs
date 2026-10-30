'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('../assets/market-freshness.js'),S=require('../assets/market-session.js');
const at=s=>Date.parse(s+'+08:00'),card=id=>F.CARDS.find(v=>v.id===id);
const assess=(id,text,time)=>F.classify(card(id),text,at(time),S);
test('intraday identifies old dates and validates actual quote minute, not fetch success',()=>{
  assert.equal(assess('highLow52','2026-10-28 · 收盘 15:00','2026-10-30T10:35:00').state,'stale');
  assert.equal(assess('highLow52','2026-10-30 · 盘中实时 10:34','2026-10-30T10:35:00').state,'current');
  assert.equal(assess('highLow52','2026-10-30 · 盘中实时 10:20','2026-10-30T10:35:00').state,'stale');
  assert.equal(assess('highLow52','2026-10-30','2026-10-30T10:35:00').state,'pending');
  assert.equal(assess('highLow52','2026-10-30 10:36','2026-10-30T10:35:00').state,'unknown');
});
test('A-share and HK lunch preserve their own morning close',()=>{
  assert.equal(assess('breadth','2026-10-30 · 午间休市 11:30','2026-10-30T12:45:00').state,'current');
  assert.equal(assess('breadth','2026-10-30 11:15','2026-10-30T12:45:00').state,'stale');
  assert.equal(assess('hkAmount','2026-10-30 · 盘中累计 12:00','2026-10-30T12:45:00').state,'current');
  assert.equal(assess('hkAmount','2026-10-30 11:30','2026-10-30T12:45:00').state,'stale');
});
test('close statistics and reported daily data are current at the previous close during morning',()=>{
  assert.equal(assess('heat','2026-10-29 · 收盘 15:00','2026-10-30T10:35:00').state,'current');
  assert.equal(assess('heat','2026-10-28 · 收盘 15:00 · 待更新至 10-29','2026-10-30T10:35:00').state,'stale');
  assert.equal(assess('margin','2026-10-29','2026-10-30T10:35:00').state,'current');
  assert.equal(assess('etf','最新披露 2026-10-29','2026-10-30T10:35:00').state,'current');
  assert.equal(assess('etf','各基金最新披露 2026-10-28 至 2026-10-29','2026-10-30T10:35:00').state,'stale');
});
test('closing bell demands same-day intraday/heat but does not pretend reports publish instantly',()=>{
  assert.equal(assess('median','2026-10-30 15:00','2026-10-30T16:30:00').state,'current');
  assert.equal(assess('median','2026-10-30 11:30','2026-10-30T16:30:00').state,'stale');
  assert.equal(assess('heat','2026-10-29 15:00','2026-10-30T16:30:00').state,'stale');
  assert.equal(assess('margin','2026-10-29','2026-10-30T16:30:00').state,'scheduled');
  assert.equal(assess('etf','最新披露 2026-10-30','2026-10-30T16:30:00').state,'current');
});
test('verified holidays and different exchange calendars select actual previous sessions',()=>{
  assert.equal(assess('breadth','2026-09-30 15:00','2026-10-07T10:35:00').state,'current');
  assert.equal(assess('breadth','2026-09-29 15:00','2026-10-07T10:35:00').state,'stale');
  assert.equal(assess('hkAmount','2026-10-16 16:10','2026-10-19T10:35:00').state,'current');
  assert.equal(assess('amount','2026-10-16 15:00','2026-10-19T10:35:00').state,'stale');
  assert.equal(assess('breadth','2026-10-30 15:00','2026-10-31T10:35:00').state,'current');
});
test('unverified calendar never guesses that an arbitrary weekday is open or current',()=>{
  const unknown={marketState:()=>({calendarKnown:false})};
  for(const id of ['amount','heat','margin','etf'])assert.equal(F.classify(card(id),'2026-10-30 10:35',at('2026-10-30T10:35:00'),unknown).state,'unknown');
  assert.equal(assess('amount','2027-01-04 10:35','2027-01-04T10:35:00').state,'unknown');
});
test('monthly source is periodic rather than a false daily outage',()=>{
  const record=assess('accounts','截至 2026年9月 · 每日核验','2026-10-30T10:35:00');
  assert.equal(record.state,'periodic');assert.equal(record.date,'2026-09');
  assert.equal(assess('accounts','等待最新月报','2026-10-30T10:35:00').state,'pending');
});
test('date parser keeps actual first observed date, rejects impossible dates, and parses ETF oldest',()=>{
  assert.equal(F.parseText('2026-10-28 · 待更新至 2026-10-30').date,'2026-10-28');
  assert.equal(F.parseText('2026-02-30').date,null);
  assert.equal(F.parseText('2026-10-29 至 2026-10-28',true).date,'2026-10-28');
});
test('browser inspect reads current DOM on every call without requests or date mutation',()=>{
  const values={highLow52KpiDate:'2026-10-28 · 收盘 15:00',aoPeriod:'截至 2026年9月'};
  const ctx={PortfolioMarketSession:S,document:{getElementById:id=>({textContent:values[id]||''})},Date,fetch:()=>{throw Error('Must not make requests');}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/market-freshness.js'),'utf8'),ctx);
  const first=ctx.MarketEnvironmentFreshness.inspect(at('2026-10-30T10:35:00'));
  assert.equal(first.length,18);assert.equal(first.find(v=>v.id==='highLow52').state,'stale');
  values.highLow52KpiDate='2026-10-30 · 盘中实时 10:35';
  const second=ctx.MarketEnvironmentFreshness.inspect(at('2026-10-30T10:35:00'));
  assert.equal(second.find(v=>v.id==='highLow52').state,'current');
  assert.equal(first.find(v=>v.id==='highLow52').state,'stale','Earlier results are independent snapshots');
  assert.equal(values.highLow52KpiDate,'2026-10-30 · 盘中实时 10:35');
});
test('a dated amount without a source minute is neither falsely realtime nor a false missing-data warning',()=>{
  const card=F.CARDS.find(c=>c.id==='hkAmount');
  const value=F.classify(card,'2026-10-30 · 盘中累计',at('2026-10-30T11:00:00'),S);
  assert.equal(value.state,'untimed');assert.match(value.message,/未提供具体行情时刻/);
});
