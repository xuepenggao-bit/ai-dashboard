const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(process.env.TEST_HTML||path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('const _IDX_TENCENT ='),html.indexOf('// ── 国债收益率'));
const bootstrap=JSON.parse(html.match(/INDEX_SNAPSHOT_START \*\/\s*([\s\S]*?)\s*\/\* INDEX_SNAPSHOT_END/)[1]);
function context(saved={},denyStorage=false){
  const list={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
  const storage={...saved};
  const ctx=vm.createContext({Date,Map,Set,Promise,AbortController,TextDecoder,setTimeout,clearTimeout,
    console:{warn(){}},window:{},_ahPrem:null,_csiPct:null,updateRiskDashboard(){},
    localStorage:{getItem:k=>{if(denyStorage)throw Error('SecurityError');return storage[k]||null;},setItem:(k,v)=>{if(denyStorage)throw Error('SecurityError');storage[k]=v;}},
    document:{getElementById:id=>id==='portIndexList'?list:null},_escH:String,
    _portfolioIndexDisplayPct:(r,p)=>p,_isTradingNow:()=>false});
  vm.runInContext(source,ctx);
  return {ctx,list,storage};
}
module.exports=(async()=>{
  const {ctx,list}=context({},true);
  const order=Array.from(vm.runInContext('_IDX_ORDER',ctx));
  assert.equal(Object.keys(bootstrap.quotes).length,15,'Deployment must include all 15 genuine bootstrap quotes');
  order.forEach(label=>{
    const quote=bootstrap.quotes[label];
    assert.ok(quote&&quote.price>0&&Number.isFinite(quote.pct),label+' needs a numeric price and move');
    assert.ok(quote.quoteTs>0&&quote.src,label+' needs a source and real quote time');
  });
  const initial=ctx._idxListHtml({});
  assert.equal((initial.match(/data-idx-label=/g)||[]).length,15);
  assert.ok(!/暂缺|加载中|自动重试/.test(initial),'Cold Safari with no storage must display all quote values');
  assert.ok(initial.includes('备份')&&initial.includes('后台备份 · 行情时间'),'Fallback must never masquerade as live');
  // Total external outage must leave all 15 values visible, including in private browsing.
  ctx._idxFetch=async()=>{throw Error('network unavailable');};
  ctx._idxJsonp=async()=>{throw Error('script blocked');};
  ctx._fetchSinaRT=async()=>({});
  await ctx.fetchIndexPrices();
  assert.equal((list.innerHTML.match(/data-idx-label=/g)||[]).length,15);
  assert.ok(!/暂缺|加载中|自动重试/.test(list.innerHTML));
  const now=Date.now();
  const live={label:'台湾加权',region:'intl',price:51000,pct:1,quoteTs:now,src:'em'};
  const seq=vm.runInContext('_IDX_REQ_SEQ',ctx);
  ctx._idxPublishNonHkRow(live,seq);
  assert.equal(ctx._idxApplySnapshot({quotes:{'台湾加权':{...live,price:50000,quoteTs:now-60000}}}),0);
  assert.equal(vm.runInContext('_IDX_CACHE["台湾加权"].price',ctx),51000);
  ctx._idxPublishNonHkRow({...live,price:49000,quoteTs:0},seq);
  assert.equal(vm.runInContext('_IDX_CACHE["台湾加权"].price',ctx),51000,'An untimed quote cannot replace a timestamped value');
  assert.equal(ctx._idxApplySnapshot({quotes:{'台湾加权':{...live,quoteTs:now+3600000}}}),0,'Reject future snapshots');
  assert.equal(ctx._idxApplySnapshot({quotes:{'台湾加权':{...live,price:0,quoteTs:now+1000}}}),0,'Never fill with fake zero');
  const c=context().ctx;
  let reads=0;
  c._idxFetch=async url=>{
    reads++;
    return {quotes:{'台湾加权':{...live,price:url.startsWith('./')?50100:51100,quoteTs:now+(url.startsWith('./')?1000:2000)}}};
  };
  const a=c._idxRefreshSnapshot(),b=c._idxRefreshSnapshot();
  assert.equal(a,b);
  await a;await c._idxRefreshSnapshot();
  assert.equal(reads,2,'Coalesce and throttle shared snapshot fetches');
  assert.equal(vm.runInContext('_IDX_CACHE["台湾加权"].price',c),51100,'Newer raw snapshot wins over stale Pages data');
  const row=vm.runInContext('_IDX_CACHE["台湾加权"]',c);
  assert.ok(row.snapshot);
  c._idxPublishNonHkRow({...live,quoteTs:now+3000},0);
  assert.ok(!vm.runInContext('_IDX_CACHE["台湾加权"].snapshot',c),'Realtime data clears the backup flag');
  // A corrupted browser cache must not prevent the embedded snapshot from loading.
  assert.ok(!context({'aiDashboard.allIndices.quote.v1':'not json'}).ctx._idxListHtml({}).includes('加载中'));
  return 'PASS: all-15 cold start, private mode, complete outage, backup labels, timestamp arbitration, raw/Pages race and fetch throttling';
})();
