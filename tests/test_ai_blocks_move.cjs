const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(__dirname,'../index.html'),'utf8');
const macro=html.slice(html.indexOf('<div class="tab-content" id="t0">'),html.indexOf('<div class="tab-content" id="tVal">'));
const stage=html.slice(html.indexOf('<div class="tab-content" id="tStage">'),html.indexOf('<div class="tab-content" id="tPre">'));
const ids=['capexTs','capexBtn','kCapex26','kCapex25','kMag7Pe','kEtfPe','cCapex','cTrend','cArr','cCloudRevenue','cCloudCapex','creditRatingGrid'];
test('all AI tail widgets are moved once to the bottom of the industry tab',()=>{
  assert.ok(stage.includes('四大云公司资本开支指引')&&stage.includes('四大 CSP 债券评级与变化'));
  assert.ok(stage.indexOf('chainMonitorRoot')<stage.indexOf('aiIndustryContext'));
  assert.ok(stage.indexOf('AI_INDUSTRY_CONTEXT_END')>stage.indexOf('creditRatingNote'));
  for(const id of ids){assert.ok(stage.includes('id="'+id+'"'),id);assert.ok(!macro.includes('id="'+id+'"'),id);assert.equal(html.split('id="'+id+'"').length-1,1,id);}
});
test('market charts remain in market environment while opinion leaders move to industry',()=>{
  for(const id of ['cHighLow52','cUpDown','cLimitMoves','cHkVolume','cAccountOpenings','cMaBreadth'])assert.ok(macro.includes('id="'+id+'"'),id);
  assert.ok(!macro.includes('id="kolGrid"'));
  assert.ok(stage.includes('id="kolGrid"'));
});
test('AI snapshot refresh belongs to industry access, not macro access',()=>{
  const refresh=html.slice(html.indexOf('function _tabRefresh(idx)'),html.indexOf('function _resizeAiIndustryCharts'));
  assert.ok(refresh.includes("else if(tab==='t0')    { refreshMacro(); }"));
  assert.ok(refresh.includes("else if(tab==='tStage') { mkStageMatrix(); refreshAiTrendOnTabAccess(); fetchKolSummary(); }"));
  assert.ok(!html.includes('[2,3,5,6,7].filter'));
  const change=html.slice(html.indexOf('function switchTab(idx)'),html.indexOf('// ── 盘前自检'));
  assert.ok(change.includes("if(TAB_ORDER[idx]==='tStage') _resizeAiIndustryCharts();"));
});
test('industry renderer preserves the static AI widgets during refresh',()=>{
  const js=fs.readFileSync(path.join(__dirname,'../assets/chain-monitor.js'),'utf8');
  assert.ok(js.includes("const root=document.getElementById('chainMonitorRoot')||tab;"));
  assert.ok(!js.includes("root.classList.contains('active')"));
  assert.ok(js.includes("tab.classList.contains('active')"));
});
test('all inline page scripts still parse after the move',()=>{
  let count=0;for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(m[1].includes('src=')||!m[2].trim())continue;
    new vm.Script(m[2],{filename:'index-inline-'+(++count)});
  }
  assert.ok(count>=2);
});
