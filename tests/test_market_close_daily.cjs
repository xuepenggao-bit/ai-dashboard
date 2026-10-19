const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const htmlPath=process.env.DASHBOARD_HTML||path.join(__dirname,'..','index.html');
const functions=['_marketDailyDate','_marketDailySnapshot','_marketDailyIsNewer','_marketDailyReadSource','_fetchMarketDailyPayload','_marketDailyLiveMayOverlay','_mergeBreadthTrendRows','_mergeLimitTrendRows'];
const source=process.env.MARKET_CLOSE_DAILY_SOURCE?fs.readFileSync(process.env.MARKET_CLOSE_DAILY_SOURCE,'utf8'):functions.map(name=>{
  const all=fs.readFileSync(htmlPath,'utf8'),match=all.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n}'));
  if(!match)throw Error('Missing actual function '+name);return match[0];
}).join('\n');
function makePayload(last='2026-10-16',updatedAt='2026-10-16T16:20:00+08:00'){
  const dates=[];for(let n=Date.parse(last+'T00:00:00Z');dates.length<20;n-=86400000){const d=new Date(n);if(![0,6].includes(d.getUTCDay()))dates.unshift(d.toISOString().slice(0,10));}
  return{updatedAt,scope:'沪深A股',source:'validated market snapshot',series:dates.map(date=>({date,up:3000,down:2000,flat:100,limitUp:70,limitDown:20,amountYi:15000}))};
}
function harness(fetcher,at='2026-10-19T16:11:00+08:00',options={}){
  let now=Date.parse(at);class FakeDate extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
  const context=vm.createContext({Date:FakeDate,Promise,Map,Set,Number,Math,Error,AbortController,console,setTimeout:options.setTimeout||setTimeout,clearTimeout,fetch:fetcher});
  const declarations=process.env.MARKET_CLOSE_DAILY_SOURCE?'':`let _marketDailyPayloadReadState={ok:false,fallback:false,at:0,source:''};let _marketDailyPayloadStartedAt=0;let _marketDailyPayloadPostCloseQueued=null;`;
  vm.runInContext(`let _marketDailyPayload=null,_marketDailyPayloadTs=0,_marketDailyPayloadFetch=null;${declarations}
    function _breadthBeijingClock(ms=Date.now()){const d=new Date(ms+8*3600000);return{date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};}
    ${source}`,context);
  return{context,run:s=>vm.runInContext(s,context),setNow:s=>{now=Date.parse(s);},read:force=>context._fetchMarketDailyPayload(force),state:()=>vm.runInContext('_marketDailyPayloadReadState',context)};
}
function response(payload){return Promise.resolve({ok:true,json:async()=>payload});}
test('latest Raw snapshot wins over Pages without splicing rows',async()=>{
  const old=makePayload(),fresh=makePayload('2026-10-19','2026-10-19T16:10:00+08:00');fresh.series.at(-1).up=3400;fresh.series.at(-1).down=1600;
  const urls=[];const h=harness(url=>{urls.push(url);return response(url.startsWith('https:')?fresh:old);});
  assert.equal(await h.read(true),fresh);assert.equal(urls.length,2);assert.ok(urls.every(url=>url.includes('_=')));assert.equal(h.state().ok,true);
});
test('newest published revision wins for the same last trading date',async()=>{
  const old=makePayload('2026-10-19','2026-10-19T16:00:00+08:00'),fresh=makePayload('2026-10-19','2026-10-19T16:10:00+08:00');
  const h=harness(url=>response(url.startsWith('https:')?fresh:old));assert.equal(await h.read(true),fresh);
});
test('memory throttle skips network while force bypasses it',async()=>{
  let count=0;const payload=makePayload();const h=harness(()=>{count++;return response(payload);});
  await h.read(true);await h.read(false);assert.equal(count,2);await h.read(true);assert.equal(count,4);
});
test('an older Raw or Pages revision cannot roll back valid memory',async()=>{
  let latest=true;const old=makePayload(),fresh=makePayload('2026-10-19','2026-10-19T16:10:00+08:00');const h=harness(()=>response(latest?fresh:old));
  await h.read(true);latest=false;assert.equal(await h.read(true),fresh);assert.equal(h.state().ok,true);assert.equal(h.state().source,'memory');
});
test('all failed sources preserve baseline but explicitly report failed read',async()=>{
  let fail=false;const payload=makePayload();const h=harness(()=>fail?Promise.reject(Error('offline')):response(payload));
  await h.read(true);fail=true;assert.equal(await h.read(true),payload);assert.equal(h.state().ok,false);assert.equal(h.state().fallback,true);
});
test('all failed sources without baseline reject rather than invent data',async()=>{
  const h=harness(()=>Promise.reject(Error('offline')));await assert.rejects(h.read(true),/全部来源/);assert.equal(h.state().ok,false);assert.equal(h.state().fallback,false);
});
test('malformed newest payload cannot partially contaminate valid snapshot',async()=>{
  const good=makePayload(),bad=makePayload('2026-10-19','2026-10-19T16:10:00+08:00');bad.series[0].up='3000';
  const h=harness(url=>response(url.startsWith('https:')?bad:good));assert.equal(await h.read(true),good);
});
test('one hung source is aborted independently while valid fallback succeeds',async()=>{
  let aborted=false;const good=makePayload();
  const h=harness((url,options)=>{
    if(url.startsWith('https:'))return response(good);
    options.signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});
  },undefined,{setTimeout:(fn,ms)=>setTimeout(fn,ms===8000?5:ms)});
  assert.equal(await h.read(true),good);assert.equal(aborted,true);assert.equal(h.state().ok,true);
});
test('future revisions and pre-close daily snapshots fail atomically',async()=>{
  const future=makePayload('2026-10-19','2026-10-20T16:10:00+08:00'),partial=makePayload('2026-10-19','2026-10-19T14:00:00+08:00');
  const h=harness(url=>response(url.startsWith('https:')?future:partial));await assert.rejects(h.read(true),/全部来源/);assert.equal(h.state().ok,false);
});
test('16:10 force pass queues once behind pre-close read and then rereads',async()=>{
  let release,count=0;const payload=makePayload();const blocked=new Promise(resolve=>{release=resolve;});
  const h=harness(async()=>{count++;if(count<=2)await blocked;return{ok:true,json:async()=>payload};},'2026-10-19T16:09:59+08:00');
  const first=h.read(true);h.setNow('2026-10-19T16:10:00+08:00');const second=h.read(true),third=h.read(true);release();
  await Promise.all([first,second,third]);assert.equal(count,4);assert.equal(h.state().ok,true);
});
for(const name of ['_mergeBreadthTrendRows','_mergeLimitTrendRows']){
  test(name+': intraday live remains visible, but 16:10 history wins',()=>{
    const h=harness(()=>response(makePayload()));const rows=[{date:'2026-10-19',up:3000,down:2000,flat:100}],live={date:'2026-10-19',up:2000,down:3000,flat:100,asOf:'13:05'};
    const merge=h.context[name];const intraday=merge(rows,live,'2026-10-19',{date:'2026-10-19',minute:840});assert.equal(intraday[0].up,2000);assert.equal(intraday[0].live,true);
    const closed=merge(rows,live,'2026-10-19',{date:'2026-10-19',minute:970});assert.equal(closed[0].up,3000);assert.equal(closed[0].live,false);
  });
  test(name+': known close is immutable by late live, overnight does not retain old overlay',()=>{
    const h=harness(()=>response(makePayload()));const merge=h.context[name],rows=[{date:'2026-10-19',up:3000,down:2000,status:'close',asOf:'15:00'}],live={date:'2026-10-19',up:2000,down:3000,asOf:'14:59'};
    assert.equal(merge(rows,live,'2026-10-19',{date:'2026-10-19',minute:960})[0].up,3000);
    assert.equal(merge(rows,live,'2026-10-20',{date:'2026-10-20',minute:600})[0].live,false);
    const missing=merge([],live,'2026-10-19',{date:'2026-10-19',minute:1000});assert.equal(missing[0].live,true);assert.equal(missing[0].asOf,'14:59');
  });
}
