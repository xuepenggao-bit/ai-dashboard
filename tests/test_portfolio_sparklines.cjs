const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Model=require('../assets/portfolio-sparklines.js');
const source=fs.readFileSync(path.join(__dirname,'../assets/portfolio-sparklines.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const ts=(date='2026-11-05',time='10:20:00')=>Date.parse(date+'T'+time+'+08:00');
const NOW=ts(),KEY='sz300308',HK='hk00700';
const clone=x=>JSON.parse(JSON.stringify(x));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const state=(extra={})=>({calendarKnown:true,isClosed:false,date:'2026-11-05',phase:'continuous',status:'trading_day',closeMinute:900,...extra});
function row(key=KEY,date='2026-11-05',time='1015',price=102){
  return{key,date,previousClose:100,points:[{time:'0930',price:100},{time,price}],source:'腾讯财经'};
}
function tencent(key=KEY,date='2026-11-05',time='1015',price=102){
  const qt=Array(81).fill('');qt[2]=key.slice(2);qt[4]='100';
  qt[30]=key.startsWith('hk')?date.replaceAll('-','/')+' '+time.slice(0,2)+':'+time.slice(2)+':00':date.replaceAll('-','')+time+'00';
  return{code:0,data:{[key]:{data:{date:date.replaceAll('-',''),data:['0930 100.00 100',time+' '+price+' 300']},qt:{[key]:qt}}}};
}
function eastmoney(key=KEY,date='2026-11-05',time='1015',price=102){
  return{rc:0,data:{code:key.slice(2),market:key.startsWith('hk')?116:key.startsWith('sh')?1:0,preClose:100,
    trends:[date+' 09:30,97,100,105,95,100,10000,100',date+' '+time.slice(0,2)+':'+time.slice(2)+',96,'+price+',106,94,200,20000,101']}};
}
function store(rows){
  let data=JSON.stringify({schemaVersion:1,series:rows});let writes=0;
  return{getItem:()=>data,setItem:(key,value)=>{assert.equal(key,Model.STORE);writes++;data=value;},get writes(){return writes;}};
}

test('security identities stay market-qualified and clock is Safari-safe Beijing time',()=>{
  assert.equal(Model.keyForStock({mkt:'SH',code:'601138'}),'sh601138');
  assert.equal(Model.keyForStock({mkt:'SZ',code:'300308'}),KEY);
  assert.equal(Model.keyForStock({mkt:'HK',code:'00700'}),HK);
  for(const stock of [{mkt:'HK',code:'700'},{mkt:'NYSE',code:'123456'},{mkt:'SH',code:'601138<script>'},{}])assert.equal(Model.keyForStock(stock),null);
  assert.deepEqual(Model.clock(NOW),{date:'2026-11-05',minute:620});
  assert.equal(Model.minute('1160'),NaN);assert.equal(Model.minute('24:00'),NaN);
  assert.equal(Model.inSession(KEY,'1131'),false);assert.equal(Model.inSession(KEY,'1300'),true);
  assert.equal(Model.inSession(HK,'1200'),true);assert.equal(Model.inSession(HK,'1610'),true);
});

test('Tencent parses both A numeric timestamps and HK formatted timestamps with matched date and previous close',()=>{
  for(const key of [KEY,'sh601138',HK]){
    const parsed=Model.parseTencent(tencent(key),key,NOW);
    assert.equal(parsed.key,key);assert.equal(parsed.date,'2026-11-05');assert.equal(parsed.previousClose,100);
    assert.deepEqual(parsed.points,[{time:'0930',price:100},{time:'1015',price:102}]);
    assert.equal(parsed.quoteTimestamp,ts('2026-11-05','10:15:00'));assert.equal(parsed.source,'腾讯财经');
  }
});

test('Eastmoney reads closing price at trends field 2 rather than opening price, for A and HK',()=>{
  for(const key of [KEY,'sh601138',HK]){
    const parsed=Model.parseEastmoney(eastmoney(key),key,NOW);
    assert.equal(parsed.key,key);assert.equal(parsed.previousClose,100);assert.equal(parsed.source,'东方财富');
    assert.deepEqual(parsed.points,[{time:'0930',price:100},{time:'1015',price:102}]);
  }
});

test('provider identity, previous-close, malformed dates and future or mixed-day curves are rejected',()=>{
  const invalidTencent=[];
  const id=tencent();id.data[KEY].qt[KEY][2]='000001';invalidTencent.push(id);
  const stamp=tencent();stamp.data[KEY].qt[KEY][30]='20261104101500';invalidTencent.push(stamp);
  const empty=tencent();empty.data[KEY].data.data=[];invalidTencent.push(empty);
  const zero=tencent();zero.data[KEY].qt[KEY][4]='0';invalidTencent.push(zero);
  const late=tencent();late.data[KEY].qt[KEY][30]='20261105110000';invalidTencent.push(late);
  const impossible=tencent();impossible.data[KEY].data.date='20260230';impossible.data[KEY].qt[KEY][30]='20260230101500';invalidTencent.push(impossible);
  const ahead=tencent(KEY,'2026-11-06');invalidTencent.push(ahead);
  for(const payload of invalidTencent)assert.throws(()=>Model.parseTencent(payload,KEY,NOW));
  const wrongMarket=eastmoney();wrongMarket.data.market=116;
  const wrongCode=eastmoney();wrongCode.data.code='000001';
  const mixed=eastmoney();mixed.data.trends[1]=mixed.data.trends[1].replace('2026-11-05','2026-11-04');
  const future=eastmoney(KEY,'2026-11-05','1100');
  const zeroPrice=eastmoney(KEY,'2026-11-05','1015',0);
  const duplicate=eastmoney(KEY,'2026-11-05','0930');
  for(const payload of [wrongMarket,wrongCode,mixed,future,zeroPrice,duplicate])assert.throws(()=>Model.parseEastmoney(payload,KEY,NOW));
});

test('cache validation rejects duplicates, impossible dates, future minutes, zero prices, huge values and old snapshots',()=>{
  assert.ok(Model.validate(row(),NOW));
  const bad=[{...row(),key:'xx300308'},{...row(),date:'2026-02-30'},{...row(),date:'2026-11-06'},
    {...row(),date:'2026-10-01'},{...row(),previousClose:0},{...row(),previousClose:Infinity},
    {...row(),points:[]},{...row(),points:[{time:'1015',price:0}]},{...row(),points:[{time:'1015',price:Infinity}]},
    {...row(),points:[{time:'1015',price:10001}]},{...row(),points:[{time:'1100',price:100}]},
    {...row(),points:[{time:'1015',price:100},{time:'1015',price:101}]},
    {...row(),points:[{time:'1015',price:100},{time:'1000',price:101}]},
    {...row(),points:[{time:'1200',price:100}]}];
  for(const value of bad)assert.equal(Model.validate(value,NOW),null,JSON.stringify(value));
  const normalized=Model.validate({...row(),source:'untrusted'},NOW);assert.equal(normalized.source,'已验证分时缓存');
});

test('previous sessions never overwrite a newer or more complete cached curve',()=>{
  const client=Model.createClient({now:()=>NOW});assert.equal(client.accept(row()),true);
  assert.equal(client.accept(row(KEY,'2026-11-04','1500')),false);
  assert.equal(client.accept(row(KEY,'2026-11-05','1000')),false);
  assert.equal(client.read(KEY).points.at(-1).time,'1015');
  assert.equal(client.accept(row(KEY,'2026-11-05','1020',103)),true);
  assert.equal(client.read(KEY).points.at(-1).price,103);
});

test('source fallback supplies today even when the primary returns a valid previous session',async()=>{
  const urls=[];const client=Model.createClient({now:()=>NOW,fetchJSON:async url=>{urls.push(url);return url.includes('minute/query')?tencent(KEY,'2026-11-04','1500'):eastmoney(KEY);}});
  const result=await client.refresh(KEY,state());assert.equal(result.date,'2026-11-05');assert.equal(result.source,'东方财富');
  assert.equal(urls.length,2);assert.match(urls[0],/minute\/query/);assert.match(urls[1],/trends2\/get\?secid=0\.300308/);
});

test('same-day but delayed primary curve does not block a newer secondary source',async()=>{
  const urls=[];const client=Model.createClient({now:()=>NOW,fetchJSON:async url=>{
    urls.push(url);return url.includes('minute/query')?tencent(KEY,'2026-11-05','1000',101):eastmoney(KEY,'2026-11-05','1020',103);
  }});
  const result=await client.refresh(KEY,state());assert.equal(urls.length,2);
  assert.equal(result.source,'东方财富');assert.equal(result.points.at(-1).time,'1020');assert.equal(result.points.at(-1).price,103);
});

test('fresh primary curve avoids a needless backup request while HK also falls back when its primary is stale',async()=>{
  let calls=0;const fresh=Model.createClient({now:()=>NOW,fetchJSON:async()=>{calls++;return tencent(KEY,'2026-11-05','1019');}});
  assert.equal((await fresh.refresh(KEY,state())).source,'腾讯财经');assert.equal(calls,1);
  const urls=[];const hk=Model.createClient({now:()=>NOW,fetchJSON:async url=>{
    urls.push(url);return url.includes('eastmoney')?eastmoney(HK,'2026-11-05','1000'):tencent(HK,'2026-11-05','1020');
  }});
  const result=await hk.refresh(HK,state({closeMinute:970}));assert.equal(urls.length,2);
  assert.equal(result.source,'腾讯财经');assert.equal(result.points.at(-1).time,'1020');
});

test('latest morning close is fresh during each market lunch, not mistaken for a delayed source',async()=>{
  for(const [key,time,now]of [[KEY,'1130',ts('2026-11-05','12:15:00')],[HK,'1200',ts('2026-11-05','12:30:00')]]){
    let calls=0;const client=Model.createClient({now:()=>now,fetchJSON:async url=>{
      calls++;return url.includes('minute/query')?tencent(key,'2026-11-05',time):eastmoney(key,'2026-11-05',time);
    }});
    const result=await client.refresh(key,state({phase:'lunch',closeMinute:key===HK?970:900}));
    assert.equal(result.points.at(-1).time,time);assert.equal(calls,1);
  }
});

test('HK prioritizes Eastmoney then tries Tencent without routing HK as an A share',async()=>{
  const urls=[];const client=Model.createClient({now:()=>NOW,fetchJSON:async url=>{urls.push(url);if(url.includes('eastmoney'))throw Error('network');return tencent(HK);}});
  const result=await client.refresh(HK,state({closeMinute:970}));assert.equal(result.key,HK);assert.equal(result.source,'腾讯财经');
  assert.match(urls[0],/secid=116\.00700/);assert.match(urls[1],/code=hk00700/);
});

test('Eastmoney JSONP is an optional final browser fallback, never an unbounded retry loop',async()=>{
  let calls=0,jsonpCalls=0;const client=Model.createClient({now:()=>NOW,fetchJSON:async()=>{calls++;throw Error('CORS');},jsonp:async url=>{jsonpCalls++;assert.match(url,/secid=0\.300308/);return eastmoney();}});
  const result=await client.refresh(KEY,state());assert.equal(result.source,'东方财富');assert.equal(calls,2);assert.equal(jsonpCalls,1);
});

test('network failure retains validated local cache, including when localStorage is unavailable',async()=>{
  let calls=0;const storage=store([row()]);const client=Model.createClient({now:()=>NOW,storage,fetchJSON:async()=>{calls++;throw Error('offline');}});
  assert.equal(client.read(KEY).points.at(-1).price,102);
  const result=await client.refresh(KEY,state());assert.equal(result.points.at(-1).price,102);assert.equal(calls,2);assert.equal(storage.writes,0);
  const privateClient=Model.createClient({now:()=>NOW,storage:{getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}},fetchJSON:async()=>{throw Error('offline');}});
  assert.equal(privateClient.read(KEY),null);assert.equal(privateClient.accept(row()),true);assert.doesNotThrow(()=>privateClient.save());
  assert.equal((await privateClient.refresh(KEY,state())).points.at(-1).price,102);
});

test('same stock has one pending request and at most one refresh attempt each minute',async()=>{
  let now=NOW,calls=0,release;const waiting=new Promise(resolve=>{release=resolve;});
  const client=Model.createClient({now:()=>now,fetchJSON:async()=>{calls++;await waiting;return tencent(KEY,'2026-11-05','1020');}});
  const first=client.refresh(KEY,state()),second=client.refresh(KEY,state());assert.equal(first,second);assert.equal(client.isPending(KEY),true);
  await flush();assert.equal(calls,1);release();await first;await flush();assert.equal(client.isPending(KEY),false);
  await client.refresh(KEY,state());assert.equal(calls,1);
  now+=59999;await client.refresh(KEY,state());assert.equal(calls,1);
  now++;await client.refresh(KEY,state());assert.equal(calls,2);
});

test('request queue caps simultaneous stocks at three and rechecks offscreen permission before network',async()=>{
  let running=0,max=0,calls=0;const blockers=[];
  const client=Model.createClient({now:()=>NOW,fetchJSON:async url=>{calls++;running++;max=Math.max(max,running);await new Promise(resolve=>blockers.push(resolve));running--;const key=new URL(url).searchParams.get('code');return tencent(key,'2026-11-05','1020');}});
  const keys=['sz300308','sz002353','sh601138','sz000001','sh600000','sz300502'];
  const jobs=keys.map(key=>client.refresh(key,state()));await flush();assert.equal(calls,3);assert.equal(max,3);
  blockers.splice(0).forEach(fn=>fn());await flush();assert.equal(calls,6);assert.equal(max,3);
  blockers.splice(0).forEach(fn=>fn());await Promise.all(jobs);assert.equal(running,0);
  await client.refresh('sz300666',state(),()=>false);assert.equal(calls,6,'Offscreen permission is checked inside the queue');
});

test('holiday, suspension, preopen and confirmed no-trade have no curve and make no requests',async()=>{
  let calls=0;const client=Model.createClient({now:()=>NOW,fetchJSON:async()=>{calls++;return tencent();}});client.accept(row());
  const cases=[['market_closed',{status:'market_closed'},'休市'],['market_closed',{isClosed:true},'休市'],
    ['suspended',{status:'suspended'},'停牌'],['preopen',{status:'preopen'},'未开盘'],['preopen',{phase:'auction'},'未开盘'],
    ['missing',{status:'no_trade'},'尚未成交'],['missing',{calendarKnown:false},'交易日历待确认']];
  for(const [expected,extra,label]of cases){
    const s=state(extra),d=Model.display(client.read(KEY),s,NOW);assert.equal(d.row,null);assert.equal(d.status,expected);assert.equal(d.label,label);
    await client.refresh(KEY,s);
  }
  assert.equal(calls,0);
});

test('lunch and after-close preserve final same-day curves, but incomplete curves are explicitly stale',()=>{
  const lunch=Model.validate(row(KEY,'2026-11-05','1130'),ts('2026-11-05','12:00:00'));
  const noon=state({phase:'lunch'});assert.equal(Model.display(lunch,noon,ts('2026-11-05','12:00:00')).status,'ready');assert.equal(Model.complete(lunch,noon,ts('2026-11-05','12:00:00')),true);
  const close=Model.validate(row(KEY,'2026-11-05','1500'),ts('2026-11-05','15:20:00'));
  const after=state({phase:'after_close'});assert.equal(Model.display(close,after,ts('2026-11-05','15:20:00')).status,'ready');assert.equal(Model.complete(close,after,ts('2026-11-05','15:20:00')),true);
  const hkClose=Model.validate(row(HK,'2026-11-05','1600'),ts('2026-11-05','16:20:00'));
  assert.equal(Model.complete(hkClose,state({phase:'after_close',closeMinute:970}),ts('2026-11-05','16:20:00')),true);
  assert.equal(Model.display(hkClose,state({phase:'after_close',closeMinute:970}),ts('2026-11-05','16:20:00')).status,'ready');
  const stale=Model.display(row(KEY,'2026-11-05','1000'),state(),NOW);assert.equal(stale.status,'stale');assert.match(stale.label,/10:00/);assert.ok(stale.row);
  const yesterday=Model.display(row(KEY,'2026-11-04','1500'),state(),NOW);assert.equal(yesterday.status,'stale');assert.match(yesterday.label,/11-04.*上次行情/);
});

test('final close gets one post-close confirmation then settles rather than polling forever',async()=>{
  const now=ts('2026-11-05','15:20:00');let calls=0;
  const client=Model.createClient({now:()=>now,fetchJSON:async()=>{calls++;return tencent(KEY,'2026-11-05','1500');}});
  client.accept(row(KEY,'2026-11-05','1500'));
  await client.refresh(KEY,state({phase:'after_close'}));assert.equal(calls,1);
  await client.refresh(KEY,state({phase:'after_close'}));assert.equal(calls,1);
});

test('browser mounts cached cells without hidden or offscreen traffic, and fetches only visible active slots',async()=>{
  const listeners={},timers=[],intervals=[],intersections=[];let calls=0;
  const slot={dataset:{sparkKey:KEY,sparkName:'测试股票',sparkMarket:'SZ',sparkStatus:'valid'},innerHTML:'',isConnected:true};
  const tab={classList:{contains:()=>true}},host={};
  const document={hidden:true,readyState:'loading',getElementById:id=>id==='tPort'?tab:id==='portSectors'?host:null,
    querySelectorAll:()=>[slot],addEventListener:(name,fn)=>{listeners[name]=fn;}};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}}
  const ctx=vm.createContext({document,Date:Clock,URL,AbortController,console,Promise,Map,Set,Number,JSON,
    module:{exports:{}},setTimeout:(fn,delay)=>{const timer={fn,delay};timers.push(timer);return timer;},clearTimeout(){},setInterval:fn=>intervals.push(fn),
    addEventListener(){},localStorage:store([]),PortfolioSparklineView:{render:(_data,options)=>'<b>'+options.status+'</b>'},
    PortfolioMarketSession:{marketState:()=>state()},fetch:async()=>{calls++;return{ok:true,json:async()=>tencent(KEY,'2026-11-05','1020')};},
    MutationObserver:class{observe(){}},IntersectionObserver:class{constructor(fn){intersections.push(fn);}observe(){}disconnect(){}}});
  vm.runInContext(source,ctx);listeners.DOMContentLoaded();
  function tick(){const tasks=timers.filter(t=>t.delay===350);for(const t of tasks){timers.splice(timers.indexOf(t),1);t.fn();}}
  tick();await flush();assert.equal(calls,0,'Hidden tab does not fetch');assert.match(slot.innerHTML,/missing/);
  document.hidden=false;listeners.visibilitychange();tick();await flush();assert.equal(calls,0,'Offscreen slot does not fetch');
  intersections[0]([{target:slot,isIntersecting:true}]);tick();await flush();assert.equal(calls,1);assert.match(slot.innerHTML,/ready/);
  document.hidden=true;intervals.forEach(fn=>fn());tick();await flush();assert.equal(calls,1,'Hidden interval does not fetch');
});

test('table replaces the speed column one-for-one, guards optional module, preserves loading order and parses all scripts',()=>{
  assert.match(html,/<th class="th-spark"[^>]*>当日分时<\/th>/);
  assert.match(html,/<td class="col-spark port-cell-momentum">/);
  assert.doesNotMatch(html,/togglePortSort\('speed'\)/);assert.doesNotMatch(html,/class="col-sp /);
  assert.ok(html.includes('colspan="13"'));
  const header=html.match(/<tr class="port-table-columns">([\s\S]*?)<\/tr>/);assert.ok(header);assert.equal((header[1].match(/<th(?:\s|>)/g)||[]).length,13);
  assert.match(html,/if\(typeof PortfolioSparklines==='object'\)PortfolioSparklines\.mount\(\)/);
  assert.ok(html.indexOf('assets/portfolio-sparkline-view.js')<html.indexOf('assets/portfolio-sparklines.js'));
  assert.ok(html.indexOf('assets/portfolio-sparklines.js')<html.indexOf('function renderPortfolio'));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\bsrc\s*=|application\/(?:ld\+)?json/i.test(match[1])||!match[2].trim())continue;
    new vm.Script(match[2]);
  }
});
