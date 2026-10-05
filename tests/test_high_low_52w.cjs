const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(process.env.TEST_HTML||path.join(__dirname,'../index.html'),'utf8');
const start=html.indexOf('// HIGH_LOW52_MODULE_START'),end=html.indexOf('// HIGH_LOW52_MODULE_END');
assert.ok(start>=0&&end>start,'52-week chart module must exist');
assert.ok(html.indexOf('id="highLow52Card"')<html.indexOf('id="cUpDown"'),'52-week card must precede breadth');
const source=html.slice(start,end);
const now=Date.parse('2026-10-05T15:10:00+08:00');
const STORAGE='aiDashboard.highLow52.v1';
function row(changes={}){
  return{date:'2026-10-05',high:100,low:40,eligible:4900,universe:5200,asOf:'14:30',status:'live',...changes};
}
function payload(rows=[row()],updatedAt='2026-10-05T14:31:00+08:00'){
  return{schemaVersion:1,updatedAt,source:'腾讯财经前复权日线',methodology:'52自然周（364天）· 当日最高/最低触及窗口极值 · 上市满52周 · 沪深A股含ST、不含北交所',series:rows};
}
function context(saved={},denyStorage=false){
  const storage={...saved},elements={},listeners={},charts=[];
  for(const id of ['highLow52KpiDate','highLow52KpiHigh','highLow52KpiLow','highLow52KpiNet','highLow52KpiCnt','highLow52Footer','cHighLow52','cHighLow52Net']){
    elements[id]={textContent:'',style:{},getContext:()=>({})};
  }
  elements.t0={classList:{contains:()=>true}};
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  class Chart{constructor(_ctx,config){Object.assign(this,config);charts.push(this);}update(){}resize(){}}
  const ctx=vm.createContext({Date:FakeDate,Map,Set,Promise,AbortController,setTimeout,clearTimeout,setInterval:()=>0,
    console:{warn(){}},Chart,window:{addEventListener:(name,cb)=>{listeners[name]=cb;}},
    localStorage:{getItem:key=>{if(denyStorage)throw Error('SecurityError');return storage[key]||null;},setItem:(key,value)=>{if(denyStorage)throw Error('SecurityError');storage[key]=value;}},
    document:{hidden:false,getElementById:id=>elements[id]||null,addEventListener:(name,cb)=>{listeners[name]=cb;}},
    fetch:async()=>{throw Error('offline');}});
  vm.runInContext(source,ctx);
  return{ctx,storage,elements,charts,listeners,rows:()=>JSON.parse(JSON.stringify(ctx._highLow52OrderedRows()))};
}

module.exports=(async()=>{
  const test=context(),{ctx,elements,charts}=test;
  assert.equal(ctx._acceptHighLow52Payload(payload()),true);
  assert.equal(elements.highLow52KpiHigh.textContent,'100 家');
  assert.equal(elements.highLow52KpiLow.textContent,'40 家');
  assert.equal(elements.highLow52KpiNet.textContent,'净新高 +60 家');
  assert.equal(charts.length,2,'Use independent line and net-count charts');
  assert.equal(charts[0].data.datasets[0].borderColor,'#ef4444');
  assert.equal(charts[0].data.datasets[1].borderColor,'#16a34a');
  assert.equal(charts[1].data.datasets[0].data[0],60);
  assert.ok(elements.highLow52KpiDate.textContent.includes('2026-10-05 · 盘中快照 14:30'));

  for(const changes of [{high:null},{low:null},{high:undefined},{high:''},{high:'0'},{low:-1},{high:0.5},{eligible:null},{high:5000},{date:'2026-02-30'},{date:'2026-10-06'},{asOf:'24:00'},{asOf:'08:30'},{status:'close',asOf:'14:59'}]){
    assert.equal(ctx._normalizeHighLow52Row(row(changes)),null,'Reject missing or invalid: '+JSON.stringify(changes));
  }
  assert.equal(ctx._acceptHighLow52Payload(payload([row({high:null})])),false);
  assert.equal(test.rows()[0].high,100,'Invalid data cannot erase last valid row');

  assert.equal(ctx._setHighLow52LivePoint(row({high:0,low:0,asOf:'14:40'})),true);
  assert.equal(elements.highLow52KpiHigh.textContent,'0 家','True zero is not missing');
  assert.equal(elements.highLow52KpiLow.textContent,'0 家');
  assert.equal(elements.highLow52KpiNet.textContent,'净新高 0 家');
  ctx._setHighLow52LivePoint(row({high:1,low:2,asOf:'14:39'}));
  assert.equal(test.rows()[0].high,0,'Earlier asOf must never replace a newer live point');
  assert.equal(ctx._setHighLow52LivePoint(row({date:'2026-10-02',asOf:'15:00',status:'close'})),false,'Live collector cannot relabel an older source date');

  ctx._acceptHighLow52Payload(payload([row({high:50,low:80,asOf:'15:00',status:'close'})],'2026-10-05T15:02:00+08:00'));
  assert.equal(test.rows()[0].status,'close');
  assert.equal(elements.highLow52KpiNet.textContent,'净新高 -30 家');
  assert.equal(charts[1].data.datasets[0].borderColor[0],'#16a34a');
  ctx._acceptHighLow52Payload(payload([row({high:999,asOf:'15:01',status:'live'})],'2026-10-05T15:03:00+08:00'));
  assert.equal(test.rows()[0].high,50,'Close cannot be downgraded to live');
  ctx._acceptHighLow52Payload(payload([row({high:51,low:80,asOf:'15:00',status:'close'})],'2026-10-05T15:03:00+08:00'));
  assert.equal(test.rows()[0].high,51,'Newer publication may correct the same closing timestamp');
  ctx._acceptHighLow52Payload(payload([row({high:49,asOf:'15:00',status:'close'})],'2026-10-05T15:01:00+08:00'));
  assert.equal(test.rows()[0].high,51,'Older publication cannot overwrite a correction');
  const tie=context();
  tie.ctx._acceptHighLow52Payload(payload([row({asOf:'15:00',status:'live'})],'2026-10-05T15:05:00+08:00'));
  tie.ctx._acceptHighLow52Payload(payload([row({high:101,asOf:'15:00',status:'close'})],'2026-10-05T15:04:00+08:00'));
  assert.equal(tie.rows()[0].status,'close','Official close supersedes a same-time live point');

  const history=[];
  for(let i=0;i<95;i++){
    const date=new Date(now-i*86400000),day=date.getUTCDay();
    if(day>0&&day<6)history.push(row({date:date.toISOString().slice(0,10),status:'close',asOf:'15:00'}));
  }
  const many=context();
  many.ctx._acceptHighLow52Payload(payload(history,'2026-10-05T15:05:00+08:00'));
  assert.equal(many.rows().length,60,'History is limited to 60 trading observations');
  assert.deepEqual(many.rows().map(r=>r.date),many.rows().map(r=>r.date).sort(),'History sorts ascending');
  assert.equal(new Set(many.rows().map(r=>r.date)).size,60,'Each date appears once');

  const cached=context(test.storage);
  cached.ctx._restoreHighLow52();
  assert.equal(cached.rows()[0].high,51,'Cache-first restores the last good correction');
  assert.equal(await cached.ctx.refreshHighLow52(true),false);
  assert.equal(cached.rows()[0].high,51,'Both-source outage retains last good values');
  assert.ok(cached.elements.highLow52Footer.textContent.includes('保留已验证数据'));
  const privateTab=context({},true);
  assert.equal(privateTab.ctx._acceptHighLow52Payload(payload()),true,'Storage denial must not break current data');
  assert.doesNotThrow(()=>context({[STORAGE]:'broken'}).ctx._restoreHighLow52());

  const race=context();let calls=0;
  race.ctx.fetch=async url=>{calls++;return{ok:true,json:async()=>url.startsWith('./')?
    payload([row({high:60,asOf:'14:40'})],'2026-10-05T14:41:00+08:00'):
    payload([row({high:70,asOf:'14:50'})],'2026-10-05T14:51:00+08:00')};};
  await Promise.all([race.ctx.refreshHighLow52(true),race.ctx.refreshHighLow52(true)]);
  assert.equal(calls,2,'Two sources share one in-flight refresh');
  assert.equal(race.rows()[0].high,70,'Freshest source wins regardless of Pages lag');
  await race.ctx.refreshHighLow52();
  assert.equal(calls,2,'Automatic polling respects the 45-second throttle');
  race.ctx.fetch=async()=>{throw Error('timeout');};
  await race.ctx.refreshHighLow52(true);
  assert.equal(race.rows()[0].high,70,'Timeout must not blank the chart');

  const cold=context();
  await cold.ctx.refreshHighLow52(true);
  assert.equal(cold.rows().length,0);
  assert.equal(cold.elements.highLow52KpiDate.textContent,'等待有效历史数据');
  assert.notEqual(cold.elements.highLow52KpiHigh.textContent,'0 家','No fabricated zero on cold failure');
  assert.ok(source.includes('60000')&&source.includes("attributeFilter:['class']")&&source.includes('visibilitychange'),'Macro-tab, minute and foreground refresh hooks are present');
  return 'PASS: chart ordering, strict dates/counts, true zero, null rejection, live/close arbitration, 60-day history, cache-first, dual-source freshness, throttling and stale-data retention';
})();
