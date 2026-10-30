'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.DASHBOARD_ROOT||path.resolve(__dirname,'..');
const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(root,'index.html'),'utf8');
const engine=require(process.env.MARKET_HEAT_ENGINE||path.join(root,'assets/market-heat-engine.js'));
const payload=JSON.parse(fs.readFileSync(process.env.MARKET_HEAT_DATA||path.join(root,'data/market_heat.json'),'utf8'));
const support=JSON.parse(fs.readFileSync(process.env.MARKET_HEAT_SUPPORT||path.join(root,'data/market_heat_support.json'),'utf8'));
const inputs=process.env.MARKET_HEAT_INPUT_DIR||path.join(root,'data');
function read(file){return JSON.parse(fs.readFileSync(path.join(inputs,file),'utf8'));}
test('prominent composite is unique and immediately above financing, with engine before UI',()=>{
  assert.equal([...html.matchAll(/id="marketHeatCard"/g)].length,1);
  const start=html.indexOf('<!-- MARKET_HEAT_CARD_START -->'),end=html.indexOf('<!-- MARKET_HEAT_CARD_END -->');
  assert.ok(start>html.indexOf('<div class="g5 mb16">'));
  assert.ok(end>start);
  assert.match(html.slice(end,end+150),/融资融券余额趋势/);
  const engineAt=html.indexOf('<script src="assets/market-heat-engine.js'),uiAt=html.indexOf('<script src="assets/market-heat.js');
  assert.ok(engineAt>0&&uiAt>engineAt);
  assert.ok(html.includes('assets/market-heat.css?v='));
  const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const ids=[...markup.matchAll(/\bid=["']([^"']+)["']/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size,'all dashboard IDs stay unique');
});
test('every inline dashboard script parses after insertion',()=>{
  for(const [i,m]of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()){
    if(/\bsrc\s*=/.test(m[1])||(/\btype\s*=/.test(m[1])&&!/(?:javascript|module)/.test(m[1])))continue;
    new vm.Script(m[2],{filename:'inline-'+i+'.js'});
  }
});
test('real published seed contains 60 canonical closed sessions with fully explained sums',()=>{
  assert.equal(payload.modelVersion,engine.VERSION);
  assert.equal(payload.series.length,60);
  assert.equal(new Set(payload.series.map(r=>r.date)).size,60);
  assert.equal(payload.componentDefinitions.reduce((s,c)=>s+c.weight,0),100);
  for(const r of payload.series){
    assert.ok(engine.validatePublishedRow(r),'canonical '+r.date);
    assert.ok(r.score>=0&&r.score<=100&&r.coveragePct>=85);
    assert.equal(r.status,'close');
    assert.equal(r.components.length,12);
    const points=r.components.reduce((s,c)=>s+(c.contribution||0),0);
    assert.ok(Math.abs(r.score-points/r.coveragePct*100)<.00001);
    for(const c of r.components.filter(c=>c.available))assert.ok(['margin5d','etf5d'].includes(c.id)?c.sourceDate<r.date:c.sourceDate===r.date);
  }
});
test('overlapping published scores reproduce while newer incomplete inputs remain unpublished',()=>{
  const input={quality:read('market_quality.json'),ma:read('market_ma_breadth.json'),breadth:read('market_breadth_history.json'),highLow:read('market_high_low_52w.json'),risk:read('market_risk.json'),etf:read('etf_shares.json')};
  const actual=engine.build(engine.combineSupport(input,support));
  assert.equal(actual.series.length,60);
  // Independent providers advance at different times. Comparing the entire
  // rolling window would fail whenever one source is one session ahead.
  const published=new Map(payload.series.map(r=>[r.date,r]));
  const overlap=actual.series.filter(r=>published.has(r.date)&&engine.validatePublishedRow(r));
  assert.ok(overlap.length>=55,'enough overlapping sessions remain independently reproducible');
  for(const row of overlap){const old=published.get(row.date);assert.deepEqual([row.score,row.coveragePct],[old.score,old.coveragePct],row.date);}
  const retained=engine.retainPublished(payload,actual);
  assert.ok(retained.series.every(r=>engine.validatePublishedRow(r)));
  assert.ok(retained.series.at(-1).date>=payload.series.at(-1).date);
  for(const r of actual.series){
    const prior=support.amountHistory.series.filter(v=>v.date<r.date).slice(-20);
    assert.equal(prior.length,20);
    assert.equal(r.activityReference.window,20);
    assert.equal(r.activityReference.excludesCurrent,true);
    assert.ok(Math.abs(r.activityReference.meanPrevious20AmountYuan-prior.reduce((s,v)=>s+v.amountYuan,0)/20)<1);
  }
});
