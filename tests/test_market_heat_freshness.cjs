'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const M=require('../assets/market-heat-engine.js');
const uiSource=fs.readFileSync(path.join(__dirname,'../assets/market-heat.js'),'utf8');
function dates(n){const result=[];let day=new Date('2026-01-02T00:00:00Z');while(result.length<n){if(day.getUTCDay()!==0&&day.getUTCDay()!==6)result.push(day.toISOString().slice(0,10));day=new Date(day.getTime()+864e5);}return result;}
const DAYS=dates(92),NOW=Date.parse(DAYS[91]+'T10:00:00+08:00'),LATEST=DAYS[90],PREVIOUS=DAYS[89];
function fixture(n=91){const calendar=DAYS.slice(0,n),input={calendar,quality:{series:[]},ma:{series:[]},breadth:{series:[]},highLow:{series:[]},risk:{series:[]},amountHistory:{series:[]},margin:{series:[]},etf:{funds:['510300','510500','512100'].map(code=>({code,series:[]}))}};
  for(const [i,date] of calendar.entries()){
    input.amountHistory.series.push({date,amountYuan:100});input.margin.series.push({date,balanceYuan:1e12});for(const fund of input.etf.funds)fund.series.push({date,shares:1e10});
    if(i<30)continue;
    input.quality.series.push({date,status:'close',asOf:'15:00',eligibleCount:5000,medianReturnPct:0,totalAmountYuan:100,top20SharePct:12.5});
    input.ma.series.push({date,status:'close',asOf:'15:00',windows:Object.fromEntries([20,60,120].map(w=>[w,{above:2500,eligible:5000,pct:50}]))});
    input.breadth.series.push({date,up:2500,down:2500,limitUp:50,limitDown:50});input.highLow.series.push({date,high:100,low:100,eligible:5000});input.risk.series.push({date,status:'close',asOf:'15:00',drawdown60:-10,rv20:15});
  }
  return input;
}
function build(input){return M.build(input,{nowMs:NOW,updatedAt:new Date(NOW-60000).toISOString()});}
function payload(pending=true){const previous=build(fixture(90)),input=fixture();if(pending){input.ma.series.pop();input.highLow.series.pop();}return M.retainPublished(previous,build(input),{nowMs:NOW});}
function clone(value){return JSON.parse(JSON.stringify(value));}
function ui(){const elements=new Map(['marketHeatDate','marketHeatScore','marketHeatZone','marketHeatRiskContext','marketHeatChange','marketHeatCoverage','marketHeatRange','marketHeatFooter'].map(id=>[id,{textContent:''}])),cache=new Map();
  class FixedDate extends Date{static now(){return NOW;}}
  const context={console,Date:FixedDate,Map,Set,Number,Math,JSON,String,Array,RegExp,MarketHeatModel:M,module:{exports:{}},localStorage:{setItem:(k,v)=>cache.set(k,v),getItem:k=>cache.get(k)||null},document:{readyState:'loading',getElementById:id=>elements.get(id)||null,addEventListener(){}}};context.globalThis=context;vm.runInNewContext(uiSource,context);return{api:context.module.exports,elements,cache};
}
test('retained scores identify the attempted closed day and exact unavailable inputs',()=>{
  const old=build(fixture(90)),p=payload();assert.equal(p.asOf,PREVIOUS);assert.equal(p.series.length,60);assert.deepEqual(p.series,old.series);
  assert.equal(p.refreshStatus.targetDate,LATEST);assert.equal(p.refreshStatus.latestClosedDate,PREVIOUS);assert.equal(p.refreshStatus.pending,true);
  assert.deepEqual(p.refreshStatus.blockedBy,['ma20','ma60','ma120','newHighLowBalance']);assert.equal(p.refreshStatus.rejectedIncompleteDates,1);
  assert.equal(p.series.at(-1).coveragePct,100);assert.equal(M.MIN_COVERAGE,85);assert.equal(p.series.at(-1).score,50);
});
test('completion advances the date without a false pending warning or altered scoring rules',()=>{
  const p=payload(false),{api}=ui();assert.equal(p.asOf,LATEST);assert.equal(p.series.length,60);assert.equal(p.series.at(-1).score,50);
  assert.equal(p.refreshStatus.pending,false);assert.equal(p.refreshStatus.targetDate,LATEST);assert.deepEqual(p.refreshStatus.blockedBy,[]);
  const parsed=api.normalizePayload(p,NOW);assert.ok(parsed);assert.equal(api.refreshMessage(parsed.meta.refreshStatus,LATEST),'');
});
test('live intraday input never becomes a closing score or a pending closing target',()=>{
  const old=build(fixture(90)),input=fixture();Object.assign(input.quality.series.at(-1),{status:'live',asOf:'10:00'});
  const computed=build(input);assert.equal(computed.series.at(-1).date,PREVIOUS);
  const p=M.retainPublished(old,computed,{nowMs:NOW});assert.equal(p.asOf,PREVIOUS);assert.equal(p.refreshStatus.targetDate,PREVIOUS);assert.equal(p.refreshStatus.pending,false);
  const live={...clone(old.series.at(-1)),date:LATEST,status:'live',asOf:'10:00'};computed.series.push(live);
  const defensive=M.retainPublished(old,computed,{nowMs:NOW});assert.equal(defensive.refreshStatus.targetDate,PREVIOUS);assert.ok(defensive.series.every(row=>row.status==='close'));
});
test('legacy snapshots without refresh state or without a target date stay compatible',()=>{
  const {api}=ui(),p=payload(false);delete p.refreshStatus;let parsed=api.normalizePayload(p,NOW);assert.ok(parsed);assert.equal(parsed.meta.refreshStatus,null);
  p.refreshStatus={latestClosedDate:LATEST,rejectedIncompleteDates:0,mode:'close_only',note:'legacy'};parsed=api.normalizePayload(p,NOW);assert.ok(parsed);assert.equal(parsed.meta.refreshStatus,null);
});
test('future, preclose, impossible and unrecognized refresh metadata is discarded without losing valid scores',()=>{
  const {api}=ui();for(const mutate of [s=>s.targetDate='2099-01-01',s=>s.targetDate=DAYS[91],s=>s.targetDate='2026-02-30',s=>s.targetDate='<img src=x onerror=alert(1)>',s=>s.latestClosedDate=LATEST,s=>s.blockedBy=['<script>bad()</script>'],s=>s.blockedBy=['constructor'],s=>s.blockedBy=['ma20','ma20'],s=>s.blockedBy='ma20',s=>s.pending=false,s=>s.rejectedIncompleteDates=-1]){
    const p=payload();mutate(p.refreshStatus);const parsed=api.normalizePayload(p,NOW);assert.ok(parsed);assert.equal(parsed.meta.refreshStatus,null);
  }
});
test('pending diagnostics use trusted labels, survive local caching and are visible beside the retained score',()=>{
  const p=payload(),view=ui();p.refreshStatus.note='<img src=x onerror=alert(1)>';
  assert.equal(view.api.acceptPayload(p,{now:NOW}),true);
  assert.match(view.elements.get('marketHeatDate').textContent,/待更新至/);assert.match(view.elements.get('marketHeatCoverage').textContent,new RegExp(LATEST));assert.match(view.elements.get('marketHeatCoverage').textContent,/20日均线广度/);assert.match(view.elements.get('marketHeatFooter').textContent,/保留最近有效收盘评分/);
  assert.doesNotMatch(view.elements.get('marketHeatCoverage').textContent,/<img|onerror/);
  const cached=JSON.parse([...view.cache.values()][0]);assert.equal(cached.refreshStatus.targetDate,LATEST);assert.deepEqual(cached.refreshStatus.blockedBy,['ma20','ma60','ma120','newHighLowBalance']);assert.equal(cached.refreshStatus.note,undefined);
  const restored=ui();assert.equal(restored.api.acceptPayload(cached,{now:NOW,fromCache:true,persist:false}),true);assert.match(restored.elements.get('marketHeatCoverage').textContent,/等待/);
  const complete=payload(false);complete.updatedAt=new Date(NOW).toISOString();assert.equal(view.api.acceptPayload(complete,{now:NOW}),true);assert.doesNotMatch(view.elements.get('marketHeatCoverage').textContent,/等待|保留最近/);assert.doesNotMatch(view.elements.get('marketHeatDate').textContent,/待更新至/);
});
test('freshness metadata is not applied to a newer retained row from another response',()=>{
  const view=ui(),complete=payload(false);complete.updatedAt=new Date(NOW-120000).toISOString();assert.equal(view.api.acceptPayload(complete,{now:NOW,persist:false}),true);
  assert.equal(view.api.acceptPayload(payload(),{now:NOW,persist:false}),true);assert.equal(view.api.orderedRows().at(-1).date,LATEST);assert.doesNotMatch(view.elements.get('marketHeatCoverage').textContent,/等待/);
});
