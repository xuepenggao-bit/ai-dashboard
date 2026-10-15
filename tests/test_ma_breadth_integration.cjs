const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(__dirname,'../index.html'),'utf8');
const liveSource=fs.readFileSync(process.env.HIGH_LOW52_LIVE_JS||path.join(__dirname,'../assets/high-low-52w-live.js'),'utf8');
const maSource=fs.readFileSync(process.env.MA_BREADTH_UI||path.join(__dirname,'../assets/ma-breadth.js'),'utf8');
const today='2026-10-14',previous='2026-10-13',now=Date.parse(today+'T10:15:00+08:00');
const ipoCode='sz301999';
const hlStocks=Array.from({length:4000},(_,i)=>({code:'sh'+String(600000+i),firstDate:'2024-01-01',
  lastDate:previous,close:7,highs:[[previous,10]],lows:[[previous,5]]}));
const hlBaseline={schemaVersion:1,asOfDate:previous,validThrough:'2026-11-03',updatedAt:previous+'T18:00:00+08:00',stocks:hlStocks};
const maStocks=hlStocks.map(s=>({code:s.code,lastDate:previous,close:7,priorSums:{20:7*19,60:7*59,120:7*119}}));
maStocks.push({code:ipoCode,firstDate:'2026-09-01',lastDate:previous,close:7,priorSums:{20:7*19,60:null,120:null}});
const maBaseline={schemaVersion:1,windows:[20,60,120],asOfDate:previous,updatedAt:previous+'T18:00:00+08:00',stocks:maStocks};

// Track actual div ancestry, rather than accepting a matching ID in a comment,
// script string, or a dynamically rewritten child of chainMonitorRoot.
function divNodes(source){
  const markup=source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  const nodes=[],stack=[];
  for(const m of markup.matchAll(/<!--[\s\S]*?-->|<\/?(?:div|section)\b[^>]*>/gi)){
    if(m[0].startsWith('<!--'))continue;
    if(/^<\/(?:div|section)/i.test(m[0])){
      const node=stack.pop();assert.ok(node,'Every closing div has an opening div');node.end=m.index+m[0].length;continue;
    }
    const id=/\bid="([^"]*)"/.exec(m[0])?.[1]||'';
    const node={id,start:m.index,parent:stack.at(-1),openEnd:m.index+m[0].length};nodes.push(node);stack.push(node);
  }
  assert.equal(stack.length,0,'Dashboard div markup remains balanced');
  return {markup,nodes,one(id){const found=nodes.filter(n=>n.id===id);assert.equal(found.length,1,id+' appears exactly once');return found[0];}};
}

function quote(code,change={}){
  const f=Array(90).fill('');Object.assign(f,{3:'8',4:'7',6:'10',30:'20261014101400',33:'10',34:'6'},change);
  return 'v_'+code+'="'+f.join('~')+'";';
}
function context(config={}){
  let requests=0,quoteRequests=0,quoteActive=0,maxQuoteActive=0,activeTab=true;
  const highLow=[],maCalls=[],maErrors=[],quotedCounts=new Map(),saved=new Map();
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const ctx=vm.createContext({module:{exports:{}},window:{addEventListener(){}},Date:FakeDate,Map,Set,Promise,Number,Math,Error,
    console:{warn(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,
    localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},
    _highLow52Clock:()=>({date:today,minute:615}),
    _setHighLow52LivePoint:r=>{highLow.push(r);return true;},
    _idxFetch:async url=>{
      requests++;
      if(url.includes('market_ma_breadth_baseline.json'))return config.maBaseline||maBaseline;
      if(url.includes('market_high_low_52w_baseline.json'))return config.hlBaseline||hlBaseline;
      if(url.includes('fqkline')){
        const code=/param=([^,]+)/.exec(url)[1];
        assert.equal(code,'sh000001','Ordinary quotes need only one calendar request, no daily-price correction scan');
        return{code:0,data:{[code]:{qfqday:[[previous], [today]]}}};
      }
      if(url.includes('qt.gtimg')){
        quoteRequests++;quoteActive++;maxQuoteActive=Math.max(maxQuoteActive,quoteActive);
        try{
          await Promise.resolve();
          const codes=/q=([^&]+)/.exec(url)[1].split(',');
          return codes.map(code=>{
            if(!['sh000001','sz399106'].includes(code))quotedCounts.set(code,(quotedCounts.get(code)||0)+1);
            if(code===config.missingCode)return '';
            return quote(code);
          }).join('\n');
        }finally{quoteActive--;}
      }
      throw Error('Unexpected URL '+url);
    },
  });
  // Evaluate the real MA validation and publication path, not a permissive stub.
  // With document absent, it does not register or execute a browser startup.
  vm.runInContext(maSource,ctx,{filename:'ma-breadth.js'});
  const maApi=ctx.module.exports,realApply=ctx.window.applyMaBreadthLiveQuotes;
  ctx.window.applyMaBreadthLiveQuotes=async(...args)=>{
    maCalls.push({base:args[0],quotes:args[1],date:args[2],asOf:args[3],previous:args[4]});
    try{return await realApply(...args);}catch(error){maErrors.push(error);throw error;}
  };
  ctx.document={hidden:false,readyState:'loading',addEventListener(){},getElementById:()=>({classList:{contains:()=>activeTab}})};
  vm.runInContext(liveSource,ctx,{filename:'high-low-52w-live.js'});
  return{ctx,maApi,highLow,maCalls,maErrors,quotedCounts,requests:()=>requests,quoteRequests:()=>quoteRequests,
    maxQuoteActive:()=>maxQuoteActive,setActive:value=>{activeTab=value;}};
}

const cases=[];function test(name,fn){cases.push([name,fn]);}
test('KOL remains the final industry sibling; market risk and ETF shares follow MA breadth',()=>{
  const dom=divNodes(html),market=dom.one('t0'),stage=dom.one('tStage'),root=dom.one('chainMonitorRoot'),ai=dom.one('aiIndustryContext');
  const kol=dom.one('kolCard'),ma=dom.one('maBreadthCard'),grid=dom.one('kolGrid');
  assert.equal(root.parent,stage);assert.equal(ai.parent,stage);assert.equal(kol.parent,stage,'KOL cannot be overwritten by chain rendering');
  assert.ok(grid.start>kol.start&&grid.end<kol.end);assert.ok(kol.start>ai.end);
  assert.equal(dom.markup.slice(kol.end,stage.end-6).replace(/<!--[\s\S]*?-->/g,'').trim(),'','KOL is at the very bottom of industry monitoring');
  assert.equal(ma.parent,market);assert.ok(ma.start>dom.one('accountOpeningCard').end);
  const risk=dom.one('marketRiskCard'),etf=dom.one('etfSharesCard');
  assert.equal(risk.parent,market);assert.equal(etf.parent,market);
  assert.ok(risk.start>ma.end&&etf.start>risk.end,'Risk and ETF cards follow the existing MA breadth');
  assert.equal(dom.markup.slice(etf.end,market.end-6).replace(/<!--[\s\S]*?-->/g,'').trim(),'','ETF shares are at the bottom of market environment');
  assert.ok(!(grid.start>market.start&&grid.end<market.end),'KOL is not duplicated in the market tab');
  for(const id of ['kolBtn','kolCount','kolTs','cMaBreadth','maBreadthKpi20','maBreadthKpi60','maBreadthKpi120'])
    assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id+' appears exactly once');
});
test('KOL loads on industry-tab access, not initial DOMContentLoaded; MA registers before the shared scanner',()=>{
  const stageBranch=/else if\(tab==='tStage'\)\s*\{[^}]*fetchKolSummary\(\);[^}]*\}/.exec(html);
  assert.ok(stageBranch,'Entering the industry tab reads KOL summary');
  const withoutBranch=html.replace(stageBranch[0],'').replace(/async function fetchKolSummary\(force\)/,'');
  assert.doesNotMatch(withoutBranch,/\bfetchKolSummary\s*\(/,'No eager startup or duplicate KOL fetch owner remains');
  assert.match(html,/onclick="triggerKolRefresh\(\)"/,'Manual refresh remains wired');
  const maAsset=html.indexOf('<script src="assets/ma-breadth.js'),scanAsset=html.indexOf('<script src="assets/high-low-52w-live.js');
  assert.ok(maAsset>=0&&scanAsset>maAsset,'MA callback exists before the shared scanner registers');
  assert.doesNotMatch(maSource,/qt\.gtimg\.cn\/q=/,'MA does not start a second full-market quote pool');
});
test('one bounded full-market scan includes younger MA listings and shares the previous trading day',async()=>{
  const c=context();assert.equal(c.maApi.validBaseline(maBaseline),true);
  await Promise.all([c.ctx.refreshHighLow52Live(true),c.ctx.refreshHighLow52Live(true)]);
  assert.equal(c.highLow.length,1);assert.equal(c.highLow[0].high,4000);assert.equal(c.highLow[0].eligible,4000);
  assert.equal(c.maCalls.length,1);const applied=c.maCalls[0];
  assert.equal(applied.quotes.size,4001,'MA receives its entire universe, not the 52-week subset');
  assert.ok(applied.quotes.has(ipoCode),'A recent listing with 20 daily bars participates in MA');
  assert.equal(applied.base.stocks.length,4001);assert.equal(applied.previous,previous);assert.equal(applied.date,today);assert.equal(applied.asOf,'10:14');
  const row=c.maApi.ordered().at(-1);assert.equal(row.universe,4001);
  assert.equal(row.windows[20].eligible,4001);assert.equal(row.windows[60].eligible,4000);assert.equal(row.windows[120].eligible,4000);
  assert.equal(row.windows[20].pct,100);assert.equal(c.maErrors.length,0);
  assert.equal(c.quoteRequests(),1+Math.ceil(4001/80),'Exactly one index request and one whole-market batch pool');
  assert.equal(c.quotedCounts.size,4001);assert.ok([...c.quotedCounts.values()].every(count=>count===1),'Each stock quoted once per scan');
  assert.ok(c.maxQuoteActive()<=4,'Quote worker concurrency never exceeds four');
  const count=c.requests();await c.ctx.refreshHighLow52Live();assert.equal(c.requests(),count,'Five-minute shared throttle');
});
test('an MA-only missing quote does not block complete 52-week data or publish a subset MA percentage',async()=>{
  const c=context({missingCode:ipoCode});await c.ctx.refreshHighLow52Live(true);
  assert.equal(c.highLow.length,1,'52-week universe is complete and remains publishable');assert.equal(c.highLow[0].high,4000);
  assert.equal(c.maCalls.length,1);assert.equal(c.maCalls[0].quotes.size,4000);
  assert.equal(c.maApi.ordered().length,0,'Real MA validation rejects the incomplete independent universe');
  assert.equal(c.maErrors.length,1);assert.match(c.maErrors[0].message,/报价/);
});
test('a missing quote required by 52-week data blocks both publications',async()=>{
  const c=context({missingCode:'sh600000'});await c.ctx.refreshHighLow52Live(true);
  assert.equal(c.highLow.length,0);assert.equal(c.maCalls.length,0);assert.equal(c.maApi.ordered().length,0);
});
test('an MA baseline from the wrong trading day is not used; the 52-week path remains available',async()=>{
  const c=context({maBaseline:{...maBaseline,asOfDate:'2026-10-12',stocks:maStocks.map(s=>({...s,lastDate:'2026-10-12'})),updatedAt:'2026-10-12T18:00:00+08:00'}});
  await c.ctx.refreshHighLow52Live(true);assert.equal(c.highLow.length,1);assert.equal(c.maCalls.length,0);assert.equal(c.maApi.ordered().length,0);
});
test('hidden pages and leaving the market tab make no quote or baseline requests',async()=>{
  const hidden=context();hidden.ctx.document.hidden=true;await hidden.ctx.refreshHighLow52Live(true);assert.equal(hidden.requests(),0);
  const away=context();away.setActive(false);await away.ctx.refreshHighLow52Live(true);assert.equal(away.requests(),0);
});

module.exports=(async()=>{
  for(const [name,fn] of cases){await fn();console.log('PASS:',name);}
  return 'PASS: '+cases.length+' market breadth and KOL integration tests';
})();
