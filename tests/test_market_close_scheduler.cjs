'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const defaultPath=path.join(__dirname,'../assets/market-close-refresh.js');
const api=require(process.env.MARKET_CLOSE_MODULE||(fs.existsSync(defaultPath)?defaultPath:'/private/tmp/market-close-candidate/assets/market-close-refresh.js'));
const at=time=>Date.parse(time.includes('T')?time:'2026-10-20T'+time+'+08:00');
function harness(start='16:10:00',options={}){
  let time=at(start),visible=true,active=true,calls=[],timers=[],store=new Map();
  const storage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)};
  let fn=options.refresh||(()=>({ok:true,forced:true,startedAt:time,completedAt:time,failed:[]}));
  const controller=api.createController({now:()=>time,storage,...options,
    isVisible:()=>visible,isActive:()=>active,
    refresh:args=>{calls.push(args);return fn(args);},
    setTimer:(cb,delay)=>{const timer={cb,delay};timers.push(timer);return timer;},
    clearTimer:timer=>{timers=timers.filter(v=>v!==timer);}});
  return {controller,calls,store,storage,setTime:value=>{time=at(value);},now:()=>time,
    setVisible:value=>{visible=value;},setActive:value=>{active=value;},setRefresh:value=>{fn=value;},
    timers:()=>timers,runTimer:async()=>{const timer=timers.shift();if(timer) await timer.cb();}};
}
test('Beijing clock and exact 16:10 boundary are independent of local timezone',async()=>{
  const h=harness('16:09:59');await h.controller.ensure();assert.equal(h.calls.length,0);
  assert.equal(api.beijingClock(at('16:10:00')).minute,970);
  h.setTime('16:10:00');await h.controller.ensure();assert.deepEqual(h.calls,[{force:true,reason:'close'}]);
  assert.equal(h.controller.getStatus().state,'complete');
});
test('late page opening catches up and completed day survives a new controller',async()=>{
  const h=harness('23:45:00');await h.controller.ensure();await h.controller.ensure();assert.equal(h.calls.length,1);
  const other=harness('23:46:00',{storage:h.storage});await other.controller.ensure();assert.equal(other.calls.length,0);
  assert.equal(other.controller.getStatus().state,'complete');
});
test('hidden page and another tab do no heavy work; becoming visible and active catches up',async()=>{
  const h=harness();h.setVisible(false);await h.controller.ensure();assert.equal(h.calls.length,0);
  h.setVisible(true);h.setActive(false);await h.controller.ensure();assert.equal(h.calls.length,0);
  h.setActive(true);await h.controller.ensure();assert.equal(h.calls.length,1);
});
test('pre-16:10 pending round is not marked complete or counted as a failure',async()=>{
  let resolve;const old=new Promise(r=>{resolve=r;});
  const h=harness('16:10:00',{refresh:()=>old});
  const pending=h.controller.ensure();await Promise.resolve();
  h.setTime('16:10:02');resolve({ok:true,forced:true,startedAt:at('16:09:00'),completedAt:h.now(),failed:[]});await pending;
  assert.equal(h.controller.getStatus().state,'scheduled');assert.equal(h.controller.getStatus().attempts,0);
  h.setTime('16:10:04');h.setRefresh(()=>({ok:true,forced:true,startedAt:h.now(),completedAt:h.now(),failed:[]}));
  await h.controller.ensure();assert.equal(h.calls.length,2);
  assert.equal(h.controller.getStatus().state,'complete');
});
test('same-day non-forced pending report requires a fresh forced round',async()=>{
  const h=harness('16:10:00',{refresh:()=>({ok:true,forced:false,startedAt:at('16:10:00'),completedAt:at('16:10:00'),failed:[]})});
  await h.controller.ensure();assert.equal(h.controller.getStatus().attempts,0);
  assert.equal(h.controller.getStatus().state,'scheduled');
  assert.equal(h.controller.observe({ok:true,forced:false,startedAt:h.now(),completedAt:h.now(),failed:[]}),false);
});
test('an observed valid report and returned report are deduplicated',async()=>{
  let h;h=harness('16:10:00',{refresh:()=>{const report={ok:true,forced:true,startedAt:h.now(),completedAt:h.now(),failed:[]};
    h.controller.observe(report);return report;}});
  await h.controller.ensure();await h.controller.ensure();assert.equal(h.calls.length,1);
  assert.equal(h.controller.getStatus().state,'complete');assert.equal(h.controller.getStatus().attempts,0);
});
test('failed rounds retry after 60 and 300 seconds, at most three times',async()=>{
  const h=harness('16:10:00',{refresh:()=>({ok:false,forced:true,startedAt:at('16:10:00'),completedAt:at('16:10:00'),failed:['ETF']})});
  await h.controller.ensure();assert.equal(h.calls.length,1);assert.equal(h.controller.getStatus().attempts,1);
  h.setTime('16:10:59');await h.controller.ensure();assert.equal(h.calls.length,1);
  h.setTime('16:11:00');await h.controller.ensure();assert.equal(h.calls.length,2);
  h.setTime('16:15:59');await h.controller.ensure();assert.equal(h.calls.length,2);
  h.setTime('16:16:00');await h.controller.ensure();assert.equal(h.calls.length,3);
  h.setTime('17:00:00');await h.controller.ensure();assert.equal(h.calls.length,3);
  assert.equal(h.controller.getStatus().attempts,3);
});
test('empty success markers, missing forced flag and future report cannot complete the day',async()=>{
  const h=harness();
  for(const report of [{ok:true},{ok:true,forced:true,failed:[]},
    {ok:true,startedAt:h.now(),completedAt:h.now(),failed:[]},
    {ok:true,forced:true,startedAt:h.now(),completedAt:h.now()+1,failed:[]}]){
    assert.equal(h.controller.observe(report),false);
  }
  assert.equal(h.controller.observe({ok:true,forced:true,startedAt:h.now(),completedAt:h.now(),failed:['融资融券']}),false);
});
test('persisted future completion timestamps and bare done flags are rejected',async()=>{
  const h=harness();h.store.set('market_close_refresh_v1:2026-10-20',JSON.stringify({date:'2026-10-20',done:true,
    forced:true,startedAt:h.now(),completedAt:h.now()+60000,attempts:0}));
  await h.controller.ensure();assert.equal(h.calls.length,1);
});
test('storage denial degrades to in-memory deduplication',async()=>{
  const h=harness('16:10:00',{storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});
  await h.controller.ensure();await h.controller.ensure();assert.equal(h.calls.length,1);
});
test('storage quota failure cannot let stale readable metadata overwrite memory completion',async()=>{
  const old=JSON.stringify({date:'2026-10-20',attempts:0,nextAttemptAt:0,lastAttemptAt:0,completedAt:null,startedAt:null,failed:[]});
  let reads=0,writes=0;
  const h=harness('16:10:00',{storage:{getItem(){reads++;return old;},setItem(){writes++;throw Error('QuotaExceededError');}}});
  await h.controller.ensure();await h.controller.ensure();await h.controller.ensure();
  assert.equal(h.calls.length,1);assert.equal(h.controller.getStatus().state,'complete');
  assert.equal(reads,1);assert.equal(writes,1);
});
test('crossing midnight never reuses yesterday completion; wake after cutoff refreshes new day',async()=>{
  const h=harness();await h.controller.ensure();h.setTime('2026-10-21T10:00:00+08:00');
  await h.controller.ensure();assert.equal(h.calls.length,1);
  h.setTime('2026-10-21T16:15:00+08:00');await h.controller.ensure();assert.equal(h.calls.length,2);
});
test('weekends and verified joint holidays skip; one market open still refreshes',async()=>{
  const weekend=harness('2026-10-24T16:15:00+08:00');await weekend.controller.ensure();assert.equal(weekend.calls.length,0);
  const closed=harness('16:10:00',{getMarketSession:()=>({marketState:()=>({calendarKnown:true,isClosed:true})})});
  await closed.controller.ensure();assert.equal(closed.calls.length,0);assert.equal(closed.controller.getStatus().state,'closed');
  const split=harness('16:10:00',{getMarketSession:()=>({marketState:m=>({calendarKnown:true,isClosed:m==='HK'})})});
  await split.controller.ensure();assert.equal(split.calls.length,1);
});
test('throwing refresh is a retryable failure, never an unhandled rejection',async()=>{
  const h=harness('16:10:00',{refresh:()=>{throw Error('offline');}});
  await h.controller.ensure();assert.equal(h.controller.getStatus().state,'partial');assert.equal(h.controller.getStatus().attempts,1);
});
test('simultaneous ensure calls share one pending refresh',async()=>{
  let finish;const h=harness('16:10:00',{refresh:()=>new Promise(resolve=>{finish=resolve;})});
  const a=h.controller.ensure(),b=h.controller.ensure();assert.equal(a,b);await Promise.resolve();assert.equal(h.calls.length,1);
  finish({ok:true,forced:true,startedAt:h.now(),completedAt:h.now(),failed:[]});await a;
});
test('failure budget and next retry survive page reload',async()=>{
  const failed=()=>({ok:false,forced:true,startedAt:at('16:10:00'),completedAt:at('16:10:00'),failed:['涨跌停']});
  const first=harness('16:10:00',{refresh:failed});await first.controller.ensure();
  const second=harness('16:10:30',{storage:first.storage,refresh:failed});await second.controller.ensure();
  assert.equal(second.calls.length,0);assert.equal(second.controller.getStatus().attempts,1);
  second.setTime('16:11:00');await second.controller.ensure();assert.equal(second.calls.length,1);
  assert.equal(second.controller.getStatus().attempts,2);
});
test('empty returned success is treated as incomplete rather than completing the day',async()=>{
  const h=harness('16:10:00',{refresh:()=>({ok:true})});await h.controller.ensure();
  assert.equal(h.controller.getStatus().state,'partial');assert.equal(h.controller.getStatus().attempts,1);
});
test('a pending round finishing after midnight cannot mark the new day complete',async()=>{
  let finish;const h=harness('23:59:59',{refresh:()=>new Promise(resolve=>{finish=resolve;})});
  const p=h.controller.ensure();await Promise.resolve();h.setTime('2026-10-21T00:00:01+08:00');
  finish({ok:true,forced:true,startedAt:at('23:59:59'),completedAt:h.now(),failed:[]});await p;
  await h.controller.ensure();assert.notEqual(h.controller.getStatus().state,'complete');
  assert.equal(h.calls.length,1);
});
test('other open page waits on the pending lease instead of launching duplicate work',async()=>{
  let finish;const first=harness('16:10:00',{refresh:()=>new Promise(resolve=>{finish=resolve;})});
  const p=first.controller.ensure();await Promise.resolve();
  const second=harness('16:10:01',{storage:first.storage});await second.controller.ensure();assert.equal(second.calls.length,0);
  first.setTime('16:10:02');finish({ok:true,forced:true,startedAt:at('16:10:00'),completedAt:first.now(),failed:[]});await p;
  second.setTime('16:10:03');await second.controller.ensure();assert.equal(second.calls.length,0);
  assert.equal(second.controller.getStatus().state,'complete');
});
