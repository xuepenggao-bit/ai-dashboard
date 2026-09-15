const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('const _IDX_TENCENT ='),html.indexOf('// 从「主要指数」DOM'));
const sina=html.slice(html.indexOf('const _sinaRtInflight='),html.indexOf('async function fetchPortPrices()'));
const ctx=vm.createContext({Date,Map,Set,Promise,AbortController,TextDecoder,setTimeout,clearTimeout,
  console:{warn(){}},localStorage:{getItem(){return null;},setItem(){}},document:{getElementById(){return null;}},
  _portfolioIndexDisplayPct:(r,p)=>p,_isTradingNow:()=>true,_escH:String});
vm.runInContext(source+sina,ctx);
module.exports=(async()=>{
  const now=Date.now();
  const row=(ts,price=24919.40,src='sina')=>({label:'恒生指数',price,pct:0.46,region:'hk',quoteTs:ts,src});
  assert.equal(ctx._idxShouldAcceptHkQuote('恒生指数',row(now-900000,24901.08,'tc'),row(now),now),false);
  assert.equal(ctx._idxShouldAcceptHkQuote('恒生指数',row(now+1000),row(now),now+1000),true);
  assert.equal(ctx._idxShouldAcceptHkQuote('恒生指数',row(now-1000),row(now),now),false);
  assert.equal(ctx._idxShouldAcceptHkQuote('恒生指数',row(now-1000),row(now,24919.4,'tc'),now),false,'Primary source cannot roll back time either');
  assert.equal(ctx._idxShouldAcceptHkQuote('恒生指数',row(now,999999),null,now),false);
  assert.equal(ctx._idxShouldAcceptHkQuote('恒生指数',row(now+3600000),null,now),false);
  assert.ok(ctx._idxRowHtml(row(now),now).includes('24919.40'),'Do not round index points to integers');
  for(const label of ['恒生指数','恒生科技','A/H溢价']){
    const markup=ctx._idxRowHtml({...row(now),label},now);
    assert.ok(!/\d{2}:\d{2}:\d{2}/.test(markup),'No synchronization time beneath HK-related indices');
    assert.ok(!markup.includes('display:block'),'No second timestamp line');
  }
  assert.ok(ctx._idxRowHtml(row(now-900000,24901.08,'tc'),now).includes('延迟'));
  assert.ok(!ctx._idxRowHtml(row(now,24919.4,'tc_rt'),now).includes('延迟'),'Realtime Tencent must not be labelled as the delayed feed');
  assert.equal(ctx._idxShouldAcceptHkQuote('恒生指数',row(now-900000,24901.08,'tc'),row(now,24919.4,'tc_rt'),now),false);
  const fields=Array(33).fill('');
  fields[3]='24897.990';fields[4]='24805.630';fields[30]='2026/09/14 15:52:06';fields[32]='0.37';
  const rt=ctx._idxParseTencentHk('v_r_hkHSI="'+fields.join('~')+'";',true);
  assert.equal(rt['恒生指数'].src,'tc_rt');
  assert.equal(rt['恒生指数'].price,24897.99);
  assert.equal(rt['恒生指数'].quoteTs,Date.parse('2026-09-14T15:52:06+08:00'));
  assert.equal(Object.keys(ctx._idxParseTencentHk('v_r_hkHSI="'+fields.join('~')+'";',false)).length,0);
  assert.equal(ctx._idxChooseHkCandidate('恒生指数',[row(now-1000),row(now)]).quoteTs,now);
  const originalFetch=ctx._idxFetch;
  ctx.fetch=async(url,{signal})=>({ok:true,json:()=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('body timeout')));
  })});
  await assert.rejects(originalFetch('https://test.invalid',{timeout:15,retries:0}),/body timeout/);
  const seen=[];
  ctx._idxFetch=async url=>{
    if(url.includes('/stock/')){
      await new Promise(r=>setTimeout(r,10));
      return {data:{f57:'HSI',f43:24919.4,f170:.46,f86:Math.floor(now/1000)}};
    }
    return {data:{diff:[{f12:'HSI',f2:24901.08,f3:.38,f124:Math.floor(now/1000)-900}]}};
  };
  const em=await ctx._fetchEmIndexRow({secids:['100.HSI'],code:'HSI',label:'恒生指数',region:'hk'},r=>seen.push(r));
  assert.equal(seen.length,2,'Both racing source responses must be considered');
  assert.equal(em.price,24919.4,'Select newer response, not fastest response');
  ctx._idxFetch=async()=>({data:{f57:'WRONG',f43:24919.4,f170:.46,f86:Math.floor(now/1000)}});
  assert.equal(await ctx._fetchEmIndexRow({secids:['100.HSI'],code:'HSI',label:'恒生指数',region:'hk'}),null);
  let hkCalls=0,finishMain;
  ctx._fetchHkIndices=async()=>{hkCalls++;};
  ctx._fetchIndexPricesOnce=()=>new Promise(r=>{finishMain=r;});
  const main=ctx.fetchIndexPrices();ctx.fetchIndexPrices();
  assert.equal(hkCalls,2,'Slow non-HK indices must not block HK refresh');
  vm.runInContext('_IDX_PENDING=false',ctx);finishMain();await main;
  ctx.window={};let appends=0;
  ctx.document.createElement=()=>({});
  ctx.document.head={appendChild(script){
    appends++;
    assert.ok(script.src.includes('/?_='));
    setTimeout(()=>{
      ctx.window.hq_str_rt_hkHSI='HSI,name,24701.180,24805.631,24926.240,24662.110,24919.400,113.770,0.460,2026/09/14,15:35:40';
      script.onload();
    },1);
  }};
  const first=ctx._fetchSinaRT(['rt_hkHSI']);
  const second=ctx._fetchSinaRT(['rt_hkHSI']);
  assert.equal(first,second,'Identical Sina scripts must be coalesced');
  assert.equal((await first).rt_hkHSI.price,24919.4);
  assert.equal(appends,1);
  assert.equal(Object.keys(ctx.window).length,0);
  return 'PASS: HK precision, delayed quotes, timestamp guards, full-body timeout, newest EM response, code validation, independent refresh and Sina coalescing';
})();
