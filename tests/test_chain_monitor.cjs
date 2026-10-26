const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../assets/chain-monitor.js');
const today=m.beijingDay(),period=m.expectedReportDate(today);
function stock(overrides={}){
  return {code:'300308',group:'optical',name:'测试公司',reportDate:period,
    financials:{current:{revenue:130,netProfit:30,deductedProfit:28,operatingCashFlow:22},
      previous:{revenue:100,netProfit:20,deductedProfit:20,operatingCashFlow:18},yoy:{revenue:30,netProfit:50,deductedProfit:40},
      q1:{revenue:60,previous:{revenue:50},yoy:{revenue:20}},q2:{revenue:70,previous:{revenue:50},yoy:{revenue:40}},ttm:{netProfit:5e8,deductedProfit:4.5e8}},
    quote:{date:today,price:10,capYi:100,peTtm:200},...overrides};
}
test('PE uses disclosed trailing earnings not dynamic or stale vendor multiple',()=>{
  assert.equal(m.stockPE(stock()),20);
  const s=stock();s.financials.ttm.netProfit=-1;assert.equal(m.stockPE(s),null);
});
test('candidate requires growth, cash conversion, acceleration and peer valuation',()=>{
  assert.equal(m.classify(stock(),25).key,'candidate');
  assert.equal(m.classify(stock(),15).key,'valuation');
  const s=stock();s.financials.current.operatingCashFlow=3;assert.equal(m.classify(s,25).key,'verify');
  s.financials.current.operatingCashFlow=22;s.financials.q2.yoy.revenue=10;assert.equal(m.classify(s,25).key,'verify');
});
test('negative bases and missing financials never produce normal growth signals',()=>{
  const s=stock();s.financials.previous.deductedProfit=-1;s.financials.yoy.deductedProfit=2900;
  assert.equal(m.growth(s,'deductedProfit'),null);assert.notEqual(m.classify(s,30).key,'candidate');
  delete s.financials.previous;assert.equal(m.growth(s,'revenue'),null);
});
test('stale reports and old prices cannot be research candidates',()=>{
  assert.equal(m.classify(stock({reportDate:'2020-06-30'}),30).key,'missing');
  const s=stock();s.quote.date='2020-01-01';assert.equal(m.classify(s,30).label,'等待新行情');
});
test('one-off earnings and current losses are distinguished from missing evidence',()=>{
  const s=stock();s.financials.ttm.deductedProfit=1e8;assert.equal(m.classify(s,25).key,'verify');
  s.financials.current.deductedProfit=-1;s.financials.previous.deductedProfit=-2;
  assert.equal(m.classify(s,25).label,'等待盈利拐点');
  s.financials.current.deductedProfit=1;assert.equal(m.classify(s,25).label,'扭亏待确认');
});
test('sector medians exclude losses and mixed financial periods',()=>{
  const a=stock(),b=stock({code:'300502'}),c=stock({code:'300394',reportDate:'2020-06-30'});
  b.financials.previous.deductedProfit=-1;b.financials.current.deductedProfit=-2;b.financials.ttm.netProfit=-1;
  const g=m.groupsOf({groups:[{id:'optical',name:'光模块',codes:['300308','300502','300394']}],stocks:[a,b,c]})[0];
  assert.equal(g.coverage,2);assert.equal(g.peCount,1);assert.equal(g.profit,null);assert.equal(g.profitCount,1);assert.equal(g.profitable,1);
});
test('quote parser validates symbol and timestamp, rejects future and stale prices',()=>{
  const s=stock(),date=today.replaceAll('-',''),fields=Array(90).fill('');
  fields[2]='300308';fields[3]='50';fields[30]=date+'150000';fields[44]='90';fields[45]='150';fields[32]='1.2';
  const txt='v_sz300308="'+fields.join('~')+'";';
  const result=m.parseQuotes(txt,{stocks:[s]},today,date+'235959')[0];assert.equal(result.quote.price,50);assert.equal(result.quote.peTtm,30);
  fields[30]='20990101150000';assert.equal(m.parseQuotes('v_sz300308="'+fields.join('~')+'";',{stocks:[s]},today)[0].quote.price,10);
  fields[30]=date+'150000';fields[2]='000001';assert.equal(m.parseQuotes('v_sz300308="'+fields.join('~')+'";',{stocks:[s]},today)[0].quote.price,10);
});
test('ISO snapshot timestamps and browser compact timestamps compare chronologically',()=>{
  assert.equal(m.quoteStamp({dateTime:'2026-10-09T11:30:00+08:00'}),'20261009113000');
  assert.ok(m.quoteStamp({dateTime:'2026-10-10T09:35:00+08:00'})>m.quoteStamp({dateTime:'20261009150000'}));
});
test('expected reporting windows do not demand a quarter before required release',()=>{
  assert.equal(m.expectedReportDate('2026-10-09'),'2026-06-30');assert.equal(m.expectedReportDate('2026-11-01'),'2026-09-30');
  assert.equal(m.expectedReportDate('2026-07-01'),'2026-03-31');
});
test('newly reported latest quarter replaces old Q1/Q2 trend in analysis',()=>{
  const s=stock();s.financials.previousQuarter={period:'2026Q2',previous:{revenue:100},yoy:{revenue:40}};
  s.financials.latestQuarter={period:'2026Q3',previous:{revenue:100},yoy:{revenue:10}};
  const a=m.classify(s,25);assert.equal(a.q1,40);assert.equal(a.q2,10);assert.equal(a.accelerating,false);
});
test('growth sorts descending and PE ascending without changing the source order',()=>{
  const groups=[{id:'missing',revenue:null,pe:null},{id:'slow',revenue:-5,pe:40},{id:'fast',revenue:50,pe:20},{id:'equal',revenue:50,pe:20},{id:'flat',revenue:0,pe:30}];
  assert.deepEqual(m.sortGroups(groups,'revenue',-1).map(g=>g.id),['fast','equal','flat','slow','missing']);
  assert.deepEqual(m.sortGroups(groups,'pe').map(g=>g.id),['fast','equal','flat','slow','missing']);
  assert.equal(groups[0].id,'missing');
  assert.deepEqual(m.sortGroups([{id:'invalid',pe:NaN},{id:'number',pe:5},{id:'empty',pe:''}],'pe').map(g=>g.id),['number','invalid','empty']);
});
test('sample market cap sums total company cap only when every sample has a fresh valid quote',()=>{
  const a=stock(),b=stock({code:'300502'});b.quote.capYi=250;
  const input={groups:[{id:'optical',codes:['300308','300502']}],stocks:[a,b]};
  assert.equal(m.groupsOf(input)[0].marketCapYi,350);assert.equal(m.groupsOf(input)[0].capCoverage,2);
  b.quote.capYi=null;assert.equal(m.groupsOf(input)[0].marketCapYi,null);
  b.quote.capYi=250;b.quote.date='2020-01-01';assert.equal(m.groupsOf(input)[0].marketCapYi,null);
  input.stocks=[a,a];assert.equal(m.groupsOf(input)[0].marketCapYi,null);
});
test('bubble area is proportional to sample market cap with no minimum-radius distortion',()=>{
  const small=m.bubbleRadius(100,400),large=m.bubbleRadius(400,400);
  assert.equal(large,40);assert.equal(small,20);assert.equal(large**2/small**2,4);
  assert.ok(m.bubbleRadius(1,400)<small);
  assert.equal(m.bubbleRadius(null,400),0);assert.equal(m.bubbleRadius(-1,400),0);assert.equal(m.bubbleRadius(100,0),0);
});
test('qualitative research is dated, covers all groups and keeps previous underwriting',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const read=relative=>JSON.parse(fs.readFileSync(path.join(__dirname,'../',relative)));
  const r=read('data/chain_research.json'),monitor=read('data/chain_monitor.json');
  const expectedIds=monitor.groups.map(g=>g.id).sort();
  assert.equal(m.validResearch(r,today),true);
  assert.equal(expectedIds.length,10);
  assert.deepEqual(r.groups.map(g=>g.id).sort(),expectedIds);
  for(const group of r.groups){
    for(const field of ['fact','industry','valuationJudgment','catalyst','falsifier']){
      assert.ok(typeof group[field]==='string'&&group[field].trim(),`${group.id}.${field} must be meaningful text`);
    }
    assert.ok(group.sources.length>0,`${group.id} must have a dated source`);
  }
  assert.match(r.previousRevision.path,/^data\/chain_research_history\/[a-zA-Z0-9._-]+\.json$/);
  const previous=read(r.previousRevision.path);
  assert.equal(previous.asOf,r.previousRevision.asOf);
  assert.ok(previous.asOf<r.asOf,'the archived research must predate the current review');
  assert.equal(m.validResearch(previous,r.asOf),true);
  assert.deepEqual(previous.groups.map(g=>g.id).sort(),expectedIds);
});
function researchFixture(asOf='2020-10-14',revision='a'){
  return {schemaVersion:1,asOf,revision,
    groups:Array.from({length:10},(_,i)=>({id:'sector-'+i,fact:'Disclosed operating evidence',sources:[{url:'https://example.com/report',date:asOf}]})),
    marketContext:[{title:'Market context',fact:'Dated market evidence',sources:[{url:'https://example.com/context',date:asOf}]}]};
}
function shiftDay(date,days){return new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);}
test('future, incomplete, duplicate or future-sourced research cannot replace a valid review',()=>{
  const r=researchFixture(),reviewDay=r.asOf,nextDay=shiftDay(reviewDay,1);
  assert.equal(m.validResearch(r,reviewDay),true);
  assert.equal(m.validResearch(null,reviewDay),false);
  assert.equal(m.validResearch(researchFixture(nextDay),reviewDay),false);
  assert.equal(m.validResearch({...r,groups:[]},reviewDay),false);
  const duplicate=structuredClone(r);duplicate.groups[1].id=duplicate.groups[0].id;
  assert.equal(m.validResearch(duplicate,reviewDay),false);
  const future=structuredClone(r);future.groups[0].sources[0].date=nextDay;
  assert.equal(m.chooseResearch(r,future,reviewDay),r);
  const context=structuredClone(r);context.marketContext[0].sources[0].date=nextDay;
  assert.equal(m.validResearch(context,reviewDay),false);
});
test('older financial snapshot cannot overwrite newer qualitative research',()=>{
  const fresh=researchFixture(),reviewDay=fresh.asOf,old=researchFixture(shiftDay(reviewDay,-1));
  assert.equal(m.chooseResearch(fresh,old,reviewDay),fresh);
  assert.equal(m.chooseResearch(old,fresh,reviewDay),fresh);
  assert.equal(m.chooseResearch(fresh,undefined,reviewDay),fresh);
  const later={...fresh,revision:'b'};
  assert.equal(m.chooseResearch(fresh,later,reviewDay),later);
  assert.equal(m.chooseResearch(later,fresh,reviewDay),later);
});
test('research valuation requires two positive TTM samples rather than one-stock industry PE',()=>{
  const a=stock(),g={stocks:[a],pe:20,peCount:1,total:2};
  assert.equal(m.researchValuation(g).pe,null);assert.equal(m.researchValuation(g).coverage,1);
  g.peCount=2;g.total=3;g.stocks.push(stock({code:'300502'}));
  assert.equal(m.researchValuation(g).pe,20);assert.equal(m.researchValuation(g).date,today);
});
