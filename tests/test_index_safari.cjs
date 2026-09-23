const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(process.env.TEST_HTML||path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('const _IDX_TENCENT ='),html.indexOf('// ── 国债收益率'));
function context(saved={}){
  const storage={...saved};
  const ctx=vm.createContext({Date,Map,Set,Promise,AbortController,TextDecoder,setTimeout,clearTimeout,
    console:{warn(){}},window:{},localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>storage[k]=v},
    document:{getElementById:()=>null},_escH:String,_portfolioIndexDisplayPct:(r,p)=>p,_isTradingNow:()=>true});
  vm.runInContext(source,ctx);
  return {ctx,storage};
}
module.exports=(async()=>{
  const {ctx,storage}=context();
  const empty=ctx._idxListHtml({});
  const labels=[...empty.matchAll(/data-idx-label="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(labels.length,15,'Failed feeds must not remove any index');
  assert.deepEqual(labels,Array.from(vm.runInContext('_IDX_ORDER',ctx)));
  assert.equal((empty.match(/role="group"/g)||[]).length,5);
  assert.ok(empty.indexOf('A股平均股价')<empty.indexOf('恒生指数'));
  assert.ok(empty.indexOf('A/H溢价')<empty.indexOf('韩国KOSPI200'));
  assert.ok(!html.includes('.port-index-row.port-index-group-end'));
  const idx={label:'台湾加权',code:'TWII',region:'intl',secids:['100.TWII']};
  const now=Date.now();
  const row={...idx,price:12345.67,pct:1.2,quoteTs:now,src:'em'};
  ctx._idxPublishNonHkRow(row,0);
  assert.ok(ctx._idxListHtml({}).includes('12345.67'));
  assert.ok(ctx._idxListHtml({}).includes('沿用'));
  const restored=context(storage).ctx;
  assert.ok(restored._idxListHtml({}).includes('12345.67'),'Persist overseas quotes across Safari reloads');
  ctx._idxPublishNonHkRow({...row,price:100,quoteTs:now-60000},0);
  assert.equal(vm.runInContext('_IDX_CACHE["台湾加权"].price',ctx),12345.67,'No older fallback may replace newer quote');
  ctx._idxPublishNonHkRow({...row,price:200},1);
  assert.equal(vm.runInContext('_IDX_CACHE["台湾加权"].price',ctx),12345.67,'Ignore stale refresh rounds');
  assert.equal(ctx._idxEmListRows({data:{diff:{0:{f12:'TWII',f2:100,f3:0}}}},[idx])[0].pct,0);
  assert.equal(ctx._idxEmListRows({data:{diff:[{f12:'KOSPI',f2:100,f3:1}]}},[idx]).length,0);
  const stamp=new Date(now+8*3600000).toISOString().slice(0,16).replace('T',' ');
  const payload={data:{code:'TWII',preClose:100,trends:[stamp+',100,105,106,99,0,0,102']}};
  const minute=ctx._idxMinuteRow(idx,payload);
  assert.equal(minute.price,105,'Use last minute close, not open/high/average');
  assert.ok(Math.abs(minute.pct-5)<1e-8);
  assert.equal(minute.quoteTs,Date.parse(stamp.replace(' ','T')+':00+08:00'));
  assert.equal(ctx._idxMinuteRow(idx,{data:{...payload.data,preClose:0}}),null);
  assert.equal(ctx._idxMinuteRow(idx,{data:{...payload.data,code:'KOSPI'}}),null);
  let minuteCalls=0;
  ctx._idxFetch=async()=>{minuteCalls++;return payload;};
  assert.ok(await ctx._idxFetchMinuteRow(idx));
  assert.equal(await ctx._idxFetchMinuteRow(idx),null);
  assert.equal(minuteCalls,1,'Minute fallback is throttled to 30 seconds');
  let removed=0,appended=0;
  ctx.document.createElement=()=>({remove(){removed++;}});
  ctx.document.head={appendChild(script){
    appended++;
    const cb=new URL(script.src).searchParams.get('cb');
    setTimeout(()=>ctx.window[cb]({data:{diff:[{f12:'TWII',f2:100,f3:0}]}}),0);
  }};
  let published=0;
  await ctx._idxFetchEmBatch([idx],()=>published++);
  assert.equal(appended,2,'Only two batched JSONP requests per refresh, not one per index');
  assert.equal(removed,2);
  assert.equal(published,2);
  assert.equal(Object.keys(ctx.window).length,0,'Clean successful JSONP callbacks');
  // Simulate cross-origin fetch failures while the independent minute endpoint succeeds.
  const integration=context().ctx;
  const list={innerHTML:'',querySelectorAll(){return [];},querySelector(){return null;}};
  const button={disabled:false};
  integration.document.getElementById=id=>id==='portIndexList'?list:id==='idxRefBtn'?button:null;
  integration._idxFetch=async url=>{
    if(url.includes('push2his')){
      const code=new URL(url).searchParams.get('secid').split('.')[1];
      return {data:{...payload.data,code}};
    }
    throw new Error('Safari network failure');
  };
  integration._idxFetchEmBatch=async()=>[];
  await integration._fetchIndexPricesOnce();
  assert.equal((list.innerHTML.match(/data-idx-label=/g)||[]).length,15);
  assert.ok(/data-idx-label="台湾加权"[\s\S]*?105\.00/.test(list.innerHTML));
  assert.ok(/data-idx-label="韩国KOSPI200"[\s\S]*?105\.00/.test(list.innerHTML));
  assert.equal(button.disabled,false);
  const broken=context({'aiDashboard.allIndices.quote.v1':'{invalid'}).ctx;
  assert.ok(broken._idxListHtml({}).includes('韩国KOSPI200'));
  return 'PASS: fixed 15 slots / 5 groups, sticky cache, timestamp guard, JSONP batching, minute fallback, Safari failure recovery';
})();
