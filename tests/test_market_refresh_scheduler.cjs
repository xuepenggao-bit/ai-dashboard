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
test('a finished shared scan also refreshes the summary of asynchronous consumers',()=>{
 const keys=['document','MarketEnvironmentFreshness','refreshMacro','_macroRefreshCaption'],saved=keys.map(k=>[k,global[k]]);let calls=0;
 try{const el={style:{}};global.document={getElementById:()=>el};global.MarketEnvironmentFreshness={inspect:()=>[{label:'港股成交额',state:'untimed',message:'未提供时刻'}]};global.refreshMacro=()=>{};global.refreshMacro.lastReport={ok:true};global._macroRefreshCaption=()=>calls++;
 require('../assets/market-refresh-scheduler.js').renderFreshness();assert.equal(calls,1);assert.match(el.textContent,/源未提供具体行情时刻/);assert.doesNotMatch(el.textContent,/待补齐/);
 }finally{for(const [key,value]of saved)if(value===undefined)delete global[key];else global[key]=value;}
});
