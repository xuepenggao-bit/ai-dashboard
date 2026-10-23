const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/market-risk.js'),'utf8');
function setup(){let time=Date.parse('2026-10-23T14:59:50+08:00'),requests=0,closed=false;class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
  const ctx={module:{exports:{}},Date:Clock,console,PortfolioMarketSession:{marketState:()=>({calendarKnown:true,isClosed:closed})},localStorage:{getItem:()=>null,setItem(){}},_idxFetch:async()=>{requests++;return{schemaVersion:1,source:'SSE',methodology:'shares',updatedAt:new Clock().toISOString(),funds:[{code:'510300',series:[{date:'2026-10-22',status:'reported',shares:1e8,previousDate:null,deltaShares:null,changePct:null,nav:null,estimatedFlowYuan:null}]}]};}};
  vm.runInNewContext(source,ctx);return{api:ctx.module.exports,setTime:t=>time=Date.parse(t),count:()=>requests,setClosed:v=>closed=v};
}
test('first post-close check bypasses pre-close thirty-minute cache; subsequent reads throttle to one minute',async()=>{
  const s=setup();await s.api.refreshEtf();assert.equal(s.count(),2);
  s.setTime('2026-10-23T15:00:00+08:00');await s.api.refreshEtf();assert.equal(s.count(),4);
  s.setTime('2026-10-23T15:00:30+08:00');await s.api.refreshEtf();assert.equal(s.count(),4);
  s.setTime('2026-10-23T15:01:00+08:00');await s.api.refreshEtf();assert.equal(s.count(),6);
  assert.equal(s.api.orderedEtf('510300').at(-1).date,'2026-10-22','retrieval time must not relabel last disclosed date');
});
test('weekends/known holidays skip fast polling, and next trading day resets cutoff',()=>{
  const s=setup(),at=t=>Date.parse(t);assert.equal(s.api.etfCloseWindow(at('2026-10-23T14:59:00+08:00')),false);
  assert.equal(s.api.etfCloseWindow(at('2026-10-23T15:00:00+08:00')),true);assert.equal(s.api.etfCloseWindow(at('2026-10-24T16:00:00+08:00')),false);
  s.setClosed(true);assert.equal(s.api.etfCloseWindow(at('2026-10-23T16:00:00+08:00')),false);
});
test('after-close workflow starts at 15:05 and keeps later disclosure checks',()=>{
  const yml=fs.readFileSync(path.join(__dirname,'../.github/workflows/refresh-etf-shares.yml'),'utf8');
  for(const cron of ['5,20,35,50 7 * * 1-5','15 8 * * 1-5','55 9 * * 1-5','25 0,13 * * 1-5'])assert.ok(yml.includes(cron));
});
