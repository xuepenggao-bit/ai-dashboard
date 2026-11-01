const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
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
test('High score alone does not bypass valuation, evidence or cash gate',()=>{
  const s={scores:{C:{score:5},A:{score:5},N:{score:4},M:{score:5}},total:30,metrics:{peTtm:100,cashConversion:.9},missingDimensions:[]};
  assert.equal(api.rate(s,40).rating,'中性');
  assert.equal(api.rate({...s,metrics:{peTtm:45,cashConversion:.9}},40).rating,'推荐');
  assert.equal(api.rate({...s,metrics:{peTtm:45,cashConversion:.3}},40).rating,'中性');
  assert.equal(api.rate({...s,total:19},40).rating,'不推荐');
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
  for(const group of prepared.sectors){
    assert.equal(group.stocks.length,6);
    for(let i=1;i<group.stocks.length;i++)assert.ok(group.stocks[i-1].total>=group.stocks[i].total);
    for(const s of group.stocks){
      assert.equal(s.metrics.priceDate,'2026-10-30');
      assert.equal(s.total,api.KEYS.reduce((sum,k)=>sum+s.scores[k].score,0));
      for(const k of api.KEYS){assert.ok(Number.isInteger(s.scores[k].score)&&s.scores[k].score>=0&&s.scores[k].score<=5);assert.ok(s.scores[k].reason.length>15);if(s.scores[k].missing)assert.equal(s.scores[k].score,2);}
      assert.ok(s.sources.some(x=>x.kind==='q3'&&/cninfo|szse|sse|syst\.com/.test(x.url)));
      assert.ok(s.events?.length>=1);assert.ok(s.risks?.length>=2);assert.ok(s.thesis&&s.nextCheck);
      for(const e of s.events){assert.ok(e.date>=data.windowStart&&e.date<=data.asOf);assert.ok(e.sourceIds?.every(id=>s.sources.some(x=>x.id===id)));}
      for(const k of ['N','S','I'])assert.ok((s.scores[k].sourceIds||[]).every(id=>s.sources.some(x=>x.id===id)));
      if(s.rating==='推荐'){assert.equal(s.gates.length,0);assert.ok(s.total>=25);}
    }
  }
});
