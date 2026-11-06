const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const api=require('../assets/canslim-recommendations.js');
test('C uses single-quarter recurring profit, never YTD or loss reversal',()=>{
  for(const [v,score]of [[101,5],[75,4],[30,3],[10,2],[-10,1],[-25,0]])assert.equal(api.scoreC({q3DeductedYoy:v,q3PriorDeductedPositive:true}).score,score);
  assert.equal(api.scoreC({q3DeductedYoy:500,q3PriorDeductedPositive:false}).missing,true);
  assert.equal(api.scoreC({q3DeductedYoy:500,q3PriorDeductedPositive:true,lowBase:true}).score,3);
  assert.equal(api.scoreC({ytdDeductedYoy:500}).score,2);
});
test('A uses four annual points for three elapsed years and applies cash penalty',()=>{
  const annualDeducted=[2022,2023,2024,2025].map((year,i)=>({year,value:100*1.4**i}));
  const a=api.scoreA({annualDeducted,cashConversion:1});assert.equal(a.score,5);assert.ok(Math.abs(a.cagr-40)<1e-9);
  assert.equal(api.scoreA({annualDeducted,cashConversion:.4}).score,4);
  assert.equal(api.scoreA({annualDeducted:annualDeducted.slice(1)}).missing,true);
  assert.equal(api.scoreA({annualDeducted:annualDeducted.map((x,i)=>({...x,value:i===0?-100:x.value}))}).score,2);
});
test('L is explicit benchmark excess proxy, not fictitious RPS rank',()=>{
  assert.equal(api.scoreL({excess126:35,return126:40}).score,5);
  assert.match(api.scoreL({excess126:35,return126:40}).reason,/不是全市场RPS/);
  assert.equal(api.scoreL({}).missing,true);
});
test('M has same reproducible benchmark trend for all names',()=>{
  assert.equal(api.scoreM({close:110,ma50:100,ma200:90,ma50Prior20:95}).score,5);
  assert.equal(api.scoreM({close:80,ma50:90,ma200:100,ma50Prior20:95}).score,0);
  assert.equal(api.scoreM({close:100}).missing,true);
});
test('P has 15-point transparent PE TTM curve and distinguishes losses from unknown PE',()=>{
  for(const [pe,score]of [[5,15],[20,15],[25,12],[30,10],[40,8],[60,5],[100,3],[1000,0]]){
    const p=api.scoreP({peTtm:pe,ttmParentNetProfit:1});
    assert.equal(p.score,score);assert.equal(p.max,15);assert.equal(p.missing,undefined);
    assert.match(p.reason,/评分锚/);
  }
  for(const profit of [0,-1])assert.equal(api.scoreP({peTtm:-20,ttmParentNetProfit:profit}).score,0);
  for(const pe of [null,undefined,'',0,-5,'invalid']){
    const p=api.scoreP({peTtm:pe,ttmParentNetProfit:1});assert.equal(p.score,null);assert.equal(p.missing,true);
  }
  let last=15;
  for(let pe=1;pe<=500;pe++){const next=api.scoreP({peTtm:pe}).score;assert.ok(next<=last);last=next;}
});
test('50-point ratings use total thresholds, while valuation, cash and market remain risk notes',()=>{
  const s={scores:{C:{score:5},A:{score:5},N:{score:4},M:{score:0}},total:35,metrics:{peTtm:100,cashConversion:.3},missingDimensions:['I','L']};
  const recommended=api.rate(s,40);
  assert.equal(recommended.rating,'推荐');assert.ok(recommended.gates.length>=4);assert.equal(recommended.ratingPending,false);
  for(const total of [35,36,50])assert.equal(api.rate({...s,total},40).rating,'推荐');
  for(const total of [25,30,34])assert.equal(api.rate({...s,total},40).rating,'中性');
  for(const total of [0,19,24])assert.equal(api.rate({...s,total},40).rating,'不推荐');
  const missing=api.rate({...s,total:null},40);assert.equal(missing.ratingPending,true);assert.equal(api.ratingLabel(missing),'待核验');
  assert.equal(api.ratingLabel(recommended),'推荐');
});
test('Unknown price factor leaves total pending and sorts below a known zero rather than as zero',()=>{
  const s={code:'1',metrics:{},sources:[],assessments:{}};
  const unknown=api.evaluated(s,{});assert.equal(unknown.total,null);assert.equal(unknown.scores.P.missing,true);assert.ok(unknown.missingDimensions.includes('P'));
  const rows=[{code:'1',total:null,metrics:{peTtm:1}},{code:'2',total:0,metrics:{peTtm:200}},{code:'3',total:35,metrics:{peTtm:30}}].sort(api.scoreOrder);
  assert.deepEqual(rows.map(x=>x.code),['3','2','1']);
});
test('Module insertion is after A-share monitor and before cloud analysis',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.ok(html.indexOf('id="chainMonitorRoot"')<html.indexOf('id="canslimRecommendationsRoot"'));
  assert.ok(html.indexOf('id="canslimRecommendationsRoot"')<html.indexOf('id="aiIndustryContext"'));
  assert.equal((html.match(/id="canslimRecommendationsRoot"/g)||[]).length,1);
});
test('Published research has 12 unique issuers, dated filings and consistent scores',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/canslim_recommendations.json'),'utf8'));
  assert.equal(api.valid(data),true);const prepared=api.prepare(data),stocks=prepared.sectors.flatMap(x=>x.stocks);
  assert.equal(stocks.length,12);assert.equal(new Set(stocks.map(x=>x.code)).size,12);
  assert.match(data.priceAsOf,/^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.priceAsOf<=data.asOf);
  for(const market of [data.market,data.hkMarket]){
    assert.equal(market.endDate,data.priceAsOf);
    assert.equal(market.chart.at(-1).date,data.priceAsOf);
    assert.equal(market.chart.at(-1).close,market.close);
  }
  assert.equal(data.fx.businessDate,data.priceAsOf);
  for(const group of prepared.sectors){
    assert.equal(group.stocks.length,6);
    for(let i=1;i<group.stocks.length;i++)assert.ok(group.stocks[i-1].total>=group.stocks[i].total);
    for(const s of group.stocks){
      assert.equal(s.metrics.priceDate,data.priceAsOf);
      assert.equal(s.metrics.endDate,data.priceAsOf);
      assert.equal(s.metrics.close,s.metrics.price);
      assert.ok(Math.abs(s.metrics.price*s.metrics.totalShares/s.metrics.ttmParentNetProfit-s.metrics.peTtm)<1e-8);
      assert.equal(s.canslimTotal,api.KEYS.reduce((sum,k)=>sum+s.scores[k].score,0));
      assert.equal(s.total,s.canslimTotal+s.scores.P.score);
      assert.ok(Number.isInteger(s.scores.P.score)&&s.scores.P.score>=0&&s.scores.P.score<=15);
      assert.ok(s.total>=0&&s.total<=50);
      for(const k of api.KEYS){assert.ok(Number.isInteger(s.scores[k].score)&&s.scores[k].score>=0&&s.scores[k].score<=5);assert.ok(s.scores[k].reason.length>15);if(s.scores[k].missing)assert.equal(s.scores[k].score,2);}
      assert.ok(s.sources.some(x=>x.kind==='q3'&&/cninfo|szse|sse|syst\.com/.test(x.url)));
      assert.ok(s.events?.length>=1);assert.ok(s.risks?.length>=2);assert.ok(s.thesis&&s.nextCheck);
      for(const e of s.events){assert.ok(e.date>=data.windowStart&&e.date<=data.asOf);assert.ok(e.sourceIds?.every(id=>s.sources.some(x=>x.id===id)));}
      for(const k of ['N','S','I','P'])assert.ok((s.scores[k].sourceIds||[]).every(id=>s.sources.some(x=>x.id===id)));
      assert.equal(s.rating,s.total>=35?'推荐':s.total>=25?'中性':'不推荐');
      if(s.rating==='推荐')assert.ok(s.total>=35);
    }
  }
});
test('A/H are sixteen securities for twelve issuers, paired and valued independently',()=>{
  const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/canslim_recommendations.json'),'utf8'));
  const d=api.prepare(raw),rows=d.sectors.flatMap(g=>g.securities);
  assert.equal(rows.length,16);assert.equal(new Set(rows.map(s=>s.id)).size,16);assert.equal(new Set(rows.map(s=>s.code)).size,12);
  assert.deepEqual(rows.filter(s=>s.shareClass==='H').map(s=>s.securityCode).sort(),['02476','03228','03308','06166']);
  for(const group of d.sectors){
    for(let i=1;i<group.companies.length;i++)assert.ok(group.companies[i-1].bestScore>=group.companies[i].bestScore);
    for(const company of group.companies){
      assert.equal(company.securities[0].shareClass,'A');
      if(company.securities.length===1)continue;
      const [a,h]=company.securities;
      assert.equal(h.shareClass,'H');assert.equal(h.currency,'HKD');assert.notEqual(a.metrics.price,h.metrics.price);
      assert.equal(h.metrics.priceDate,d.priceAsOf);assert.equal(h.metrics.endDate,d.priceAsOf);
      assert.equal(h.metrics.close,h.metrics.price);
      assert.equal(a.metrics.totalShares,h.metrics.totalShares);assert.equal(a.metrics.ttmParentNetProfit,h.metrics.ttmParentNetProfit);
      const expected=h.metrics.price*h.fxCnyPerHkd*h.metrics.totalShares/h.metrics.ttmParentNetProfit;
      assert.ok(Math.abs(expected-h.metrics.peTtm)<1e-8);
      assert.ok(Math.abs((h.metrics.price*h.fxCnyPerHkd/a.metrics.price-1)*100-h.hShare.relativeToA)<1e-8);
      for(const s of [a,h]){assert.equal(s.scores.P.score,Math.min(15,Math.round(300/s.metrics.peTtm)));assert.equal(s.total,s.canslimTotal+s.scores.P.score);}
      for(const key of ['C','A','N'])assert.equal(a.scores[key].score,h.scores[key].score);
      assert.match(h.scores.M.reason,/恒生指数/);assert.match(a.scores.M.reason,/中证全指/);
      assert.equal(h.scores.I.score,2);assert.equal(h.scores.I.missing,true);
      if(h.metrics.barCount<127){assert.equal(h.metrics.excess126,null);assert.equal(h.scores.L.score,2);assert.equal(h.scores.L.missing,true);}
      for(const id of h.scores.L.sourceIds)assert.equal(h.sources.find(x=>x.id===id).kind,'market_hk');
    }
  }
  const a=rows.find(s=>s.id==='A-603083'),h=rows.find(s=>s.id==='H-06166');
  for(const s of [a,h])assert.equal(s.gates.some(x=>x.startsWith('估值高于')),s.metrics.peTtm>s.peerPE*1.3);
  assert.ok(h.scores.P.score>a.scores.P.score,'Lower H PE receives higher P score independently of A');
  assert.ok(rows.find(s=>s.id==='H-03308').hShare.relativeToA>0,'H can be more expensive than A; never force a discount');
});
test('Published metadata and UI declare CAN SLIM35 plus P15 and no old hard-veto wording',()=>{
  const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/canslim_recommendations.json'),'utf8'));
  assert.equal(raw.scoreModel.maximum,50);assert.equal(raw.scoreModel.canslimMaximum,35);assert.equal(raw.scoreModel.priceMaximum,15);
  assert.equal(raw.scoreModel.recommendAtLeast,35);assert.equal(raw.scoreModel.neutralAtLeast,25);
  assert.ok(raw.methodology.some(x=>/^P ·/.test(x.title)));assert.ok(raw.methodology.some(x=>x.title==='50分总分与评级'));
  assert.ok(!raw.methodology.some(x=>/PE门槛仍用/.test(x.text)));
  const script=fs.readFileSync(path.join(__dirname,'../assets/canslim-recommendations.js'),'utf8');
  assert.match(script,/PE TTM · 15分/);assert.match(script,/CAN SLIM 35 \+ 估值P 15/);assert.match(script,/ratingLabel\(x\)/);
});
test('Rendered table contains sixteen securities, separate P column and pending total without null text',async()=>{
  const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/canslim_recommendations.json'),'utf8'));
  raw.sectors[0].stocks[0].metrics.peTtm=null;
  const root={innerHTML:'',addEventListener(){}},tab={classList:{contains:()=>true}},window={};
  const context={window,document:{getElementById:id=>id==='canslimRecommendationsRoot'?root:id==='tStage'?tab:null},MutationObserver:class{observe(){}},fetch:async()=>({ok:true,json:async()=>raw}),AbortController,setTimeout,clearTimeout,console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/canslim-recommendations.js'),'utf8'),context);
  await window.CanslimRecommendations.load();
  assert.equal((root.innerHTML.match(/data-stock="[AH]-/g)||[]).length,16);
  assert.equal((root.innerHTML.match(/<th>P<small>PE TTM · 15分/g)||[]).length,2);
  assert.match(root.innerHTML,/CAN SLIM 35 \+ 估值P 15/);
  assert.match(root.innerHTML,/is-pending/);assert.match(root.innerHTML,/因P未核验暂不评级/);
  assert.doesNotMatch(root.innerHTML,/>null<|width:NaN%|width:null%/);
  assert.equal((root.innerHTML.match(/<small>\/50<\/small>/g)||[]).length,16);
});
test('Industry outlook has sourced scenarios, parameter monitoring and nonduplicated samples',()=>{
  const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/canslim_recommendations.json'),'utf8'));
  for(const group of raw.sectors){
    const r=group.outlook,m=group.industryMetrics;assert.equal(r.scenarios.length,3);assert.equal(r.monitoring.length,8);assert.equal(r.flow.length,4);assert.ok(r.analysis.length>=6);assert.ok(r.customers.length>=2);
    const sourceIds=new Set(r.sources.map(s=>s.id));
    const verify=o=>{if(!o||typeof o!=='object')return;if(Array.isArray(o)){o.forEach(verify);return}if(o.sourceIds)assert.ok(o.sourceIds.every(id=>sourceIds.has(id)));Object.values(o).forEach(verify)};verify(r);
    assert.equal(m.quarters.length,3);assert.equal(m.returns.length,127);assert.ok(Math.abs(m.returns[0].sample)<1e-9);assert.ok(Math.abs(m.returns[0].benchmark)<1e-9);assert.equal(m.returns.at(-1).date,raw.priceAsOf);
    assert.ok(Math.abs(m.excess126-(m.returns.at(-1).sample-m.returns.at(-1).benchmark))<1e-9);
    for(const row of m.quarters)for(const k of ['revenue','profit'])assert.ok(Number.isFinite(row[k]));
  }
  const pcb=raw.sectors.find(g=>g.id==='pcb');assert.equal(pcb.industryMetrics.memberCodes.length,5);assert.ok(!pcb.industryMetrics.memberCodes.includes('688183'));
});
