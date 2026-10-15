'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=process.env.DASHBOARD_ROOT||path.resolve(__dirname,'..');
const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(root,'index.html'),'utf8');
const css=fs.readFileSync(process.env.MARKET_ENVIRONMENT_CSS||path.join(root,'assets/market-environment.css'),'utf8');
function overview(s){const start=s.indexOf('<!-- KPI Row -->',s.indexOf('id="t0"')),end=s.indexOf('<!-- MARKET_HEAT_CARD_START -->',start);assert.ok(start>0&&end>start);return{before:s.slice(0,start),body:s.slice(start,end),after:s.slice(end)};}
test('five overview cards retain their live values and get five distinct restrained accents',()=>{
  const body=overview(html).body;
  assert.equal([...body.matchAll(/class="card market-overview-card"/g)].length,5);
  for(const id of ['kTmc','kTmcDate','kTmcChange','kSsePe','kSsePeDate','kSzePe','kSzePeDate','kGemPe','kGemPeDate','kStarPe','kStarPeDate','kSseMc','kSzeMc','kGemMc','kStarMc'])assert.equal(body.split('id="'+id+'"').length-1,1,id);
  const block=css.slice(css.indexOf('/* First row:'),css.indexOf('/* Daily series:'));
  const accents=[...block.matchAll(/--overview-accent:\s*(#[0-9a-f]{6})/g)].map(m=>m[1]);
  assert.equal(accents.length,5);assert.equal(new Set(accents).size,5);
  for(const n of [2,3,4,5])assert.ok(block.includes('.market-overview-card:nth-child('+n+')'));
});
test('total-cap card removes duplicate copy while retaining the full scope explanation',()=>{
  const first=overview(html).body.split('<div class="card market-overview-card"')[1];
  assert.ok(first.includes('id="marketTotalCapCard"'));
  assert.ok(first.includes('沪市主板A股、深市主板A股、创业板、科创板总市值之和'));
  assert.ok(first.includes('四舍五入'));
  assert.match(first,/class="tx3 mt4 market-total-note">不含 B 股、北交所<\/div>/);
  assert.doesNotMatch(first,/右侧四板块合计|<br>/);
  assert.match(css,/#t0 #marketTotalCapCard \.market-total-note \{[^}]*margin-top: auto/);
});
test('refinement changes only the overview markup and its scoped CSS section',{skip:!process.env.MARKET_OVERVIEW_BASE_HTML||!process.env.MARKET_OVERVIEW_BASE_CSS},()=>{
  const baseHtml=fs.readFileSync(process.env.MARKET_OVERVIEW_BASE_HTML,'utf8'),baseCss=fs.readFileSync(process.env.MARKET_OVERVIEW_BASE_CSS,'utf8');
  const current=overview(html),before=overview(baseHtml),normalize=s=>s.replace(/assets\/market-environment\.css\?v=[^"']+/g,'assets/market-environment.css?v=VERSION');
  assert.equal(normalize(current.before),normalize(before.before));assert.equal(current.after,before.after);
  for(const source of [css,baseCss])assert.ok(source.indexOf('/* Daily series:')>source.indexOf('/* First row:'));
  assert.equal(css.slice(0,css.indexOf('/* First row:')),baseCss.slice(0,baseCss.indexOf('/* First row:')));
  assert.equal(css.slice(css.indexOf('/* Daily series:')),baseCss.slice(baseCss.indexOf('/* Daily series:')));
});
