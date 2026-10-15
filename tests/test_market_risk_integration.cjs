const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(root,'index.html'),'utf8');
const js=fs.readFileSync(process.env.MARKET_RISK_JS||path.join(root,'assets/market-risk.js'),'utf8');
const risk=JSON.parse(fs.readFileSync(process.env.MARKET_RISK_DATA||path.join(root,'data/market_risk.json'),'utf8'));
const etf=JSON.parse(fs.readFileSync(process.env.ETF_SHARES_DATA||path.join(root,'data/etf_shares.json'),'utf8'));
function api(){const context={module:{exports:{}},console,Date,Map,Set,Math,Number,String,Array,JSON,parseFloat,parseInt};vm.runInNewContext(js,context);return context.module.exports;}
test('risk and ETF are appended after MA in market environment, never in industry monitoring',()=>{
  const market=html.slice(html.indexOf('<div class="tab-content" id="t0">'),html.indexOf('<div class="tab-content" id="tVal">'));
  const stage=html.slice(html.indexOf('<div class="tab-content" id="tStage">'),html.indexOf('<div class="tab-content" id="tPre">'));
  assert.ok(market.indexOf('id="marketRiskCard"')>market.indexOf('id="maBreadthCard"'));
  assert.ok(market.indexOf('id="etfSharesCard"')>market.indexOf('id="marketRiskCard"'));
  for(const id of ['marketRiskCard','etfSharesCard','cMarketRiskVol','cMarketRiskDrawdown','cEtfShares']){
    assert.equal(html.split('id="'+id+'"').length-1,1,id);assert.ok(!stage.includes('id="'+id+'"'));
  }
  assert.ok(market.includes('年化'));assert.ok(market.includes('净申赎估算'));assert.ok(market.includes('不等于实际资金净流入'));
  assert.ok(html.includes('assets/market-risk.js?v=')&&html.includes('assets/market-risk.css?v='));
});
test('all page and independent module scripts parse',()=>{
  new vm.Script(js);let count=0;
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!m[1].includes('src=')&&m[2].trim()){new vm.Script(m[2]);count++;}
  assert.ok(count>=2);
});
test('actual initialized CSI all-share data has 60 validated risk observations',()=>{
  const a=api();assert.equal(risk.index.code,'000985');assert.equal(risk.series.length,60);assert.ok(risk.bars.length>=119);
  assert.equal(a.acceptRisk(risk,{persist:false}),true);assert.equal(a.orderedRisk().length,60);
  const last=a.orderedRisk().at(-1),calc=a.computeRisk(risk.bars);
  assert.equal(last.date,risk.series.at(-1).date);assert.ok(Math.abs(calc.rv20-last.rv20)<.00011);assert.ok(Math.abs(calc.drawdown60-last.drawdown60)<.00011);
  assert.ok(last.drawdown60<=0);assert.equal(last.status,'close');
});
test('actual initialized ETF data covers all representative funds and computes same-day NAV estimates',()=>{
  const a=api();assert.equal(a.acceptEtf(etf,{persist:false}),true);
  for(const code of ['510300','510500','512100']){
    const original=etf.funds.find(f=>f.code===code),rows=a.orderedEtf(code),last=rows.at(-1);
    assert.ok(original.series.length>=61);assert.equal(rows.length,60);assert.ok(rows.every(r=>r.deltaShares!==null),'All initial plotted points are daily changes');
    assert.equal(last.date,original.series.at(-1).date);assert.equal(last.navDate,last.date);assert.ok(last.navSource);
    assert.ok(Math.abs(last.estimatedFlowYuan-last.deltaShares*last.nav)<.02);
    assert.ok(rows.some(r=>r.deltaShares>0)&&rows.some(r=>r.deltaShares<0));
  }
});
