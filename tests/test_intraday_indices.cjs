const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=require('../assets/intraday-indices.js'),now=Date.parse('2026-10-23T11:00:00+08:00');
function tencent(key='sz399372',date='20261023',times=['0930','1000']){const qt=Array(40).fill('');qt[2]=key.slice(2);qt[4]='100';qt[30]=date+'110000';return{code:0,data:{[key]:{data:{date,data:times.map((t,i)=>t+' '+(100+i)+' 12')},qt:{[key]:qt}}}};}
function em(key='sz399372'){return{rc:0,data:{code:key.slice(2),market:key.startsWith('sh')?1:0,preClose:100,trends:['2026-10-23 09:30,100,100,100,100,1','2026-10-23 10:00,100,101,101,100,1']}};}
const row=(key='sz399372',date='20261023')=>api.parseTencent(tencent(key,date),key,now);
test('Tencent and Eastmoney compute percentages from matching previous close',()=>{
  assert.equal(row().points[1].pct,api.parseEastmoney(em(),'sz399372',now).points[1].pct);
  assert.equal(row().date,'20261023');assert.equal(row().source,'腾讯财经');
});
test('date/identity mismatches, invalid/zero price and missing previous close rejected',()=>{
  const p=tencent();p.data.sz399372.qt.sz399372[30]='20261022150000';assert.throws(()=>api.parseTencent(p,'sz399372',now));
  assert.throws(()=>api.parseTencent(tencent('sz399373'),'sz399372',now));
  for(const price of ['','0','NaN']){const p=tencent();p.data.sz399372.qt.sz399372[4]=price;assert.throws(()=>api.parseTencent(p,'sz399372',now));}
  for(const date of ['20260230','20261301','20261024'])assert.equal(api.valid({...row(),date},now),null);
  assert.equal(api.valid({...row(),points:[{time:'1000',price:101,pct:999}]},now),null);
});
test('Eastmoney uses minute close not open; rejects mixed trading days',()=>{
  const p=em();p.data.trends[1]='2026-10-23 10:00,110,101,111,100';assert.ok(Math.abs(api.parseEastmoney(p,'sz399372',now).points[1].pct-1)<1e-10);
  p.data.trends[1]='2026-10-22 10:00,100,101,101,100';assert.throws(()=>api.parseEastmoney(p,'sz399372',now));
});
test('one valid opening minute renders; no invented extra points or lunch points',()=>{
  assert.equal(api.parseTencent(tencent('sz399372','20261023',['0930']),'sz399372',now).points.length,1);
  assert.equal(api.parseTencent(tencent('sz399372','20261023',['0930','1200']),'sz399372',now).points.length,1);
});
test('older minute/day or truncated same-minute curve cannot replace a newer cache',()=>{
  const old=row(),short={...old,points:[old.points[1]]};assert.equal(api.newer(old,short),false);
  assert.equal(api.newer(old,row('sz399372','20261022')),false);
  assert.equal(api.newer(old,{...old,points:old.points.slice(0,1)}),false);
  assert.equal(api.newer(old,{...old,quoteTimestamp:old.quoteTimestamp-1000}),false);
});
test('primary failure switches to Eastmoney for all six indices',async()=>{
  let fallback=0;const client=api.createClient({now:()=>now,snapshots:false,fetchJSON:async url=>{if(url.includes('ifzq'))throw Error('501');fallback++;const code=url.match(/secid=(\d)\.(\d+)/);return em((code[1]==='1'?'sh':'sz')+code[2]);}});
  const data=await client.refresh('style');assert.equal(data.series.length,6);assert.equal(fallback,6);assert.ok(data.series.every(r=>r.source==='东方财富'));
});
test('JSONP fallback is used if browser fetch is blocked',async()=>{
  const client=api.createClient({now:()=>now,snapshots:false,fetchJSON:async()=>{throw Error('CORS');},jsonp:async()=>em()});
  assert.equal((await client.fetchOne('sz399372')).source,'东方财富');
});
test('groups share max four network slots; in-flight and minute throttle prevent duplicate refresh',async()=>{
  let calls=0,live=0,max=0;const client=api.createClient({now:()=>now,snapshots:false,fetchJSON:async url=>{calls++;live++;max=Math.max(live,max);await new Promise(r=>setTimeout(r,2));live--;return tencent(new URL(url).searchParams.get('code'));}});
  await Promise.all([client.refresh('style'),client.refresh('style'),client.refresh('rotation')]);assert.equal(calls,12);assert.ok(max<=4);
  await client.refresh('style');assert.equal(calls,12);
});
test('local cache restores immediately even when all public sources fail',async()=>{
  const payload={schemaVersion:1,series:api.GROUPS.style.map(k=>row(k))};let seen=0;
  const client=api.createClient({now:()=>now,snapshots:false,storage:{getItem:()=>JSON.stringify(payload)},fetchJSON:async()=>{throw Error('offline');}});
  const promise=client.refresh('style',data=>{if(data?.series.length===6)seen++;});assert.equal(seen,1);assert.equal((await promise).series.length,6);
});
test('same-origin snapshot supports first visit when both direct sources fail',async()=>{
  const client=api.createClient({now:()=>now,fetchJSON:async u=>{if(u.startsWith('./data/'))return{schemaVersion:1,series:api.GROUPS.rotation.map(k=>row(k))};throw Error('offline');}});
  assert.equal((await client.refresh('rotation')).series.length,6);
});
test('never overlay yesterday and today; partial newest-day coverage is explicit',()=>{
  const client=api.createClient({now:()=>now,snapshots:false});client.ingest({schemaVersion:1,series:api.GROUPS.style.map(k=>row(k,'20261022'))});
  client.ingest({schemaVersion:1,series:[row()]});const data=client.group('style');assert.equal(data.series.length,1);assert.equal(data.partial,true);assert.equal(data.date,'20261023');assert.match(api.label(data,now),/1\/6/);
});
test('closed and historical curves retain actual quote dates and timestamps',()=>{
  const old={date:'20261022',series:[row('sz399372','20261022')],partial:true};assert.match(api.label(old,now),/10-22.*上次行情/);
  const close=api.parseTencent(tencent('sz399372','20261023',['0930','1500']),'sz399372',Date.parse('2026-10-23T16:00:00+08:00'));
  assert.match(api.label({date:close.date,series:[close]},Date.parse('2026-10-23T16:00:00+08:00')),/15:00 · 收盘/);
});
test('page wiring retains requested ordering, click highlighting and independent retries',()=>{
  const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
  assert.match(html,/assets\/intraday-indices\.js\?v=20261023a/);assert.match(html,/refresh\('style'/);assert.match(html,/refresh\('rotation'/);
  assert.match(html,/_toggleMktStyleSeries/);assert.match(html,/_toggleMktRotationSeries/);assert.match(html,/setInterval\(refresh,60000\)/);
  const order=html.slice(html.indexOf('const _MKT_ROTATION_META'),html.indexOf('var _mktRotationCache'));
  assert.ok(order.indexOf("name:'信息'")<order.indexOf("name:'储能'"));assert.ok(order.indexOf("name:'储能'")<order.indexOf("name:'生物医药'"));
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!m[1].includes('src=')&&m[2].trim())new vm.Script(m[2]);
});
test('actual SVG renderers produce six curves, numeric legends and selectable highlights',()=>{
  const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8'),elements=new Map();
  const node=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',style:{},clientWidth:560,clientHeight:250,addEventListener(){},setAttribute(){},querySelector:selector=>node(id+selector)});return elements.get(id);};
  const context={IntradayIndices:api,document:{getElementById:node,addEventListener(){}},window:{addEventListener(){}},console,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(html.slice(html.indexOf('const _MKT_STYLE_META'),html.indexOf('// ── 财经要闻（独立多源')),context);
  const client=api.createClient({now:()=>now,snapshots:false});client.ingest({schemaVersion:1,series:api.KEYS.map(k=>row(k))});context.style=client.group('style');context.rotation=client.group('rotation');
  vm.runInContext('_mktStyleCache=_mktCurveData(style,_MKT_STYLE_META);_renderMktStyle(_mktStyleCache,false);_mktRotationCache=_mktCurveData(rotation,_MKT_ROTATION_META);_renderMktRotation(_mktRotationCache,false);',context);
  for(const name of ['Style','Rotation']){assert.equal((node('mkt'+name+'Chart').innerHTML.match(/<path /g)||[]).length,6);assert.equal((node('mkt'+name+'Legend').innerHTML.match(/<button /g)||[]).length,6);assert.match(node('mkt'+name+'Legend').innerHTML,/\+1.00%/);}
  vm.runInContext("_toggleMktStyleSeries('399372');_toggleMktRotationSeries('980027');",context);
  assert.match(node('mktStyleLegend').innerHTML,/aria-pressed="true"/);assert.match(node('mktRotationLegend').innerHTML,/aria-pressed="true"/);
});
