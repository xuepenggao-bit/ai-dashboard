const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('const _SECTOR_VOLUME_META ='),html.indexOf('// ── 市场风格（'));
const codes=['BK1136','BK0877','BK1137'];
const labels=[];
for(let m=571;m<=900;m++){
  if(m>690&&m<781)continue;
  labels.push(String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'));
}
function rows(date='2026-10-23',price=110,times=labels){return times.map(t=>`${date} ${t},${price},1000000`);}
function payload(code,values=rows()){return {data:{code,preClose:100,trends:values}};}
function harness(storage=new Map()){
  const elements={},listeners={},calls=[];
  const clock={date:'2026-10-23',time:'16:00',minute:960,weekday:5,isTrading:false};
  let fetcher=async url=>payload(codes.find(code=>url.includes(code)),rows('2026-10-22',100).concat(rows()));
  const context=vm.createContext({console,Date,Map,Set,Number,JSON,Math,Promise,
    setTimeout:fn=>{queueMicrotask(fn);return 1;},setInterval:fn=>{listeners.interval=fn;},
    window:{addEventListener:(name,fn)=>{listeners[name]=fn;}},
    document:{hidden:false,addEventListener:(name,fn)=>{listeners[name]=fn;},getElementById:id=>elements[id]||(elements[id]={innerHTML:'',textContent:'',className:'',classList:{contains:()=>true,add(){},remove(){}}})},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    _breadthBeijingClock:()=>clock,_turnoverCmpCache:{data:null},_marketTurnoverSnapshot:null,
    _idxFetch:async url=>{calls.push(url);return fetcher(url);}
  });
  vm.runInContext(source,context);
  return {c:context,clock,e:elements,storage,calls,listeners,setFetch(fn){fetcher=fn;}};
}
const meta=code=>({code,title:code,sourceName:code,color:'#2563eb'});

test('all three final close cards persist amounts, both curves, price change and same-day share across reload',async()=>{
  const h=harness();
  h.c._marketTurnoverSnapshot={date:h.clock.date,tod:'16:00',yi:24};
  await h.c._doFetchSectorVolumes();
  for(const code of codes){
    const d=h.c._sectorVolumeCache[code].data;
    assert.equal(d.todayCum,240e6);assert.equal(d.yesterdayFull,240e6);
    assert.equal(h.c._sectorVolumeIsClose(d),true);
    assert.match(h.e['sectorVolumeTs-'+code].textContent,/15:00 · 收盘/);
    assert.match(h.e['sectorVolumeBody-'+code].innerHTML,/收盘成交额/);
    assert.equal(h.e['sectorAmountShareValue-'+code].textContent,'10.00%');
  }
  const reload=harness(h.storage);reload.setFetch(async()=>{throw Error('offline');});
  await reload.c._doFetchSectorVolumes();
  assert.equal(reload.calls.length,0,'complete close must not be discarded or re-requested');
  for(const code of codes){
    assert.equal(reload.c._sectorVolumeCache[code].data.todayCum,240e6);
    assert.equal(reload.e['sectorAmountShareValue-'+code].textContent,'10.00%');
    assert.equal((reload.e['sectorVolumeBody-'+code].innerHTML.match(/<svg/g)||[]).length,2);
  }
});

test('after-close minute K-line is a fallback only; first-ever closed visit survives empty realtime endpoints',async()=>{
  const h=harness();
  h.setFetch(async url=>{if(!url.includes('/kline/'))throw Error('closed realtime');return {data:{code:'BK1136',preKPrice:100,klines:rows()}};});
  const data=await h.c._sectorVolumeRequest(meta('BK1136'));
  assert.equal(h.calls[0].includes('/trends2/'),true);
  assert.equal(h.calls[h.calls.length-1].includes('/kline/'),true);
  assert.equal(data.todayCum,240e6);assert.equal(data.tod,'15:00');
  assert.ok(Math.abs(data.lastPct-10)<1e-8);assert.equal(h.c._sectorVolumeIsClose(data),true);
});

test('complete original endpoint does not invoke a different source',async()=>{
  const h=harness();await h.c._sectorVolumeRequest(meta('BK0877'));
  assert.equal(h.calls.length,1);assert.equal(h.calls.some(u=>u.includes('/kline/')),false);
});

test('after-close fallback accepts validated JSONP when browser fetch is blocked',async()=>{
  const h=harness();h.setFetch(async()=>{throw Error('CORS blocked');});
  let url='';h.c._idxJsonp=async value=>{url=value;return {data:{code:'BK1136',preKPrice:100,klines:rows()}};};
  const data=await h.c._sectorVolumeRequest(meta('BK1136'));
  assert.match(url,/\/kline\/get/);assert.equal(h.c._sectorVolumeIsClose(data),true);
});

test('14:59 data is retained but not labelled final; after-close retry fills 15:00',async()=>{
  const h=harness();
  h.setFetch(async url=>{if(url.includes('/kline/'))throw Error('not published');return payload('BK1136',rows('2026-10-23',110,labels.slice(0,-1)));});
  const partial=await h.c._sectorVolumeRequest(meta('BK1136'));
  assert.equal(h.c._sectorVolumeIsClose(partial),false);
  h.c._renderSectorVolume(meta('BK1136'),partial,true);
  assert.match(h.e['sectorVolumeTs-BK1136'].textContent,/14:59 · 待收盘补齐/);
  assert.ok(h.calls.some(url=>url.includes('push2.eastmoney.com')),'retry final realtime minute even if date already matches');
  h.c._sectorVolumeCache.BK1136.ts=0;
  h.setFetch(async()=>payload('BK1136'));
  const final=await h.c._sectorVolumeCompare(meta('BK1136'));
  assert.equal(h.c._sectorVolumeIsClose(final),true);
});

test('missing middle minutes cannot freeze a close snapshot even with 240 rows and a 15:00 endpoint',async()=>{
  const h=harness(),data=await h.c._sectorVolumeRequest(meta('BK1136'));
  const missing=labels.concat(['09:30','13:00']).sort().filter(t=>t!=='10:00'&&t!=='14:00');
  const d={...data,labels:missing};
  assert.equal(missing.length,240);assert.equal(h.c._sectorVolumeIsClose(d),false);
});

test('next trading day retries instead of freezing yesterday and does not reuse yesterday share as today',async()=>{
  const h=harness();h.c._marketTurnoverSnapshot={date:h.clock.date,tod:'15:00',yi:24};
  await h.c._doFetchSectorVolumes();
  const next=harness(h.storage);Object.assign(next.clock,{date:'2026-10-26',time:'10:00',minute:600,weekday:1,isTrading:true});
  next.setFetch(async url=>payload(codes.find(code=>url.includes(code)),rows('2026-10-26',110,labels.slice(0,30))));
  await next.c._doFetchSectorVolumes();
  assert.equal(next.calls.length,3);assert.equal(next.calls.some(url=>url.includes('/kline/')),false);
  assert.equal(next.e['sectorAmountShareValue-BK1136'].textContent,'—');
  assert.equal(next.c._sectorVolumeCache.BK1136.data.todayDate,'2026-10-26');
});

test('older, zero and truncated same-minute responses never replace complete final data',async()=>{
  const h=harness(),original=await h.c._sectorVolumeRequest(meta('BK1136'));
  for(const values of [rows('2026-10-22'),rows().slice(-2),rows().map(r=>r.replace(/1000000$/,'0'))]){
    h.setFetch(async url=>{if(url.includes('/kline/'))throw Error('empty');return payload('BK1136',values);});
    try{await h.c._sectorVolumeRequest(meta('BK1136'));}catch{}
    assert.equal(h.c._sectorVolumeCache.BK1136.data,original);
  }
});

test('reject wrong-code, future-date and wrong-date K-lines',async()=>{
  for(const [code,date] of [['BK0877','2026-10-23'],['BK1136','2026-10-24'],['BK1136','2026-10-22']]){
    const h=harness();h.setFetch(async url=>{if(!url.includes('/kline/'))throw Error('empty');return {data:{code,preKPrice:100,klines:rows(date)}};});
    await assert.rejects(h.c._sectorVolumeRequest(meta('BK1136')));
    assert.equal(h.c._sectorVolumeCache.BK1136,undefined);
  }
});

test('one hanging card does not block rendering the other two',async()=>{
  const h=harness();let release;
  h.setFetch(url=>url.includes('BK0877')?new Promise(resolve=>{release=resolve;}):Promise.resolve(payload(codes.find(code=>url.includes(code)))));
  const job=h.c._doFetchSectorVolumes();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(h.e['sectorVolumeBody-BK1136'].innerHTML,/收盘成交额/);
  assert.match(h.e['sectorVolumeBody-BK1137'].innerHTML,/收盘成交额/);
  release(payload('BK0877'));await job;
});

test('standalone close retry ignores hidden tabs and stops after all three final snapshots',async()=>{
  const h=harness();let jobs=0;h.c._doFetchSectorVolumes=()=>{jobs++;};
  h.c.document.hidden=true;h.c._refreshSectorClose();assert.equal(jobs,0);
  h.c.document.hidden=false;h.c._refreshSectorClose();assert.equal(jobs,1);
  h.c._refreshSectorClose();assert.equal(jobs,1,'throttle incomplete close retries');
  const full=harness();await full.c._doFetchSectorVolumes();full.c._doFetchSectorVolumes=()=>{jobs++;};
  full.c._refreshSectorClose();assert.equal(jobs,1);
});

test('storage denied or corrupt does not block live rendering',async()=>{
  for(const broken of ['{bad json','{"version":1,"quotes":{"BK1136":{"data":{}}}}']){
    const h=harness(new Map([['sector-close-snapshots-v1',broken]]));
    h.c.localStorage.setItem=()=>{throw Error('quota');};await h.c._doFetchSectorVolumes();
    assert.match(h.e['sectorVolumeBody-BK1136'].innerHTML,/收盘成交额/);
  }
});

test('cached previous full-day comparison survives a one-day close fallback',async()=>{
  const h=harness();Object.assign(h.clock,{time:'14:59',minute:899,isTrading:true});
  h.setFetch(async()=>payload('BK1136',rows('2026-10-22',100).concat(rows('2026-10-23',110,labels.slice(0,-1)))));
  await h.c._sectorVolumeRequest(meta('BK1136'));
  Object.assign(h.clock,{time:'16:00',minute:960,isTrading:false});
  h.setFetch(async url=>{if(!url.includes('/kline/'))throw Error('empty');return {data:{code:'BK1136',preKPrice:100,klines:rows()}};});
  const data=await h.c._sectorVolumeRequest(meta('BK1136'));
  assert.equal(data.yesterdaySame,240e6);assert.equal(data.yesterdayFull,240e6);
  assert.equal(data.yesterdayAmount[data.yesterdayAmount.length-1],240e6);
});
