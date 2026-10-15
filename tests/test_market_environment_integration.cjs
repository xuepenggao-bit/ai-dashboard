'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.DASHBOARD_ROOT||path.resolve(__dirname,'..');
const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(root,'index.html'),'utf8');
const baseFile=process.env.MARKET_DESIGN_BASE;
const css=fs.readFileSync(process.env.MARKET_ENVIRONMENT_CSS||path.join(root,'assets/market-environment.css'),'utf8');
function inline(source){return [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m=>!/\bsrc\s*=/.test(m[1])).map(m=>m[2]);}
function market(source){const start=source.indexOf('id="t0"');const open=source.lastIndexOf('<div',start),end=source.indexOf('<!-- ════════════════ TAB 估值分析',start);assert.ok(open>=0&&end>start);return{before:source.slice(0,open),body:source.slice(open,end),after:source.slice(end)};}
test('market design assets are versioned and chart plugin installs before any market renderer',()=>{
  assert.match(html,/<link rel="stylesheet" href="assets\/market-environment\.css\?v=[^"]+">/);
  const at=html.indexOf('<script src="assets/market-environment.js');
  assert.ok(at>html.indexOf('chart.umd.min.js'));
  assert.ok(at<html.indexOf('src="assets/account-openings.js'));
  for(const source of ['ma-breadth','market-risk','market-quality','market-heat'])assert.ok(at<html.indexOf('<script src="assets/'+source+'.js'));
  assert.match(html.slice(at,at+100),/defer/);
  assert.match(market(html).body,/class="market-environment-hero"/);
});
test('all design rules remain scoped to the market environment and add no remote dependencies',()=>{
  const plain=css.replace(/\/\*[\s\S]*?\*\//g,'');let rules=0;
  for(const m of plain.matchAll(/([^{}]+)\{/g)){const selector=m[1].trim();if(selector.startsWith('@'))continue;for(const item of selector.split(',')){assert.ok(item.trim().startsWith('#t0'),'Unscoped: '+item);rules++;}}
  assert.ok(rules>100);
  assert.doesNotMatch(css,/@import|url\s*\(/i);
  assert.doesNotMatch(css,/\b(?:filter|backdrop-filter)\s*:/i,'No expensive blur on the long market page');
});
test('six daily-series cards and overview values use one presentation system',()=>{
  const body=market(html).body;
  for(const className of ['market-series-summary','market-series-plot','market-series-footer'])assert.equal([...body.matchAll(new RegExp('class="[^"\\n]*\\b'+className+'\\b','g'))].length,6,className);
  assert.equal([...body.matchAll(/class="card market-overview-card"/g)].length,5);
  assert.equal([...body.matchAll(/class="market-series-delta"/g)].length,3);
  for(const id of ['cMargin','cVolume','cHighLow52','cHighLow52Net','cUpDown','cUpDownDelta','cLimitMoves','cLimitDelta','cHkVolume','cMaBreadth','cMarketHeat','cMarketRiskVol','cMarketRiskDrawdown','cEtfShares','cMarketMedian','cMarketConcentration','cAccountOpenings'])assert.ok(body.includes('id="'+id+'"'),id);
});
test('inline application scripts still parse',()=>{for(const [i,source]of inline(html).entries())new vm.Script(source,{filename:'inline-'+i+'.js'});});
test('visual redesign leaves existing logic, controls and other tab markup byte-identical', {skip:!baseFile},()=>{
  const base=fs.readFileSync(baseFile,'utf8');assert.deepEqual(inline(html),inline(base));
  const removeAssets=s=>s.replace(/^.*(?:href="assets\/market-environment\.css|src="assets\/market-environment\.js|市场图表样式须先注册).*\n/gm,'');
  const before=market(base),after=market(html);
  assert.equal(removeAssets(after.before),before.before);
  assert.equal(removeAssets(after.after),before.after);
  assert.deepEqual([...base.matchAll(/<canvas\b[^>]*id="([^"]+)"/g)].map(m=>m[1]),[...html.matchAll(/<canvas\b[^>]*id="([^"]+)"/g)].map(m=>m[1]));
  assert.deepEqual([...base.matchAll(/\bonclick="([^"]*)"/g)].map(m=>m[1]),[...html.matchAll(/\bonclick="([^"]*)"/g)].map(m=>m[1]));
  for(const m of base.matchAll(/\bid="([^"]+)"/g))assert.ok(html.includes('id="'+m[1]+'"'),'Preserved '+m[1]);
});
