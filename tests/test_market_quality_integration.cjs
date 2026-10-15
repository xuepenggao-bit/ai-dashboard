const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=process.env.DASHBOARD_ROOT||path.resolve(__dirname,'..');
const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(root,'index.html'),'utf8');
const liveSource=fs.readFileSync(process.env.HIGH_LOW52_LIVE_JS||path.join(root,'assets/high-low-52w-live.js'),'utf8');
const maSource=fs.readFileSync(process.env.MA_BREADTH_UI||path.join(root,'assets/ma-breadth.js'),'utf8');
const qualitySource=fs.readFileSync(process.env.MARKET_QUALITY_JS||path.join(root,'assets/market-quality.js'),'utf8');
const realData=JSON.parse(fs.readFileSync(process.env.MARKET_QUALITY_DATA||path.join(root,'data/market_quality.json'),'utf8'));
const realBaseline=JSON.parse(fs.readFileSync(process.env.MARKET_QUALITY_BASELINE||path.join(root,'data/market_quality_baseline.json'),'utf8'));
const today='2026-10-15',previous='2026-10-14',defaultNow=Date.parse(today+'T10:15:00+08:00');
const maOnly='sz301999',qualityOnly='sz301998';
const hlStocks=Array.from({length:4000},(_,i)=>({code:'sh'+String(600000+i),firstDate:'2024-01-01',lastDate:previous,close:7,highs:[[previous,10]],lows:[[previous,5]]}));
const hlBaseline={schemaVersion:1,asOfDate:previous,validThrough:'2026-11-03',updatedAt:previous+'T18:00:00+08:00',stocks:hlStocks};
const maStocks=hlStocks.map(s=>({code:s.code,lastDate:previous,close:7,priorSums:{20:7*19,60:7*59,120:7*119}}));
maStocks.push({code:maOnly,lastDate:previous,close:7,priorSums:{20:7*19,60:null,120:null}});
const maBaseline={schemaVersion:1,windows:[20,60,120],asOfDate:previous,updatedAt:previous+'T18:00:00+08:00',stocks:maStocks};
const qualityBaseline={schemaVersion:1,scope:'沪深A股',asOfDate:previous,updatedAt:previous+'T18:00:00+08:00',stocks:[...maStocks,{code:qualityOnly,lastDate:previous,close:7}].map(s=>({code:s.code,lastDate:s.lastDate,close:s.close}))};
function nodes(source){const markup=source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,''),result=[],stack=[];
  for(const match of markup.matchAll(/<!--[\s\S]*?-->|<\/?(?:div|section)\b[^>]*>/gi)){if(match[0].startsWith('<!--'))continue;if(/^<\//.test(match[0])){const n=stack.pop();assert.ok(n);n.end=match.index+match[0].length;}else{const n={id:/\bid="([^"]*)"/.exec(match[0])?.[1]||'',start:match.index,parent:stack.at(-1)};result.push(n);stack.push(n);}}
  assert.equal(stack.length,0);return{markup,one(id){const found=result.filter(n=>n.id===id);assert.equal(found.length,1,id+' exists once');return found[0];}};}
function quote(code,change={}){const f=Array(90).fill('');Object.assign(f,{3:'8',4:'7',6:'10',30:'20261015101400',32:'14.29',33:'10',34:'6',37:'12345.67'},change);return'v_'+code+'="'+f.join('~')+'";';}
function context(config={}){
  const now=config.now||defaultNow;let requests=0,quoteRequests=0,quoteActive=0,maxQuoteActive=0,activeTab=true;
  const highLow=[],maCalls=[],qualityCalls=[],quotedCounts=new Map(),storage=new Map();
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const ctx=vm.createContext({module:{exports:{}},window:{addEventListener(){}},Date:FakeDate,Map,Set,Promise,Number,Math,Error,console:{warn(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},_highLow52Clock:()=>({date:today,minute:Math.floor((now-Date.parse(today+'T00:00:00+08:00'))/60000)}),
    _setHighLow52LivePoint:r=>{highLow.push(r);return true;},
    _idxFetch:async url=>{requests++;if(url.includes('market_ma_breadth_baseline.json')){if(config.noMa)throw Error('MA baseline unavailable');return maBaseline;}
      if(url.includes('market_quality_baseline.json'))return qualityBaseline;
      if(url.includes('market_high_low_52w_baseline.json'))return hlBaseline;
      if(url.includes('fqkline')){const code=/param=([^,]+)/.exec(url)[1];assert.equal(code,'sh000001');return{code:0,data:{[code]:{qfqday:[[previous],[today]]}}};}
      if(url.includes('qt.gtimg')){quoteRequests++;quoteActive++;maxQuoteActive=Math.max(maxQuoteActive,quoteActive);try{await Promise.resolve();const codes=/q=([^&]+)/.exec(url)[1].split(',');assert.ok(codes.length<=80,'At most80 quotes per request');return codes.map(code=>{if(!['sh000001','sz399106'].includes(code))quotedCounts.set(code,(quotedCounts.get(code)||0)+1);if(code===config.missingCode)return'';return quote(code,code===config.badAmountCode?{37:''}:{});}).join('\n');}finally{quoteActive--;}}
      throw Error('Unexpected URL '+url);
    }});
  vm.runInContext(maSource,ctx,{filename:'ma-breadth.js'});const maApi=ctx.module.exports,realMa=ctx.window.applyMaBreadthLiveQuotes;
  ctx.window.applyMaBreadthLiveQuotes=async(...args)=>{maCalls.push(args);return realMa(...args);};
  ctx.module={exports:{}};vm.runInContext(qualitySource,ctx,{filename:'market-quality.js'});const qualityApi=ctx.module.exports,realQuality=ctx.window.applyMarketQualityLiveQuotes;
  ctx.window.applyMarketQualityLiveQuotes=(...args)=>{qualityCalls.push(args);return realQuality(...args);};
  ctx.document={hidden:false,readyState:'loading',addEventListener(){},getElementById:id=>id==='t0'?{classList:{contains:()=>activeTab}}:null};
  vm.runInContext(liveSource,ctx,{filename:'high-low-52w-live.js'});
  return{ctx,maApi,qualityApi,highLow,maCalls,qualityCalls,quotedCounts,requests:()=>requests,quoteRequests:()=>quoteRequests,maxQuoteActive:()=>maxQuoteActive,setActive:v=>{activeTab=v;}};
}
test('bottom cards preserve order and account openings is the final market section',()=>{const dom=nodes(html),market=dom.one('t0'),ids=['maBreadthCard','marketRiskCard','etfSharesCard','marketMedianCard','marketConcentrationCard','accountOpeningCard'],cards=ids.map(id=>dom.one(id));cards.forEach(n=>assert.equal(n.parent,market));cards.slice(1).forEach((n,i)=>assert.ok(n.start>cards[i].end,ids[i]+' comes before '+ids[i+1]));assert.equal(dom.markup.slice(cards.at(-1).end,market.end-6).replace(/<!--[\s\S]*?-->/g,'').trim(),'');
  const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');const seen=new Set();for(const m of markup.matchAll(/\bid=["']([^"']+)["']/g)){assert.ok(!seen.has(m[1]),'Duplicate markup ID '+m[1]);seen.add(m[1]);}
  const stage=dom.one('tStage');for(const id of ['marketMedianCard','marketConcentrationCard'])assert.notEqual(dom.one(id).parent,stage);});
test('market quality registers before shared scanner and every inline script parses',()=>{const qualityAt=html.indexOf('<script src="assets/market-quality.js'),scannerAt=html.indexOf('<script src="assets/high-low-52w-live.js');assert.ok(qualityAt>=0&&scannerAt>qualityAt);assert.doesNotMatch(qualitySource,/qt\.gtimg\.cn\/q=/,'Quality does not create another quote scanner');
  for(const [index,m]of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()){if(/\bsrc\s*=/.test(m[1])||(/\btype\s*=/.test(m[1])&&!/(?:javascript|module)/.test(m[1])))continue;new vm.Script(m[2],{filename:'dashboard-inline-'+index+'.js'});}new vm.Script(qualitySource);new vm.Script(liveSource);});
test('real seed has60 validated observations and real Top20 sums match each ratio',()=>{const c=context({now:Math.max(defaultNow,Date.parse(realData.updatedAt)+1000,Date.parse(realBaseline.updatedAt)+1000)});assert.equal(realData.series.length,60);assert.ok(c.qualityApi.acceptPayload(realData));assert.equal(c.qualityApi.orderedRows().length,60);assert.ok(c.qualityApi.normalizeBaseline(realBaseline));for(const r of realData.series){assert.equal(r.top20.length,20);assert.equal(new Set(r.top20.map(s=>s.code)).size,20);assert.ok(Math.abs(r.top20.reduce((sum,s)=>sum+s.amountYuan,0)-r.top20AmountYuan)<.1);assert.ok(Math.abs(r.top20SharePct-r.top20AmountYuan/r.totalAmountYuan*100)<.000001);assert.ok(r.q25ReturnPct<=r.medianReturnPct&&r.medianReturnPct<=r.q75ReturnPct);assert.ok(r.eligibleCount>=4000);}});
test('one bounded quote pool includes quality-only stocks and serves all three indicators',async()=>{const c=context();await Promise.all([c.ctx.refreshHighLow52Live(true),c.ctx.refreshHighLow52Live(true)]);assert.equal(c.highLow.length,1);assert.equal(c.maCalls.length,1);assert.equal(c.qualityCalls.length,1);assert.equal(c.highLow[0].eligible,4000);assert.equal(c.maApi.ordered().at(-1).universe,4001);const r=c.qualityApi.orderedRows().at(-1);assert.ok(r);assert.equal(r.eligibleCount,4002);assert.equal(r.universeCount,4002);assert.equal(r.medianReturnPct,14.29);assert.ok(Math.abs(r.totalAmountYuan-4002*12345.67*10000)<.01);assert.ok(Math.abs(r.top20AmountYuan-20*12345.67*10000)<.01);assert.ok(Math.abs(r.top20SharePct-20/4002*100)<1e-12);assert.ok(c.qualityCalls[0][1].has(qualityOnly));assert.ok(c.qualityCalls[0][1].has(maOnly));assert.equal(c.qualityCalls[0][4],previous);assert.equal(c.quotedCounts.size,4002);assert.ok([...c.quotedCounts.values()].every(v=>v===1));assert.equal(c.quoteRequests(),1+Math.ceil(4002/80));assert.ok(c.maxQuoteActive()<=4);const count=c.requests();await c.ctx.refreshHighLow52Live();assert.equal(c.requests(),count);});
test('Tencent f37 is converted from万元 and f32 stays the quoted percentage',()=>{const c=context(),q=c.ctx._hl52Quotes(quote('sh600000'),['sh600000']).get('sh600000');assert.equal(q.amountYuan,123456700);assert.equal(q.returnPct,14.29);assert.equal(q.volume,10);});
test('missing quality-only quote preserves other complete publications and rejects quality subset',async()=>{const c=context({missingCode:qualityOnly});await c.ctx.refreshHighLow52Live(true);assert.equal(c.highLow.length,1);assert.equal(c.maApi.ordered().length,1);assert.equal(c.qualityCalls.length,1);assert.equal(c.qualityApi.orderedRows().length,0);});
test('invalid quality-only amount leaves high-low and MA intact',async()=>{const c=context({badAmountCode:qualityOnly});await c.ctx.refreshHighLow52Live(true);assert.equal(c.highLow.length,1);assert.equal(c.maApi.ordered().length,1);assert.equal(c.qualityApi.orderedRows().length,0);});
test('quality universe still extends quote pool when MA baseline is temporarily unavailable',async()=>{const c=context({noMa:true});await c.ctx.refreshHighLow52Live(true);assert.equal(c.highLow.length,1);assert.equal(c.maCalls.length,0);assert.equal(c.qualityApi.orderedRows().at(-1).eligibleCount,4002);assert.ok(c.quotedCounts.has(qualityOnly));});
test('a later live scan cannot replace a previously validated closing value',async()=>{const c=context({now:Date.parse(today+'T15:05:00+08:00')}),close={...realData.series.at(-1),date:today,asOf:'15:00',status:'close'};assert.ok(c.qualityApi.acceptPayload({...realData,updatedAt:today+'T15:01:00+08:00',series:[close]}));await c.ctx.refreshHighLow52Live(true);const r=c.qualityApi.orderedRows().at(-1);assert.equal(r.status,'close');assert.equal(r.medianReturnPct,close.medianReturnPct);assert.equal(r.top20SharePct,close.top20SharePct);});
test('hidden or inactive market tab performs no quote or baseline requests',async()=>{const hidden=context();hidden.ctx.document.hidden=true;await hidden.ctx.refreshHighLow52Live(true);assert.equal(hidden.requests(),0);const away=context();away.setActive(false);await away.ctx.refreshHighLow52Live(true);assert.equal(away.requests(),0);});
