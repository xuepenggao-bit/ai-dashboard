const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const file=process.env.MA_BREADTH_UI||path.join(__dirname,'../assets/ma-breadth.js');
const source=fs.readFileSync(file,'utf8');
const today='2026-10-14',previous='2026-10-13',now=Date.parse(today+'T10:15:00+08:00');
function context(options={}){
  const saved=new Map(),requests=[];let dailyCount=0,active=0,maxActive=0;
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const ctx=vm.createContext({module:{exports:{}},window:{},Date:FakeDate,Map,Set,Promise,Number,Math,Error,
    localStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>{if(options.storageBlocked)throw Error('blocked');saved.set(key,value);}},
    console:{warn(){}},setTimeout,clearTimeout,
    _idxFetch:async url=>{requests.push(url);return await options.fetch(url);},
    _hl52Daily:async(code,count)=>{dailyCount++;active++;maxActive=Math.max(active,maxActive);
      try{await Promise.resolve();if(!options.daily)throw Error('daily absent');return await options.daily(code,count);}finally{active--;}}
  });
  vm.runInContext(source,ctx);return{api:ctx.module.exports,window:ctx.window,ctx,saved,requests,dailyCount:()=>dailyCount,maxActive:()=>maxActive};
}
function stock(code='sh600000',overrides={}){return{code,lastDate:previous,close:10,priorSums:{20:190,60:590,120:1190},...overrides};}
function baseline(stocks=[stock()],overrides={}){return{schemaVersion:1,windows:[20,60,120],updatedAt:previous+'T18:00:00+08:00',asOfDate:previous,stocks,...overrides};}
function quote(overrides={}){return{price:12,previous:10,volume:100,date:today,time:'10:14',...overrides};}
function point(overrides={}){return{date:previous,asOf:'15:00',status:'close',universe:100,windows:{20:{above:50,eligible:100,pct:50},60:{above:40,eligible:100,pct:40},120:{above:30,eligible:100,pct:30}},...overrides};}
function payload(series=[point()],overrides={}){return{schemaVersion:1,windows:[20,60,120],updatedAt:previous+'T18:00:00+08:00',source:'test',methodology:'test',series,...overrides};}
function plain(value){return JSON.parse(JSON.stringify(value));}
function dailyCloses(count=125,value=10){
  const dates=[];let stamp=Date.parse(previous+'T00:00:00Z');
  while(dates.length<count){const d=new Date(stamp);if(d.getUTCDay()>0&&d.getUTCDay()<6)dates.push(d.toISOString().slice(0,10));stamp-=86400000;}
  return dates.reverse().map(date=>[date,String(value),String(value),String(value),String(value),'100']);
}
const cases=[];function test(name,fn){cases.push([name,fn]);}
test('normalization rejects invalid counts, missing windows, wrong percentages and future dates',()=>{
  const {api}=context();assert.ok(api.normalizeRow(point()));
  assert.equal(api.normalizeRow(point({universe:0})),null);
  assert.equal(api.normalizeRow(point({date:'2026-02-30'})),null);
  assert.equal(api.normalizeRow(point({date:'2026-10-15'})),null);
  assert.equal(api.normalizeRow(point({asOf:'25:00'})),null);
  assert.equal(api.normalizeRow(point({asOf:'09:00'})),null);
  assert.equal(api.normalizeRow(point({date:today,asOf:'15:00'})),null,'Future close cannot replace intraday data');
  for(const bad of [{above:101,eligible:100,pct:100},{above:50,eligible:100,pct:51},{above:50,eligible:100,pct:50.001},{above:0,eligible:0,pct:0},{above:'1',eligible:100,pct:1}])
    assert.equal(api.normalizeRow(point({windows:{...point().windows,20:bad}})),null);
  const empty=point({windows:{20:{above:0,eligible:0,pct:null},60:{above:0,eligible:0,pct:null},120:{above:0,eligible:0,pct:null}}});
  assert.ok(api.normalizeRow(empty),'No eligible sample remains null, never 0%');
});
test('baseline validates code uniqueness, last date, positive prices and exact windows',()=>{
  const {api}=context();assert.equal(api.validBaseline(baseline()),true);
  for(const b of [baseline([],{}),baseline([stock(),stock()]),baseline([stock('bk1234')]),baseline([stock('sh600000',{close:NaN})]),
    baseline([stock('sh600000',{lastDate:today})]),baseline([stock('sh600000',{priorSums:{20:190,60:undefined,120:null}})]),baseline(undefined,{windows:[20,60,100]})])
    assert.equal(api.validBaseline(b),false);
  assert.equal(api.validBaseline(baseline([stock('sz301999',{priorSums:{20:190,60:null,120:null}})])),true);
});
test('means include the current price; equality does not count as above',async()=>{
  const {api}=context();assert.equal(api.movingAverage(190,12,20),10.1);
  const b=baseline([stock('sh600000'),stock('sh600001'),stock('sh600002'),stock('sz301999',{priorSums:{20:190,60:null,120:null}})]);
  const quotes=new Map([['sh600000',quote()],['sh600001',quote({price:10})],['sh600002',quote({price:10,volume:0})],['sz301999',quote({price:8})]]);
  await api.applyLive(b,quotes,today,'10:14',previous);
  const row=api.ordered().at(-1);assert.equal(row.status,'live');assert.equal(row.universe,4);
  assert.deepEqual(plain(row.windows[20]),{above:1,eligible:3,pct:33.3333});
  assert.deepEqual(plain(row.windows[60]),{above:1,eligible:2,pct:50});
  assert.equal(row.windows[120].eligible,2);
});
test('missing, stale, bad-time and invalid quotes never publish a partial row',async()=>{
  for(const q of [null,quote({date:previous}),quote({price:0}),quote({previous:NaN}),quote({volume:-1}),quote({time:'09:29'}),quote({time:'10:25'}),quote({volume:null})]){
    const {api}=context();const map=new Map();if(q)map.set('sh600000',q);
    await assert.rejects(api.applyLive(baseline(),map,today,'10:14',previous),/报价/);assert.equal(api.ordered().length,0);
  }
});
test('previous-trading-day and current-day constraints are mandatory',async()=>{
  for(const [date,prev,b] of [[today,undefined,baseline()],[today,'2026-10-12',baseline()],[previous,'2026-10-12',baseline(undefined,{asOfDate:'2026-10-12'})],
    [today,today,baseline()]]){
    const {api}=context();await assert.rejects(api.applyLive(b,new Map([['sh600000',quote()]]),date,'10:14',prev),/上一交易日/);assert.equal(api.ordered().length,0);
  }
});
test('zero eligible samples are null, not zero percent',async()=>{
  const {api}=context();await api.applyLive(baseline(),new Map([['sh600000',quote({volume:0})]]),today,'10:14',previous);
  for(const window of [20,60,120])assert.deepEqual(plain(api.ordered().at(-1).windows[window]),{above:0,eligible:0,pct:null});
});
test('explicit zero-turnover suspension may retain its previous date without blocking active stocks',async()=>{
  const {api}=context(),b=baseline([stock('sh600000'),stock('sh600001')]);
  const quotes=new Map([['sh600000',quote()],['sh600001',quote({date:previous,time:'15:00',volume:0})]]);
  await api.applyLive(b,quotes,today,'10:14',previous);
  assert.equal(api.ordered().at(-1).windows[20].eligible,1);assert.equal(api.ordered().at(-1).windows[20].pct,100);
  quotes.get('sh600001').volume=1;
  await assert.rejects(api.applyLive(b,quotes,today,'10:14',previous),/报价/,'A stale traded quote is never treated as suspended');
  quotes.delete('sh600001');
  await assert.rejects(api.applyLive(b,quotes,today,'10:14',previous),/报价/,'Missing quotes remain missing, not zero turnover');
});
test('snapshot arbitration keeps newer time, close wins over live, and preserves 60 sessions',()=>{
  const {api}=context();assert.equal(api.acceptPayload(payload()),true);
  const close=api.ordered().at(-1);assert.equal(close.windows[20].pct,50);
  assert.equal(api.acceptPayload(payload([point({status:'live',asOf:'15:00',windows:{...point().windows,20:{above:99,eligible:100,pct:99}}})],{updatedAt:today+'T10:14:00+08:00'})),true);
  assert.equal(api.ordered().at(-1).windows[20].pct,50,'New revision must not overwrite close with live');
  assert.equal(api.acceptPayload(payload([point({windows:{...point().windows,20:{above:60,eligible:100,pct:60}}})],{updatedAt:previous+'T17:00:00+08:00'})),true);
  assert.equal(api.ordered().at(-1).windows[20].pct,50,'Older revision must not win');
  const days=[];for(let i=90;i>=0;i--){const date=new Date(Date.parse(previous+'T00:00:00Z')-i*86400000).toISOString().slice(0,10);days.push(point({date}));}
  api.acceptPayload(payload(days));assert.equal(api.ordered().length,60);
  const c=context();c.api.acceptPayload(payload([point({date:today,status:'live',asOf:'10:14'})],{updatedAt:today+'T10:14:00+08:00'}));
  c.api.acceptPayload(payload([point({date:today,status:'live',asOf:'10:00',windows:{...point().windows,20:{above:60,eligible:100,pct:60}}})],{updatedAt:today+'T10:15:00+08:00'}));
  assert.equal(c.api.ordered().at(-1).windows[20].pct,50,'Earlier asOf is not replaced by newer download time');
});
test('validated local cache restores without letting old responses regress it',async()=>{
  const c=context();await c.api.applyLive(baseline(),new Map([['sh600000',quote()]]),today,'10:14',previous);
  const saved=c.saved.get('aiDashboard.maBreadth.v1');const next=context({fetch:async()=>payload()});
  next.saved.set('aiDashboard.maBreadth.v1',saved);await next.api.refresh(true);
  assert.equal(next.api.ordered().at(-1).date,today);assert.equal(next.api.ordered().at(-1).windows[20].pct,100);
  const blocked=context({storageBlocked:true});await blocked.api.applyLive(baseline(),new Map([['sh600000',quote()]]),today,'10:14',previous);
  assert.equal(blocked.api.ordered().length,1,'Private browser storage failure preserves in-memory data');
});
test('baseline load chooses newest valid version and never regresses to stale CDN content',async()=>{
  const old=baseline(undefined,{asOfDate:'2026-10-12',updatedAt:'2026-10-12T18:00:00+08:00',stocks:[stock('sh600000',{lastDate:'2026-10-12'})]});
  let stale=false;const c=context({fetch:async url=>stale?old:url.startsWith('./')?old:baseline()});
  assert.equal((await c.window.loadMaBreadthBaseline(true)).asOfDate,previous);
  stale=true;assert.equal((await c.window.loadMaBreadthBaseline(true)).asOfDate,previous);
  assert.equal(c.requests.length,4);assert.ok(c.requests.every(url=>url.includes('baseline.json')),'Only snapshot data loaded, no independent quote scan');
});
test('ex-dividend correction recomputes sums, verifies previous close and caps concurrency at four',async()=>{
  const stocks=Array.from({length:9},(_,i)=>stock('sh'+(600000+i),{close:11}));
  const c=context({daily:async()=>dailyCloses()});
  await c.api.applyLive(baseline(stocks),new Map(stocks.map(s=>[s.code,quote()])),today,'10:14',previous);
  assert.equal(c.api.ordered().at(-1).windows[120].pct,100);assert.equal(c.dailyCount(),9);assert.ok(c.maxActive()<=4);
  await c.api.applyLive(baseline(stocks),new Map(stocks.map(s=>[s.code,quote({price:9})])),today,'10:15',previous);
  assert.equal(c.dailyCount(),9,'Same-day verified adjusted basis is reused');assert.equal(c.api.ordered().at(-1).windows[120].pct,0);
  for(const daily of [()=>dailyCloses(125,9),()=>{throw Error('network failed');},()=>dailyCloses().reverse(),()=>[...dailyCloses().slice(0,-1)]]){
    const bad=context({daily:async()=>daily()});await assert.rejects(bad.api.applyLive(baseline([stock('sh600000',{close:11})]),new Map([['sh600000',quote()]]),today,'10:14',previous));
    assert.equal(bad.api.ordered().length,0,'A failed stock does not yield a partial full-market total');
  }
});
test('short adjusted daily history excludes only unavailable windows',async()=>{
  const c=context({daily:async()=>dailyCloses(30)});
  await c.api.applyLive(baseline([stock('sh600000',{close:11})]),new Map([['sh600000',quote()]]),today,'10:14',previous);
  const row=c.api.ordered().at(-1);assert.equal(row.windows[20].pct,100);assert.equal(row.windows[60].pct,null);assert.equal(row.windows[120].pct,null);
});
test('negative adjusted historical prices and negative means are valid finite prices',async()=>{
  const c=context();const b=baseline([stock('sh600000',{priorSums:{20:-190,60:-590,120:-1190}})]);
  assert.equal(c.api.validBaseline(b),true);
  await c.api.applyLive(b,new Map([['sh600000',quote()]]),today,'10:14',previous);
  assert.equal(c.api.ordered().at(-1).windows[120].pct,100);
  const daily=dailyCloses(125,-10);daily.at(-1)[2]='10';
  const d=context({daily:async()=>daily});
  await d.api.applyLive(baseline([stock('sh600000',{close:11})]),new Map([['sh600000',quote()]]),today,'10:14',previous);
  assert.equal(d.api.ordered().at(-1).windows[120].pct,100,'Recomputed negative mean is not treated as missing');
});
test('strict above comparison matches backend even for a tiny positive difference',async()=>{
  const c=context();await c.api.applyLive(baseline(),new Map([['sh600000',quote({price:10+1e-11})]]),today,'10:14',previous);
  assert.equal(c.api.ordered().at(-1).windows[20].above,1,'No separate frontend epsilon threshold');
});
test('shared ex-dividend rows are reused without a duplicate daily request',async()=>{
  const c=context();await c.api.applyLive(baseline([stock('sh600000',{close:11})]),new Map([['sh600000',quote({adjustedRows:dailyCloses()})]]),today,'10:14',previous);
  assert.equal(c.dailyCount(),0);assert.equal(c.api.ordered().at(-1).windows[120].pct,100);
});
test('chart fixes percent axis and keeps styles distinct without a second quote scanner',()=>{
  assert.match(source,/y:\{min:0,max:100/);assert.match(source,/getPixelForValue\(50\)/);assert.match(source,/DASHES=\[\[\],\[7,4\],\[2,4\]\]/);
  assert.doesNotMatch(source,/qt\.gtimg\.cn\/q=/);assert.match(source,/requestAnimationFrame\(\(\)=>chart\.resize\(\)\)/);
});
module.exports=(async()=>{
  for(const [name,fn] of cases){await fn();console.log('PASS:',name);}
  return 'PASS: '+cases.length+' moving-average breadth tests';
})();
