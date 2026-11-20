const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api=require('../assets/ai-global-market.js');
const series=(values,dates=values.map((_,i)=>`2026-10-${String(i+1).padStart(2,'0')}`))=>values.map((close,i)=>({date:dates[i],close}));
function market(){return{id:'us',name:'美国',currency:'USD',benchmark:{symbol:'SPX',name:'S&P500',sourceUrl:'https://example.com/spx',series:series([100,105,110])},stocks:[{name:'A',symbol:'A',sourceUrl:'https://example.com/a',series:series([100,120,130])},{name:'B',symbol:'B',sourceUrl:'https://example.com/b',series:series([200,200,240])}]};}
test('equal initial notional sample does not secretly become a daily rebalanced or cap weighted index',()=>{
  const m=api.marketModel(market());
  assert.ok(Math.abs(m.sampleReturn('2026-10-01','2026-10-03')-25)<1e-9);
  assert.ok(Math.abs(m.benchmarkReturn('2026-10-01','2026-10-03')-10)<1e-9);
  assert.equal(m.month.sample,null);assert.equal(m.stockMoves.length,2);
});
test('per-market common dates exclude missing constituents, then chart holidays stay null',()=>{
  const a=market(),b=market();b.id='kr';b.name='韩国';
  b.stocks[0].series.splice(1,1);
  const models=[api.marketModel(a),api.marketModel(b)],chart=api.chartSeries(models,20,false);
  assert.deepEqual(models[1].dates,['2026-10-01','2026-10-03']);
  assert.equal(chart.datasets[1].data[1],null);assert.equal(chart.datasets[1].spanGaps,false);
  assert.equal(chart.datasets[0].data[0],0);
  assert.ok(Math.abs(api.chartSeries(models,20,true).datasets[0].data.at(-1)-15)<1e-9);
});
test('module is first in industry monitoring and independently lazy-loaded without remote chart dependencies',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),js=fs.readFileSync(path.join(__dirname,'../assets/ai-global-market.js'),'utf8');
  assert.match(html,/<div class="tab-content" id="tStage">\s*<div id="aiGlobalMarketRoot"/);
  assert.ok(html.indexOf('id="aiGlobalMarketRoot"')<html.indexOf('id="aiCycleMonitorRoot"'));
  assert.match(js,/if\(!tab.classList.contains\('active'\)\|\|document.hidden\)return false/);
  assert.match(js,/Promise\.allSettled/);assert.match(js,/case|escape/);
});
test('published price sample has four verified market identities and sufficient, ordered close points',()=>{
  const d=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/ai_global_market_prices.json')));
  assert.equal(api.validPrices(d),true);
  const models=d.markets.map(api.marketModel);
  assert.ok(models.every(m=>m.dates.length>=61&&Number.isFinite(m.month.sample)&&Number.isFinite(m.month.excess)));
  const bad=structuredClone(d);bad.markets[0].stocks[0].series[1].close=0;assert.equal(api.validPrices(bad),false);
  bad.markets[0].stocks[0].series[1].close='100';assert.equal(api.validPrices(bad),false);
});
test('editorial sources and price observations have separate clocks and every material section cites existing dated evidence',()=>{
  const r=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/ai_global_market_review.json')));
  assert.equal(api.validReview(r),true);const ids=new Set(r.sources.map(s=>s.id));assert.equal(ids.size,r.sources.length);
  for(const item of [...r.regions,...r.events,...r.social]){assert.ok(item.sourceIds.length);assert.ok(item.sourceIds.every(id=>ids.has(id)));}
  for(const s of r.sources)assert.ok(s.date<=r.asOf);
  assert.ok(r.social.length>=2);assert.ok(r.scenarios.length===3);assert.ok(r.counterargument&&r.limitations);
});
