const test=require('node:test'),assert=require('node:assert/strict');
const {createController}=require('../assets/market-refresh-scheduler.js');
function fixture(){let time=1000000,visible=true,busy=false,report={startedAt:1000000},kpi=0,full=0,release;
 const c=createController({now:()=>time,active:()=>visible,busy:()=>busy,getReport:()=>report,kpis:async()=>{kpi++;},full:async()=>{full++;if(release)await release.promise;report={startedAt:time};}});
 return{c,advance:n=>time+=n,visible:v=>visible=v,busy:v=>busy=v,report:r=>report=r,counts:()=>({kpi,full}),gate:()=>{let done;release={promise:new Promise(r=>done=r)};return()=>done();}};
}
test('entry round is reused, caps update each minute and slow sources recheck at five minutes',async()=>{const f=fixture();await f.c.ensure();assert.deepEqual(f.counts(),{kpi:0,full:0});
 f.advance(60000);await f.c.ensure();assert.equal(f.counts().kpi,1);f.advance(5000);await f.c.ensure();assert.equal(f.counts().kpi,1);
 f.advance(235000);await f.c.ensure();assert.deepEqual(f.counts(),{kpi:1,full:1});await f.c.ensure();assert.equal(f.counts().full,1);
});
test('hidden/inactive pages and an existing manual refresh create no duplicate requests',async()=>{const f=fixture();f.advance(300000);f.visible(false);await f.c.ensure();assert.equal(f.counts().full,0);
 f.visible(true);f.busy(true);await f.c.ensure();assert.equal(f.counts().full,0);f.busy(false);await f.c.ensure();assert.equal(f.counts().full,1);
});
test('a slow full read remains single-flight across repeated timer wakeups',async()=>{const f=fixture();f.advance(300000);const done=f.gate(),first=f.c.ensure();await Promise.resolve();f.advance(300000);const second=f.c.ensure();assert.equal(first,second);assert.equal(f.counts().full,1);done();await first;});
test('returning after sleep rechecks data and day changes do not leave a stale success lease',async()=>{const f=fixture();f.advance(86400000);await f.c.ensure();assert.equal(f.counts().full,1);});
