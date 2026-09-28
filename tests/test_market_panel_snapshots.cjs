const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(process.env.TEST_HTML||path.join(__dirname,'../index.html'),'utf8');
const clock=html.slice(html.indexOf('function _breadthBeijingClock('),html.indexOf('// 东方财富牛熊风向标'));
const cache=html.slice(html.indexOf('const _MARKET_PANEL_KEY='),html.indexOf('// 成交额分时每'));
const bootstrap=JSON.parse(html.match(/MARKET_PANELS_SNAPSHOT_START \*\/\s*([\s\S]*?)\s*\/\* MARKET_PANELS_SNAPSHOT_END/)[1]);
const flow=html.slice(html.indexOf('let _mainFlowPending='),html.indexOf('// 新浪 rt_hk 实时港股行情'));
const stamp=t=>Date.parse('2026-09-28T'+t+':00+08:00');
const KEY='aiDashboard.marketPanels.v1';
function rows(sign){return Array.from({length:20},(_,i)=>({f12:String(600000+i),f14:'股票'+i,f3:sign*1.2,f62:sign*(100000000-i*1000000),f124:stamp('11:30')/1000}));}
function snapshot(t='11:30'){
  const common={quoteTs:stamp(t),observedAt:stamp(t)+1000,source:'test'};
  return {breadth:{...common,total:600,counts:[20,40,60,100,100,100,80,60,40]},inflow:{...common,rows:rows(1)},outflow:{...common,rows:rows(-1)}};
}
function setup(saved={},now=stamp('12:15'),deny=false,seed=false){
  const elements={},storage={...saved};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const ctx=vm.createContext({Date:Clock,Math,Set,Map,Promise,Number,JSON,Array,Object,String,
    console:{log(){},warn(){}},_escH:s=>String(s).replace(/[&<>"']/g,'?'),
    document:{hidden:false,getElementById:id=>elements[id]||(elements[id]={textContent:'',innerHTML:'',style:{},title:''})},
    localStorage:{getItem:k=>{if(deny)throw Error('storage blocked');return storage[k]||null;},setItem:(k,v)=>{if(deny)throw Error('storage blocked');storage[k]=v;}},
    _idxFetch:async()=>{throw Error('offline');},_emClistGet:async()=>null,_setBreadthTrendLivePoint(){}});
  const code=seed?cache:cache.replace(/\/\* MARKET_PANELS_SNAPSHOT_START \*\/[\s\S]*?\/\* MARKET_PANELS_SNAPSHOT_END \*\//,'{}');
  vm.runInContext(clock+'\n'+code+'\n'+flow,ctx);
  return {ctx,elements,storage,setNow:n=>{now=n;}};
}
module.exports=(async()=>{
  const seedTime=Math.max(...Object.values(bootstrap).filter(v=>v&&v.observedAt).map(v=>Math.max(v.quoteTs,v.observedAt)));
  const offline=setup({},seedTime+60000,true,true);
  offline.ctx._marketPanelsRestore();
  assert.ok(offline.elements.mktBreadthChart.innerHTML.includes('market-breadth-bars'),'A new offline tab displays the genuine release snapshot');
  for(const id of ['mfList','mfOutList'])assert.equal((offline.elements[id].innerHTML.match(/portfolio-flow-row/g)||[]).length,20);
  // Lunch and close snapshots survive a reload and all external APIs failing.
  const lunch=setup({[KEY]:JSON.stringify(snapshot())});
  await Promise.all([lunch.ctx._doFetchBreadth(),lunch.ctx.fetchMainFlow()]);
  assert.equal(lunch.elements.mktUp.textContent,'220');
  assert.equal(lunch.elements.mktDown.textContent,'280');
  assert.equal(lunch.elements.mktBreadthTs.textContent,'午盘 11:30');
  assert.equal((lunch.elements.mfList.innerHTML.match(/portfolio-flow-row/g)||[]).length,20);
  assert.equal((lunch.elements.mfOutList.innerHTML.match(/portfolio-flow-row/g)||[]).length,20);
  assert.ok(lunch.elements.mktBreadthChart.innerHTML.includes('market-breadth-bars'));
  const close=setup({[KEY]:JSON.stringify(snapshot('15:00'))},stamp('16:20'));
  await Promise.all([close.ctx._doFetchBreadth(),close.ctx.fetchMainFlow()]);
  assert.equal(close.elements.mfTs.textContent,'收盘 15:00');
  assert.equal(close.elements.mktBreadthTs.textContent,'收盘 15:00');

  // A pre-close point is retained but MUST NOT be presented as the closing value.
  assert.equal(lunch.ctx._marketPanelLabel(snapshot('11:20').breadth),'11:20');
  assert.equal(lunch.ctx._marketPanelSessionComplete('breadth'),false,'Keep settling immediately after the boundary');
  assert.equal(lunch.ctx._marketPanelAccept('breadth',{...snapshot().breadth,observedAt:stamp('11:36')}),true,'Accept source corrections with same quote timestamp');
  assert.equal(lunch.ctx._marketPanelSessionComplete('breadth'),true);
  lunch.setNow(stamp('13:05'));
  assert.equal(lunch.ctx._marketPanelSessionComplete('breadth'),false,'Afternoon resumes live fetching');
  const old=setup({[KEY]:JSON.stringify(snapshot('15:00'))},stamp('16:20')+86400000);
  old.ctx._marketPanelsRestore();
  assert.equal(old.elements.mfTs.textContent,'09-28 15:00');
  assert.equal(old.ctx._marketPanelSessionComplete('inflow'),false,'Yesterday cannot suppress today');

  // Corrupt storage/zero resets/partial results/older responses cannot erase good data.
  const test=setup({[KEY]:'broken JSON'});
  test.ctx._marketPanelsRestore();
  assert.equal(test.ctx._marketPanelAccept('breadth',snapshot().breadth),true);
  assert.equal(test.ctx._marketPanelAccept('breadth',{...snapshot().breadth,counts:[0,0,0,0,600,0,0,0,0],quoteTs:stamp('12:00')}),false);
  assert.equal(test.ctx._marketPanelAccept('breadth',snapshot('10:30').breadth),false);
  assert.equal(test.ctx._marketPanelAccept('breadth',{...snapshot().breadth,total:5500,quoteTs:stamp('12:00')}),false,'Mass missing quotes cannot replace the full snapshot');
  assert.equal(test.ctx._marketPanelAccept('breadth',{...snapshot().breadth,quoteTs:stamp('16:00')}),false,'No future quote');
  assert.equal(test.ctx._marketPanelAccept('breadth',{...snapshot().breadth,quoteTs:0,observedAt:stamp('12:00')}),false);
  assert.equal(test.ctx._marketPanelAccept('inflow',{...snapshot().inflow,rows:rows(1).slice(1)}),false);
  assert.equal(test.ctx._marketPanelAccept('inflow',{...snapshot().inflow,rows:rows(-1)}),false);
  assert.equal(test.ctx._marketPanelAccept('inflow',{...snapshot().inflow,rows:Array(20).fill(rows(1)[0])}),false);
  const privateTab=setup({},stamp('12:15'),true);
  assert.equal(privateTab.ctx._marketPanelAccept('breadth',snapshot().breadth),true,'Storage disabled must not prevent memory fallback');
  const unknown={...snapshot().breadth,quoteTs:0,observedAt:stamp('12:00')};
  assert.equal(privateTab.ctx._marketPanelLabel(unknown),'获取 12:00','Receipt time is not close time');

  // A fresh browser recovers all three panels asynchronously from shared JSON.
  const cold=setup();let sharedCalls=0;
  cold.ctx._idxFetch=async url=>{sharedCalls++;return url.startsWith('./')?snapshot('10:30'):snapshot();};
  const a=cold.ctx._refreshMarketPanelSnapshot(),b=cold.ctx._refreshMarketPanelSnapshot();
  assert.equal(a,b);await a;
  await cold.ctx._refreshMarketPanelSnapshot();
  assert.equal(sharedCalls,2);
  assert.equal(cold.elements.mfTs.textContent,'午盘 11:30','New raw snapshot beats stale Pages snapshot');
  assert.equal(JSON.parse(cold.storage[KEY]).breadth.quoteTs,stamp('11:30'));

  // All-flat responses after session are rejected, leaving yesterday's full chart in place.
  const reset=setup({[KEY]:JSON.stringify(snapshot('15:00'))},stamp('16:20')+86400000);
  reset.ctx._emClistGet=async query=>{
    const pn=Number(new URLSearchParams(query).get('pn'));
    return {data:{total:600,diff:Array.from({length:100},(_,i)=>({f12:String(600000+(pn-1)*100+i),f13:1,f3:0,f124:(stamp('15:00')+86400000)/1000}))}};
  };
  reset.ctx._marketPanelsRestore();const before=reset.elements.mktBreadthChart.innerHTML;
  const pending1=reset.ctx._doFetchBreadth(),pending2=reset.ctx._doFetchBreadth();
  assert.equal(pending1,pending2);await pending1;
  assert.equal(reset.elements.mktBreadthChart.innerHTML,before);
  assert.equal(reset.elements.mktUp.textContent,'220');
  assert.ok(!reset.elements.mktBreadthChart.innerHTML.includes('非交易时段'));

  // One missing page fails quickly and leaves the last complete snapshot unchanged.
  let calls=0;
  reset.ctx._emClistGet=async query=>{calls++;const pn=Number(new URLSearchParams(query).get('pn'));return {data:{total:1000,diff:pn===1?Array.from({length:100},(_,i)=>({f12:String(600000+i),f13:1,f3:100})):[]}};};
  await reset.ctx._doFetchBreadth();assert.equal(calls,6,'No later batches after a missing page');
  assert.equal(reset.elements.mktBreadthChart.innerHTML,before);

  // Flow failure retains each side independently and requests are coalesced.
  reset.ctx._fetchMainFlowList=async()=>{throw Error('empty');};
  const f1=reset.ctx.fetchMainFlow(),f2=reset.ctx.fetchMainFlow();assert.equal(f1,f2);await f1;
  assert.equal((reset.elements.mfList.innerHTML.match(/portfolio-flow-row/g)||[]).length,20);
  assert.equal((reset.elements.mfOutList.innerHTML.match(/portfolio-flow-row/g)||[]).length,20);
  assert.equal(reset.elements.mfRefBtn.disabled,false);
  return 'PASS: lunch/close reload, offline retention, all-zero reset, pagination completeness, per-panel races, storage denial and shared cold-start fallback';
})();
