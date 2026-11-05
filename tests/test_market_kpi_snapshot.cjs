const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const M=require('../assets/market-kpi-snapshot.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const day='2026-11-05',prev='2026-11-04',now=Date.parse(day+'T14:00:00+08:00');
const ts=(d=day,t='13:45:00')=>Date.parse(d+'T'+t+'+08:00');
function dates(end,count=21){let d=Date.parse(end+'T00:00:00Z'),rows=[];while(rows.length<count){const v=new Date(d);if(v.getUTCDay()%6)rows.unshift(v.toISOString().slice(0,10));d-=86400000;}return rows;}
function fixture(end=day,minute='13:45',value=12){
  const dateTs=ts(end,minute+':00');
  return{schemaVersion:1,checkedAt:new Date(now).toISOString(),
    caps:{quotes:M.CAPS.map((code,i)=>({code,totalCapYi:[600000,350000,130000,70000][i],quoteTs:dateTs}))},
    pe:{quotes:Object.entries(M.PE).map(([code,secucode],i)=>({code,secucode,pe:value+i,quoteTs:dateTs}))},
    hkAmount:{series:dates(end).map((date,i)=>({date,amountYi:2000+i,status:date===day?'live':'close',...(date===day?{asOf:minute}:{})}))},
    margin:{series:dates(end===day?prev:end).map((date,i)=>({date,balanceYi:20000+i}))}};
}
test('each snapshot part validates source identities, units and dates independently',()=>{
  const d=fixture(),v=M.validate(d,now);assert.deepEqual(Object.keys(v),['schemaVersion','caps','pe','hkAmount','margin']);
  assert.equal(v.caps.quotes[0].quoteTs,ts());assert.equal(v.pe.quotes[0].secucode,'000001.SH');
  d.caps.quotes[0].quoteTs=ts(prev);d.pe.quotes[0].secucode='399006.SZ';d.margin.series.at(-1).balanceYi=-1;
  const invalid=M.validate(d,now);assert.equal(invalid.caps,undefined);assert.equal(invalid.pe.quotes.length,3);assert.equal(invalid.margin,undefined);assert.equal(invalid.hkAmount.series.length,21);
});
test('future or untimed current HK observations do not become today’s live data',()=>{
  for(const item of [{asOf:'14:45'},{asOf:'xx:yy'},{asOf:undefined},{asOf:'13:45',status:'close'}]){
    const d=fixture();Object.assign(d.hkAmount.series.at(-1),item);assert.equal(M.validate(d,now).hkAmount,undefined);
  }
  const d=fixture();d.pe.quotes[0].quoteTs=ts(day,'16:00:00');assert.equal(M.validate(d,now).pe.quotes.length,3);
});
test('invalid date, duplicate series date, inconsistent board decomposition and unknown schema fail safely',()=>{
  const d=fixture();d.margin.series.at(-1).date=d.margin.series.at(-2).date;d.hkAmount.series.at(-1).date='2026-02-30';d.caps.quotes[0].totalCapYi=1000;
  const v=M.validate(d,now);assert.deepEqual(Object.keys(v),['schemaVersion','pe']);assert.equal(M.validate({...d,schemaVersion:2},now),null);
});
test('later checkedAt does not roll back newer source observations',()=>{
  const old=fixture(day,'13:45',22),incoming=fixture(prev,'13:55',9);incoming.checkedAt='2099-01-01T15:00:00+08:00';
  const result=M.merge(old,incoming,now);assert.equal(result.pe.quotes[0].pe,22);assert.equal(result.caps.quotes[0].quoteTs,ts());
  assert.equal(result.hkAmount.series.at(-1).date,day);assert.equal(result.hkAmount.series.at(-1).asOf,'13:45');
});
test('PE merges per code; new live HK points replace only older points on the same day',()=>{
  const old=fixture(day,'13:40',12),next=fixture(day,'13:50',22);next.pe.quotes=next.pe.quotes.slice(0,1);delete next.caps;delete next.margin;
  const result=M.merge(old,next,now);assert.equal(result.pe.quotes.length,4);assert.equal(result.pe.quotes[0].pe,22);assert.equal(result.pe.quotes[1].pe,13);
  assert.equal(result.hkAmount.series.at(-1).asOf,'13:50');assert.equal(result.caps.quotes[0].quoteTs,ts(day,'13:40:00'));assert.ok(result.margin);
});
test('a verified close cannot be downgraded to a later-checked intraday point',()=>{
  const after=ts(day,'17:00:00'),old=fixture(),later=fixture();Object.assign(old.hkAmount.series.at(-1),{asOf:'16:12',status:'close',amountYi:4800});
  Object.assign(later.hkAmount.series.at(-1),{asOf:'16:14',status:'live',amountYi:4500});
  const last=M.merge(old,later,after).hkAmount.series.at(-1);assert.equal(last.status,'close');assert.equal(last.amountYi,4800);
});
test('loader merges same-origin and raw reads, deduplicates requests and force bypasses time throttle',async()=>{
  const calls=[],applied=[];const c=M.createClient({now:()=>now,fetchJSON:async u=>{calls.push(u);return u.startsWith('.')?fixture(prev):fixture();},apply:d=>{if(d)applied.push(d);}});
  const a=c.refresh(true),b=c.refresh(true);assert.equal(a,b);const d=await a;assert.equal(calls.length,2);assert.ok(calls.every(u=>u.endsWith('?_=')===false&&u.includes('?_=')&&u.endsWith(String(now))));
  assert.equal(d.hkAmount.series.at(-1).date,day);assert.ok(applied.length);await c.refresh();assert.equal(calls.length,2);await c.refresh(true);assert.equal(calls.length,4);
});
test('both reads failing preserve the validated local cache without a token or source errors',async()=>{
  const c=M.createClient({now:()=>now,storage:{getItem:()=>JSON.stringify(fixture()),setItem:()=>{throw Error('quota');}},fetchJSON:async()=>{throw Error('offline');}});
  assert.equal((await c.refresh(true)).pe.quotes[0].quoteTs,ts());assert.equal(c.getData().margin.series.at(-1).date,prev);
  const empty=M.createClient({now:()=>now,fetchJSON:async()=>({schemaVersion:0})});assert.equal(await empty.refresh(true),false);
});
function extract(name){const p=html.indexOf('function '+name+'(');assert.ok(p>=0,name);return html.slice(p,html.indexOf('\n}',p)+2);}
function dashboard(){
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const nodes={},node=id=>nodes[id]||(nodes[id]={textContent:'',style:{}}),chart=()=>({data:{labels:[],datasets:[{},{}]},options:{scales:{y:{}}},update(){}});
  const c=vm.createContext({Date:Clock,document:{getElementById:node},BASE:{ashare:{}},CH:{hkVolume:chart(),margin:chart()},_hkVolumeTs:0,
    _movingAverage:vals=>vals.map(v=>v),_marginIncr:vals=>vals.map((v,i)=>i?v-vals[i-1]:null),_fmtDayLabel:d=>d.slice(5),_isCurrentHkAmountPartial:()=>true});
  for(const n of ['_marketKpiStampTs','_renderHkAmountSeries','_renderMarketMarginSeries'])vm.runInContext(extract(n),c);
  vm.runInContext(html.slice(html.indexOf('const _MACRO_CAP_CONFIG='),html.indexOf('// ── 日频 KPI 卡片实时刷新')),c);
  return{c,node};
}
test('production renderers apply all snapshot parts with true observation times',()=>{
  const {c,node}=dashboard(),d=M.validate(fixture(),now);assert.equal(c._applyMarketKpiSnapshot(d),7);
  assert.match(node('kTmc').textContent,/95\.00万亿/);assert.match(node('kTmcDate').textContent,/2026-11-05 13:45/);
  assert.equal(node('kSsePeDate').textContent,'2026-11-05 13:45 · 后台快照');assert.equal(node('kSsePe').textContent,'12.0x');
  assert.match(node('hkVolumeKpiDate').textContent,/2026-11-05 13:45 · 盘中累计/);assert.equal(c.CH.hkVolume.data.datasets[1].data.at(-1),null);
  assert.match(node('marginKpiDate').textContent,/2026-11-04 · 后台快照/);assert.equal(c.CH.margin.data.datasets[0].data.length,21);
  assert.equal(c._applyMarketKpiSnapshot(d),0);
});
test('production snapshot cannot overwrite newer direct PE/HK/margin/cap readings',()=>{
  const {c,node}=dashboard(),latest=M.validate(fixture(day,'13:55',27),now),older=M.validate(fixture(day,'13:35',12),now);
  c._applyMarketKpiSnapshot(latest);c._applyMacroPeQuote('000001.SH',28,ts(day,'13:58:00'));
  assert.equal(c._applyMarketKpiSnapshot(older),0);assert.equal(node('kSsePe').textContent,'28.0x');assert.equal(node('kSsePeDate').textContent,'2026-11-05 13:58');
  assert.match(node('kTmcDate').textContent,/13:55/);assert.match(node('hkVolumeKpiDate').textContent,/13:55/);
  assert.match(node('marginKpiDate').textContent,/2026-11-04/);
});
test('source timestamp parsing is timezone-explicit, not a local browser clock',()=>{
  const {c}=dashboard();for(const s of ['20261105134500','2026/11/05 13:45:00','2026-11-05 13:45'])assert.equal(c._marketKpiStampTs(s),ts());
  for(const s of ['2026-02-30 13:00:00','2026/11/05 25:00:00','2026-11-05 arbitrary 13:45:00'])assert.equal(c._marketKpiStampTs(s),0);
});
