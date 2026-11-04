const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const m=require('../assets/broker-forecasts.js');
const NOW=Date.parse('2026-11-04T15:00:00+08:00'),YEAR=2026;
const clone=x=>JSON.parse(JSON.stringify(x));
function report(i,value=i+1,extra={}){return {id:'report-'+i,broker:'券商'+i,title:'季度研究 '+i,publishedAt:'2026-11-0'+(4-i),forecastYear:YEAR,currency:'CNY',profitYi:value,url:'https://example.com/reports/'+i,...extra};}
function entry(values=[10,20,30],extra={}){return {market:'A',code:'300308',forecastYear:YEAR,currency:'CNY',metric:'parent_net_profit',meanProfitYi:values.reduce((a,b)=>a+b,0)/values.length,reportCount:values.length,reports:values.map((v,i)=>report(i,v)),status:'ok',updatedAt:'2026-11-04T13:00:00+08:00',lastChecked:'2026-11-04T14:00:00+08:00',...extra};}
function snapshot(e=entry(),extra={}){return {schemaVersion:1,targetYear:YEAR,lastChecked:'2026-11-04T14:00:00+08:00',generatedAt:'2026-11-04T14:00:00+08:00',stocks:{'A:300308':e},...extra};}
test('A/H securities resolve to matched A reports, not their HK ordinary-profit estimates',()=>{
 assert.equal(m.resolveKey({mkt:'SZ',code:'300308'},{}),'A:300308');
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{source:'AH',aShareCode:'300308'}),'A:300308');
 assert.equal(m.resolveKey({mkt:'HK',code:'3308'},{},{'03308':{aCode:'300308'}}),'A:300308');
 assert.equal(m.resolveKey({mkt:'HK',code:'3308'},{aShareCode:'bad'},{'03308':{aCode:'300308'}}),'A:300308');
 assert.equal(m.resolveKey({mkt:'HK',code:'700'},{source:'HK'}),'HK:00700');
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{source:'AH'}),null);
 assert.equal(m.resolveKey({mkt:'HK',code:'bad'},{}),null);
});
test('fewer than five reports average every valid supplied report without padding',()=>{
 const e=entry([10,20,36]),checked=m.validateEntry(e,'A:300308',YEAR,NOW);assert.equal(checked.valid,true);assert.equal(checked.count,3);assert.equal(checked.mean,22);
 const html=m.renderCell({mkt:'HK',code:'03308'},{aShareCode:'300308'},snapshot(e),NOW);assert.match(html,/22\.00/);assert.match(html,/2026 · CNY · 3家 · A股300308/);assert.equal((html.match(/<li /g)||[]).length,3);
});
test('snapshot lookup routes A/H broker data before financial API returns, without overriding live identities',()=>{
 const d=snapshot(entry([11,15]),{lookup:{'HK:03308':'A:300308'}});
 const html=m.renderCell({mkt:'HK',code:'03308'},{},d,NOW);assert.match(html,/13\.00/);assert.match(html,/A股300308/);
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{aShareCode:'300502'},null,d.lookup),'A:300502');
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{},{'03308':{aCode:'300502'}},d.lookup),'A:300502');
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{},{},d.lookup),'HK:03308');
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{source:'HK'},null,d.lookup),'HK:03308');
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{source:'AH'},null,{'HK:03308':'HK:00700'}),null);
 assert.equal(m.resolveKey({mkt:'HK',code:'03308'},{source:'AH'},null,{'HK:03308':'A:bad'}),null);
});
test('five actual forecasts including genuine zero and loss values remain valid',()=>{
 const e=entry([0,-4,4,10,20]);e.reports[4].publishedAt='2026-10-31';const checked=m.validateEntry(e,'A:300308',YEAR,NOW);assert.equal(checked.valid,true);assert.equal(checked.mean,6);
 const zero=entry([0]);assert.equal(m.validateEntry(zero,'A:300308',YEAR,NOW).valid,true);assert.match(m.renderCell({mkt:'SZ',code:'300308'},{},snapshot(zero),NOW),/>0\.00</);
});
test('counts, duplicate prediction ids and duplicate institutions cannot inflate the mean',()=>{
 for(const alter of [e=>e.reportCount=5,e=>e.reports.push(report(3)),e=>e.reports[1].id=e.reports[0].id,e=>e.reports[1].broker=e.reports[0].broker,e=>e.meanProfitYi=900]){
  const e=entry();alter(e);assert.equal(m.validateEntry(e,'A:300308',YEAR,NOW).valid,false);
 }
});
test('distinct institutions may share one provider detail URL without losing valid forecasts',()=>{
 const e=entry([10,20,30],{sourceType:'provider_broker_detail'});e.reports.forEach(r=>{r.url='https://example.com/f10/300308';delete r.title;r.publishedAtType='provider_updated_at';});
 const checked=m.validateEntry(e,'A:300308',YEAR,NOW);assert.equal(checked.valid,true);assert.equal(checked.mean,20);
 const html=m.renderCell({mkt:'SZ',code:'300308'},{},snapshot(e),NOW);assert.match(html,/20\.00/);assert.match(html,/3家/);assert.match(html,/数据商摘录的机构预测明细，非逐份原始PDF核验/);assert.match(html,/预测明细/);assert.doesNotMatch(html,/研报明细/);
});
test('forecast year, metric, security and currency identity must agree',()=>{
 for(const alter of [e=>e.forecastYear=2027,e=>e.market='HK',e=>e.code='300502',e=>e.metric='eps',e=>e.currency='unknown',e=>e.reports[0].forecastYear=2025,e=>e.reports[0].currency='USD',e=>e.reports[0].profitYi=null]){
  const e=entry();alter(e);assert.equal(m.validateEntry(e,'A:300308',YEAR,NOW).valid,false);
 }
});
test('future publication days and times, invalid dates and unsafe sources stay out',()=>{
 for(const change of [{publishedAt:'2026-11-05'},{publishedAt:'2026-11-04T15:06:00+08:00'},{publishedAt:'2026-02-31'},{publishedAt:''},{url:'javascript:alert(1)'},{url:'http://example.com/old'},{url:'https://user:password@example.com/x'},{broker:''}]){
  const e=entry();Object.assign(e.reports[0],change);assert.equal(m.validateEntry(e,'A:300308',YEAR,NOW).valid,false);
 }
});
test('unknown and no-report values are honest gaps, never fabricated zero predictions',()=>{
 const missing=entry([],{meanProfitYi:null,status:'no_reports'}),html=m.renderCell({mkt:'SZ',code:'300308'},{},snapshot(missing),NOW);assert.match(html,/暂无有效预测/);assert.doesNotMatch(html,/0\.00/);
 assert.equal(m.validateEntry({...missing,meanProfitYi:0},'A:300308',YEAR,NOW).valid,false);
 assert.match(m.renderCell({mkt:'SZ',code:'300502'},{},snapshot(),NOW),/暂无有效预测/);
 assert.match(m.renderCell({mkt:'SZ',code:'300308'},{},null,NOW),/2026年券商预测待更新/);
});
test('failed source can retain dated valid cached observations but cannot appear fresh',()=>{
 const e=entry([10,20],{status:'source_error'}),html=m.renderCell({mkt:'SZ',code:'300308'},{},snapshot(e),NOW);assert.match(html,/15\.00/);assert.match(html,/上次有效缓存/);
 const absent=entry([],{meanProfitYi:null,status:'source_error'});assert.match(m.renderCell({mkt:'SZ',code:'300308'},{},snapshot(absent),NOW),/预测源暂不可达/);
});
test('the calendar-year rollover hides previous-year values instead of relabelling them',()=>{
 const next=Date.parse('2027-01-01T00:01:00+08:00'),html=m.renderCell({mkt:'SZ',code:'300308'},{},snapshot(entry([999])),next);assert.match(html,/2027年预测待更新/);assert.doesNotMatch(html,/999\.00/);
 assert.equal(m.currentYear(Date.parse('2026-12-31T16:01:00Z')),2027);
});
test('report rendering is escaped, source-linked, latest-first and independent of mechanical profits',()=>{
 const e=entry([10,30]);e.reports.reverse();e.reports[0].broker='<img src=x onerror=alert(1)>';e.reports[0].title='<script>alert(1)</script>';const before=JSON.stringify(e);
 const html=m.renderCell({mkt:'SZ',code:'300308'},{annualProfit:999999,predRate:999},snapshot(e),NOW);
 assert.match(html,/20\.00/);assert.doesNotMatch(html,/<img|<script>|999999/);assert.match(html,/&lt;img/);assert.match(html,/noopener noreferrer/);assert.match(html,/非扣非机械估算/);assert.match(html,/不替换左侧机械预测或预测PE/);assert.equal(JSON.stringify(e),before);
 assert.ok(html.indexOf('券商0')<html.indexOf('&lt;img'));
});
test('pure HK forecasts keep their own verified currency rather than inheriting A data',()=>{
 const hk=entry([7,9],{market:'HK',code:'00700',currency:'HKD',metric:'net_profit'});hk.reports.forEach(r=>{r.currency='HKD';r.dateType='provider_updated_at';r.periodBasis='fiscal_year_as_labelled';});
 const html=m.renderCell({mkt:'HK',code:'00700'},{source:'HK',currency:'CNY'},snapshot(hk,{stocks:{'HK:00700':hk}}),NOW);assert.match(html,/8\.00/);assert.match(html,/2026 · HKD · 2家/);assert.match(html,/纯利\/亏损（来源口径）/);assert.match(html,/2026财年（来源口径）/);assert.match(html,/预测更新日/);
 assert.equal(m.validateEntry(entry([7,9],{metric:'net_profit'}),'A:300308',YEAR,NOW).valid,false);
});
test('one invalid stock cannot clear another valid row or modify the provided snapshot',()=>{
 const valid=entry([4,6]),bad=entry([8,10],{code:'300502',meanProfitYi:999}),d=snapshot(valid,{stocks:{'A:300308':valid,'A:300502':bad}}),before=JSON.stringify(d);
 assert.match(m.renderCell({mkt:'SZ',code:'300308'},{},d,NOW),/5\.00/);assert.match(m.renderCell({mkt:'SZ',code:'300502'},{},d,NOW),/预测待校验/);assert.equal(JSON.stringify(d),before);
});
test('latest provider prediction date is visible separately from background check date',()=>{
 const e=entry([10,20]);e.reports[0].publishedAt='2026-10-21';e.reports[1].publishedAt='2026-09-08';
 const html=m.renderCell({mkt:'SZ',code:'300308'},{},snapshot(e),NOW);assert.match(html,/最新预测 2026-10-21/);assert.match(html,/后台核验 2026-11-04/);assert.doesNotMatch(html,/最新预测 2026-11-04/);
});
test('module boot is lazy, non-blocking, single-flight and retains working data on fetch failure',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../assets/broker-forecasts.js'),'utf8'),classes=new Set(),handlers={},intervals=[];let observer,fetches=0,release,fail=false,redraws=0;
 const tab={classList:{contains:c=>classes.has(c)}},doc={hidden:false,getElementById:id=>id==='tVal'?tab:null,querySelectorAll:()=>[],addEventListener:(n,f)=>handlers[n]=f};
 const c=vm.createContext({Date,URL,AbortController,console,setTimeout,clearTimeout,setInterval:f=>intervals.push(f),document:doc,MutationObserver:class{constructor(f){observer=f;}observe(){}},renderValTable:()=>redraws++,fetch:async()=>{fetches++;await new Promise(r=>release=r);if(fail)throw Error('network');return {ok:true,json:async()=>snapshot()};}});
 vm.runInContext(source,c);assert.equal(fetches,0);classes.add('active');observer();assert.equal(fetches,1);const inFlight=c.BrokerForecasts.refresh(true);assert.equal(fetches,1);release();await inFlight;assert.equal(redraws,1);assert.equal(c.BrokerForecasts.getData().targetYear,YEAR);
 const before=c.BrokerForecasts.getData();fail=true;const second=c.BrokerForecasts.refresh(true);release();await second;assert.equal(c.BrokerForecasts.getData(),before);assert.equal(fetches,2);
 doc.hidden=true;intervals[0]();assert.equal(fetches,2);
});
test('a synchronous fetch error never leaves the module permanently in-flight',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../assets/broker-forecasts.js'),'utf8');let fetches=0;
 const c=vm.createContext({Date,URL,AbortController,setTimeout,clearTimeout,console:{warn(){}},fetch:()=>{fetches++;throw Error('not ready');}});vm.runInContext(source,c);
 await c.BrokerForecasts.refresh(true);await c.BrokerForecasts.refresh(true);assert.equal(fetches,2);
});
