const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const NOW=Date.parse('2026-11-05T10:20:00+08:00');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function extract(name){const match=new RegExp('^(?:async )?function '+name+'\\(', 'm').exec(html);assert.ok(match,'Production function '+name);const end=html.indexOf('\n}',match.index);assert.ok(end>match.index);return html.slice(match.index,end+2);}
function fixture(options={}){
  const stamp=options.now||NOW,calls=[],backend=[],events=[],elements=new Map();let items=options.items||[{id:'highLow52',label:'52周新高新低',state:'stale',cadence:'intraday',message:'昨天数据'}];
  const classes=new Set(),button={disabled:false,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}};
  elements.set('macroBtnRefresh',button);elements.set('macroTs',{textContent:'',title:''});elements.set('macroAlert',{style:{}});elements.set('marketBackfillStatus',{textContent:''});
  class Clock extends Date{constructor(...args){super(...(args.length?args:[stamp]));}static now(){return stamp;}}
  const run=name=>async force=>{calls.push([name,force]);events.push(name);return true;};
  const win={refreshMaBreadth:run('ma'),refreshMarketRisk:run('risk'),refreshEtfShares:run('etf'),refreshMarketQuality:run('quality'),refreshMarketHeat:run('heat'),AccountOpenings:{refresh:run('accounts')},
    MarketEnvironmentFreshness:{inspect:()=>{events.push('inspect');return items;}},
    MarketBackfillRefresh:{request:arg=>{events.push('backend');backend.push(arg);return options.backendPromise||Promise.resolve({state:'running'});}},
    MarketCloseRefresh:{observe:()=>{events.push('close-observe');}}};
  Object.assign(win,options.window||{});
  const ctx=vm.createContext({Date:Clock,console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,Promise,Number,Array,
    document:{getElementById:id=>elements.get(id)||null},window:win,TAB_ORDER:['tPort','t0'],_TAB_TS:{},
    _beijingMarketClock:()=>({day:4,minutes:Math.floor((stamp/60000+480)%1440)}),
    fetchMacroKpis:run('kpis'),fetchDailyCharts:run('daily'),refreshHighLow52:run('highLow'),refreshBreadthTrendLive:run('breadthLive'),fetchVixChart:run('vix'),
    ...options.values});
  for(const name of ['_macroRefreshTask','_macroRefreshCaption','refreshMacro'])vm.runInContext(extract(name),ctx);
  return{ctx,win,calls,backend,events,elements,button,classes,setItems:value=>{items=value;}};
}

test('explicit manual click during an automatic round queues exactly one genuinely forced follow-up',async()=>{
  const gate=defer();let daily=0;
  const f=fixture({values:{fetchDailyCharts:async()=>++daily===1?gate.promise:true}});
  const auto=f.ctx.refreshMacro({reason:'auto'});await flush();
  const manualA=f.ctx.refreshMacro({force:true,reason:'manual'}),manualB=f.ctx.refreshMacro({force:true,reason:'manual'});
  assert.equal(daily,1);assert.equal(f.backend.length,0);gate.resolve(true);
  const [autoReport,a,b]=await Promise.all([auto,manualA,manualB]);await flush();
  assert.equal(autoReport.forced,false);assert.equal(a,b);assert.equal(a.forced,true);assert.equal(daily,2);
  assert.equal(f.backend.length,1);assert.equal(f.ctx.refreshMacro.manualQueued,null);
  assert.equal(f.button.disabled,false);
});

test('a current manual round does not swallow additional clicks into independent backend dispatches',async()=>{
  const gate=defer();let daily=0;
  const f=fixture({values:{fetchDailyCharts:async()=>{daily++;return gate.promise;}}});
  const first=f.ctx.refreshMacro({force:true,reason:'manual'});await flush();
  const again=f.ctx.refreshMacro({force:true,reason:'manual'});gate.resolve(true);
  await Promise.all([first,again]);await flush();
  // The backfill controller also deduplicates, but the shared frontend scan
  // should ideally be reused rather than repeated for the same manual intent.
  assert.equal(daily,1);assert.equal(f.backend.length,1);
});

test('manual freshness inspection and backend selection wait for both shared live scan promises',async()=>{
  const live=defer(),quality=defer();let liveDone=false,qualityDone=false;
  const f=fixture({values:{refreshHighLow52Live:async force=>{assert.equal(force,true);await live.promise;liveDone=true;}},window:{marketQualityClosePending:()=>quality.promise}});
  const pending=f.ctx.refreshMacro({force:true,reason:'manual'});await flush();
  assert.equal(f.backend.length,0);assert.equal(f.events.includes('inspect'),false);
  live.resolve();await flush();assert.equal(liveDone,true);assert.equal(f.backend.length,0);
  quality.resolve();quality.promise.then(()=>{qualityDone=true;});await pending;await flush();
  assert.equal(qualityDone,true);assert.equal(f.backend.length,1);assert.equal(f.backend[0].items[0].state,'stale');
});

test('reading old JSON successfully still starts backend recovery instead of treating the read as freshness',async()=>{
  const f=fixture();const report=await f.ctx.refreshMacro({force:true,reason:'manual'});await flush();
  assert.equal(report.results.filter(x=>x.required).every(x=>x.ok),true);
  assert.equal(f.backend.length,1);assert.equal(f.backend[0].reason,'manual');assert.equal(f.backend[0].items[0].state,'stale');
  assert.deepEqual([...report.freshnessPending],['52周新高新低']);assert.match(f.elements.get('macroTs').textContent,/待更新/);
});

test('automatic, close, and backfill refresh callbacks cannot recursively dispatch recovery workflows',async()=>{
  for(const reason of ['auto','close','backfill']){
    const f=fixture();await f.ctx.refreshMacro({force:true,reason});await flush();assert.equal(f.backend.length,0,reason);
  }
});

test('latest backend KPI snapshot is awaited then applied before any freshness inspection',async()=>{
  const snapshot=defer();let applied=false;
  const f=fixture({window:{MarketKpiSnapshot:{refresh:async force=>{assert.equal(force,true);await snapshot.promise;f.events.push('snapshot-loaded');},apply:()=>{applied=true;f.events.push('snapshot-apply');f.setItems([{id:'caps',label:'沪深A股市值',state:'current',cadence:'intraday'}]);}}}});
  const pending=f.ctx.refreshMacro({force:true,reason:'manual'});await flush();assert.equal(applied,false);assert.equal(f.events.includes('inspect'),false);
  snapshot.resolve();await pending;await flush();assert.equal(applied,true);
  assert.ok(f.events.indexOf('snapshot-loaded')<f.events.indexOf('snapshot-apply'));assert.ok(f.events.indexOf('snapshot-apply')<f.events.indexOf('inspect'));
  assert.equal(f.backend[0].items[0].state,'current');
});

test('slow background acceptance or eight-minute job tracking never keeps the refresh button locked',async()=>{
  const backend=defer(),f=fixture({backendPromise:backend.promise});
  const report=await f.ctx.refreshMacro({force:true,reason:'manual'});await flush();
  assert.ok(report);assert.equal(f.backend.length,1);assert.equal(f.button.disabled,false);assert.equal(f.classes.has('loading'),false);assert.equal(f.ctx.refreshMacro.pending,null);
  backend.resolve({state:'running'});
});

test('an optional snapshot outage or backend dispatch rejection does not erase valid frontend results',async()=>{
  const f=fixture({window:{MarketKpiSnapshot:{refresh:async()=>{throw Error('offline');},apply:()=>{}},MarketBackfillRefresh:{request:async()=>{throw Error('denied');}}}});
  const report=await f.ctx.refreshMacro({force:true,reason:'manual'});await flush();
  assert.equal(report.ok,true);assert.equal(report.results.find(x=>x.name==='后台指标快照').ok,false);
  assert.equal(f.button.disabled,false);assert.match(f.elements.get('marketBackfillStatus').textContent,/未确认/);
});

test('manual recovery has a separate accessible status region and sources load before the handler',()=>{
  assert.match(html,/<div id="marketBackfillStatus" role="status" aria-live="polite"/);
  assert.match(html,/onclick="refreshMacro\(\{force:true,reason:'manual'\}\)"/);
  assert.ok(html.indexOf('assets/market-backfill-refresh.js')<html.indexOf('async function refreshMacro('));
  assert.ok(html.indexOf('assets/market-kpi-snapshot.js')<html.indexOf('async function refreshMacro('));
});
