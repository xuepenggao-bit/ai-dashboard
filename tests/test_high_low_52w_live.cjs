const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/high-low-52w-live.js'),'utf8');
const now=Date.parse('2026-10-09T10:15:00+08:00');
const stocks=Array.from({length:4000},(_,i)=>({code:'sh'+String(600000+i),firstDate:'2024-01-01',
  lastDate:'2026-09-30',close:7,highs:[['2026-09-30',10]],lows:[['2026-09-30',5]]}));
const baseline={schemaVersion:1,asOfDate:'2026-09-30',validThrough:'2026-10-21',updatedAt:'2026-09-30T08:00:00Z',stocks};
function quote(code,change={}){
  const f=Array(90).fill('');
  Object.assign(f,{3:'8',4:'7',6:'10',30:'20261009101400',33:'10',34:'6'},change);
  return 'v_'+code+'="'+f.join('~')+'";';
}
function context(config={}){
  let captured=[],statuses=[],urls=[],requests=0,active=0,maxActive=0;
  let displayed=(config.displayRows||[]).slice(),frames=[],scriptCount=0,maxFrames=0;
  let fixedNow=config.now||now;
  const listeners=new Map(),intervals=[];
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[fixedNow]));}static now(){return fixedNow;}}
  const document={hidden:false,addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);},getElementById:()=>({classList:{contains:()=>true}}),
    body:{appendChild(frame){frames.push(frame);maxFrames=Math.max(maxFrames,frames.filter(f=>!f.removed).length);}},
    createElement(type){
      assert.equal(type,'iframe');const frame={style:{},setAttribute(){},contentWindow:{},removed:false,remove(){this.removed=true;}};
      frame.contentDocument={createElement(kind){assert.equal(kind,'script');return{removed:false,remove(){this.removed=true;}};},head:{appendChild(script){
        scriptCount++;frame.script=script;if(config.scriptTimeout)return;
        Promise.resolve().then(()=>{
          if(frame.removed)return;
          if(config.scriptError){script.onerror?.();return;}
          const codes=/q=([^&]+)/.exec(script.src)[1].split(',');
          for(const code of codes){
            if(config.scriptMissing===code||(config.missing&&code==='sh600000')||(config.manyMissing&&/^sh6000/.test(code)))continue;
            const change={...(config.stamp?{30:config.stamp}:{}),...(config.scriptByFrame?{3:String(8+frames.indexOf(frame))}:{})};
            frame.contentWindow['v_'+code]=quote(code,change).match(/="([^"]*)"/)[1];
          }
          frame.contentWindow.v_sh999999=quote('sh999999').match(/="([^"]*)"/)[1];
          script.onload?.();
        });
      }}};return frame;
    }};
  const ctx=vm.createContext({Date:FakeDate,Map,Set,Promise,Number,Math,Error,setTimeout:(fn,delay)=>config.captureSchedule&&delay===1800?0:setTimeout(fn,config.fastScriptTimeout&&delay===6500?1:delay),clearTimeout,setInterval:(callback,delay)=>{intervals.push({callback,delay});return intervals.length;},
    console:{warn(){}},document,window:{addEventListener(){}},
    _highLow52Clock:()=>config.clock||({date:'2026-10-09',minute:615}),
    _setHighLow52LiveStatus:message=>statuses.push(message),
    _setHighLow52LivePoint:r=>{if(config.rejectDisplay)return false;captured.push(r);displayed=displayed.filter(old=>old.date!==r.date);displayed.push(r);return true;},
    _highLow52OrderedRows:()=>displayed.slice().sort((a,b)=>a.date.localeCompare(b.date)),
    _acceptHighLow52Payload:payload=>{
      const clock=config.clock||({date:'2026-10-09',minute:615});let accepted=false;
      for(const row of payload?.series||[])if(row.date===clock.date&&row.status==='close'&&row.asOf==='15:00'&&clock.minute>=900&&Number.isInteger(row.eligible)&&row.eligible>=4000){displayed=displayed.filter(old=>old.date!==row.date);displayed.push(row);accepted=true;}
      return accepted;
    },
    _idxFetch:async url=>{
      requests++;urls.push(url);active++;maxActive=Math.max(maxActive,active);
      await Promise.resolve();active--;
      if(url.includes('baseline.json'))return config.baseline||baseline;
      if(url.includes('market_high_low_52w.json'))return config.history||{series:[]};
      if(url.includes('fqkline')){
        if(config.tencentDown)throw Error('HTTP 501');
        const code=/param=([^,]+)/.exec(url)[1];
        const rows=code==='sh000001'?(config.calendar||[['2026-09-30'],['2026-10-09']]):[
          ['2024-01-01','7','7','10','5','1'],['2026-09-30','6',config.badAdjustment?'6.5':'6','9','4','1'],['2026-10-09','6','7','8','4','1']];
        return{code:0,data:{[code]:{qfqday:rows}}};
      }
      if(url.includes('push2his.eastmoney.com')){
        const code=/secid=\d\.([^&]+)/.exec(url)[1];
        return{rc:0,data:{code:config.badBackup?'000000':code,market:code==='399106'?0:1,klines:[
          '2024-01-01,7,7,10,5,10','2026-09-30,7,7,10,5,10','2026-10-09,7,8,10,6,10']}};
      }
      if(url.includes('qt.gtimg')){
        if(config.quoteFetchFails)throw Error(config.quoteError||'Failed to fetch');
        const codes=/q=([^&]+)/.exec(url)[1].split(',');
        return codes.map(code=>{
          if(config.missing&&code==='sh600000')return '';
          if(config.manyMissing&&/^sh6000/.test(code))return '';
          const index=code==='sh000001'||code==='sz399106';
          if(config.holiday&&index)return quote(code,{30:'20260930150000'});
          if(config.stale&&code==='sh600000')return quote(code,{30:'20260930150000'});
          if(config.suspend&&code==='sh600000')return quote(code,{6:'0',33:'0',34:'0'});
          if(config.adjust&&code==='sh600000')return quote(code,{4:'6',33:'8',34:'4'});
          return quote(code,config.stamp?{30:config.stamp}:{});
        }).join('\n');
      }
      throw Error('Unexpected URL '+url);
    },
  });
  vm.runInContext(source,ctx);
  return{ctx,captured,statuses,urls,frames,intervals,advance:ms=>{fixedNow+=ms;},emit:name=>(listeners.get(name)||[]).forEach(callback=>callback()),scripts:()=>scriptCount,maxFrames:()=>maxFrames,requests:()=>requests,maxActive:()=>maxActive};
}
module.exports=(async()=>{
  const c=context();
  assert.equal(c.ctx._hl52ValidBaseline(baseline),true);
  assert.equal(c.ctx._hl52ValidBaseline({...baseline,stocks:[...stocks,stocks[0]]}),false,'Duplicate stock must fail');
  assert.throws(()=>c.ctx._hl52Quotes(quote('sh600000'),['sh600000','sh600001']),/完整/);
  assert.equal(c.ctx._hl52Quotes(quote('sh600000',{33:''}),['sh600000']).size,1,'Missing high does not discard a valid price for other consumers');
  assert.throws(()=>c.ctx._hl52Classify(c.ctx._hl52Quotes(quote('sh600000',{33:''}),[]).get('sh600000'),{high:10,low:5},'2026-10-09'),/无效/);
  const expired={highs:[['2025-10-09',100],['2026-09-30',10]],lows:[['2025-10-09',1],['2026-09-30',5]]};
  assert.deepEqual(JSON.parse(JSON.stringify(c.ctx._hl52Thresholds(expired,'2026-10-09'))),{high:10,low:5},'Exactly 364 calendar days, not one calendar year');
  await Promise.all([c.ctx.refreshHighLow52Live(true),c.ctx.refreshHighLow52Live(true)]);
  assert.equal(c.captured.length,1,'Only publish a complete full-market observation');
  assert.equal(c.captured[0].high,4000);assert.equal(c.captured[0].low,0);
  assert.equal(c.captured[0].eligible,4000);assert.equal(c.captured[0].asOf,'10:14');
  assert.equal(c.ctx.window.highLow52LiveState().status,'ready');assert.equal(c.ctx.window.highLow52LiveState().asOf,'10:14');
  assert.equal(c.scripts(),0,'A successful fetch never creates a script request');
  assert.ok(c.maxActive()<=4,'Bound parallel network work');
  const count=c.requests();await c.ctx.refreshHighLow52Live();assert.equal(c.requests(),count,'One-minute throttle');
  const scheduled=context({captureSchedule:true});
  scheduled.emit('DOMContentLoaded');
  assert.equal(scheduled.intervals.length,1,'Only one live wakeup scheduler is installed');
  const wakeup=scheduled.intervals[0];
  assert.equal(wakeup.delay,5000,'Lightweight wakeups avoid a full extra minute after a tab activation');
  scheduled.advance(2000);
  await scheduled.ctx.refreshHighLow52Live(true);
  assert.equal(scheduled.captured.length,1,'Tab activation starts the first full scan');
  const afterFirst=scheduled.requests();
  scheduled.advance(58000);
  await wakeup.callback();
  assert.equal(scheduled.requests(),afterFirst,'The page-load 60-second boundary is still throttled after a later tab activation');
  scheduled.advance(5000);
  const nextScan=wakeup.callback(),concurrentWakeup=wakeup.callback();
  assert.equal(nextScan,concurrentWakeup,'Concurrent scheduler and snapshot wakeups share the pending scan');
  await nextScan;
  assert.equal(scheduled.captured.length,2,'The next wakeup completes an automatic scan within 65 seconds instead of waiting until 120 seconds');
  const afterSecond=scheduled.requests();
  scheduled.advance(5000);await wakeup.callback();
  assert.equal(scheduled.requests(),afterSecond,'Five-second wakeups do not increase the one-minute network scan frequency');
  assert.equal(c.ctx._hl52Fresh({date:'2026-10-09',time:'10:09'},{date:'2026-10-09',minute:615}),false,'Old quotes cannot be labelled realtime');
  assert.equal(c.ctx._hl52Fresh({date:'2026-10-09',time:'11:30'},{date:'2026-10-09',minute:750}),true,'Lunch retains the valid morning close');
  assert.equal(c.ctx._hl52Fresh({date:'2026-10-09',time:'25:00'},{date:'2026-10-09',minute:615}),false,'Invalid source time is rejected');
  const lunchBaseline={...baseline,asOfDate:'2026-10-26',validThrough:'2026-11-16',updatedAt:'2026-10-27T10:14:00+08:00',
    stocks:stocks.map(stock=>({...stock,lastDate:'2026-10-26'}))};
  const lunchConfig={now:Date.parse('2026-10-27T12:06:00+08:00'),clock:{date:'2026-10-27',minute:726},
    calendar:[['2026-10-23'],['2026-10-26'],['2026-10-27']],stamp:'20261027113000',baseline:lunchBaseline};
  const lunch=context(lunchConfig);await lunch.ctx.refreshHighLow52Live(true);
  assert.equal(lunch.captured.length,1,'A repaired previous-close baseline allows a fresh lunch observation without rebuilding history');
  assert.equal(lunch.captured[0].date,'2026-10-27');assert.equal(lunch.captured[0].asOf,'11:30');
  assert.equal(lunch.captured[0].high,4000);assert.equal(lunch.captured[0].low,0);
  assert.equal(lunch.captured[0].observed,4000);assert.equal(lunch.captured[0].missing,0);
  const staleLunch=context({...lunchConfig,baseline:{...lunchBaseline,asOfDate:'2026-10-23',
    stocks:stocks.map(stock=>({...stock,lastDate:'2026-10-23'}))}});
  await staleLunch.ctx.refreshHighLow52Live(true);
  assert.equal(staleLunch.captured.length,0,'An older vintage must not be used to invent today\'s count');
  assert.match(staleLunch.statuses.at(-1),/基准截至 2026-10-23，需 2026-10-26 收盘基准/,'State the actual missing baseline, not a generic realtime failure');
  assert.equal(staleLunch.urls.some(url=>url.includes('q=sh600000')),false,'Reject an obsolete baseline before an expensive all-stock quote scan');
  assert.equal(staleLunch.ctx.window.highLow52LiveState().status,'blocked');
  assert.equal(staleLunch.ctx.window.highLow52LiveState().baselineDate,'2026-10-23');
  assert.equal(staleLunch.ctx.window.highLow52LiveState().requiredBaselineDate,'2026-10-26');
  const todayBaseline={...lunchBaseline,asOfDate:'2026-10-27',updatedAt:'2026-10-27T20:00:00+08:00',stocks:stocks.map(stock=>({...stock,lastDate:'2026-10-27'}))};
  const todayConfig={now:Date.parse('2026-10-28T10:15:00+08:00'),clock:{date:'2026-10-28',minute:615},calendar:[['2026-10-26'],['2026-10-27'],['2026-10-28']],stamp:'20261028101400',baseline:todayBaseline};
  const today=context(todayConfig);assert.equal(today.ctx.window.highLow52LiveState().status,'idle');
  const todayPending=today.ctx.refreshHighLow52Live(true);assert.equal(today.ctx.window.highLow52LiveState().status,'loading');await todayPending;
  assert.equal(today.captured[0].date,'2026-10-28');assert.equal(today.captured[0].asOf,'10:14');
  assert.equal(today.ctx.window.highLow52LiveState().status,'ready');assert.equal(today.ctx.window.highLow52LiveState().baselineDate,'2026-10-27');
  const independentState=today.ctx.window.highLow52LiveState();independentState.status='error';assert.equal(today.ctx.window.highLow52LiveState().status,'ready','External readers cannot mutate collector state');
  const rejected=context({...todayConfig,rejectDisplay:true});await rejected.ctx.refreshHighLow52Live(true);
  assert.equal(rejected.ctx.window.highLow52LiveState().status,'blocked','Collector success cannot conceal a rejected display point');
  assert.equal(rejected.ctx.window.highLow52LiveState().asOf,null);
  const throughScript=context({...todayConfig,quoteFetchFails:true});throughScript.ctx.window.v_sh600000='dashboard-owned-value';
  await throughScript.ctx.refreshHighLow52Live(true);
  assert.equal(throughScript.captured[0].date,'2026-10-28');assert.equal(throughScript.ctx.window.highLow52LiveState().status,'ready');
  assert.ok(throughScript.scripts()>1);assert.ok(throughScript.maxFrames()<=4,'Script fallback keeps the bounded worker pool');
  assert.equal(throughScript.ctx.window.v_sh600000,'dashboard-owned-value','Fallback must not mutate the dashboard global quote namespace');
  assert.ok(throughScript.frames.every(frame=>frame.removed&&frame.script.removed&&frame.script.onload===null&&frame.script.onerror===null),'Every successful isolated script batch is cleaned up');
  assert.equal(new Set(throughScript.frames.map(frame=>frame.id)).size,throughScript.frames.length,'Each batch owns a unique isolated frame');
  const concurrent=context({quoteFetchFails:true,scriptByFrame:true});
  const parallel=await Promise.all([concurrent.ctx._hl52GetQuotes(['sh600000']),concurrent.ctx._hl52GetQuotes(['sh600000'])]);
  assert.equal(parallel[0].get('sh600000').price,8);assert.equal(parallel[1].get('sh600000').price,9,'Concurrent same-symbol batches read only their own response');
  assert.equal(parallel[0].has('sh999999'),false,'Unrequested symbols are never imported from the script response');
  const incompleteScript=context({quoteFetchFails:true,scriptMissing:'sh600001'});
  await assert.rejects(incompleteScript.ctx._hl52GetQuotes(['sh600000','sh600001']),/未完整返回/);
  assert.ok(incompleteScript.frames.every(frame=>frame.removed&&frame.script.removed),'A partial script response still releases its isolated frame');
  const scriptFailure=context({...todayConfig,quoteFetchFails:true,scriptError:true});await scriptFailure.ctx.refreshHighLow52Live(true);
  assert.equal(scriptFailure.ctx.window.highLow52LiveState().status,'error');assert.equal(scriptFailure.ctx.window.highLow52LiveState().asOf,null);
  assert.ok(scriptFailure.frames.every(frame=>frame.removed&&frame.script.removed));
  const scriptTimeoutConfig={...todayConfig,quoteFetchFails:true,scriptTimeout:true,fastScriptTimeout:true},timedOut=context(scriptTimeoutConfig);
  await timedOut.ctx.refreshHighLow52Live(true);assert.equal(timedOut.ctx.window.highLow52LiveState().status,'error');
  assert.match(timedOut.ctx.window.highLow52LiveState().message,/超时/);assert.ok(timedOut.frames.every(frame=>frame.removed&&frame.script.removed));
  scriptTimeoutConfig.scriptTimeout=false;await timedOut.ctx.refreshHighLow52Live(true);assert.equal(timedOut.ctx.window.highLow52LiveState().status,'ready','A timeout releases the scan lock and may recover without reloading');
  assert.throws(()=>concurrent.ctx._hl52QuoteCodes(['sh600000&evil=1']),/范围无效/);
  assert.throws(()=>concurrent.ctx._hl52QuoteCodes(['sh600000','sh600000']),/范围无效/);
  assert.throws(()=>concurrent.ctx._hl52QuoteCodes(Array(81).fill('sh600000')),/范围无效/);
  const completedConfig={...todayConfig,now:Date.parse('2026-10-28T15:30:00+08:00'),clock:{date:'2026-10-28',minute:930},stamp:'20261028150000',baseline:{...todayBaseline,asOfDate:'2026-10-28'}};
  const noCompleted=context(completedConfig);await noCompleted.ctx.refreshHighLow52Live(true);
  assert.equal(noCompleted.ctx.window.highLow52LiveState().status,'blocked','A same-day baseline alone cannot declare the chart up to date');
  assert.ok(noCompleted.urls.some(url=>url.includes('market_high_low_52w.json')),'Read the completed history without recursively launching the live refresh');
  const completeRow={date:'2026-10-28',status:'close',asOf:'15:00',high:123,low:45,eligible:4000,universe:4000,observed:4000,missing:0};
  const completed=context({...completedConfig,history:{series:[completeRow]}});await completed.ctx.refreshHighLow52Live(true);
  assert.equal(completed.ctx.window.highLow52LiveState().status,'ready');assert.equal(completed.ctx.window.highLow52LiveState().asOf,'15:00');assert.equal(completed.captured.length,0,'A valid same-day close does not trigger another all-stock scan');
  const sanitizing=context(todayConfig);sanitizing.ctx._hl52Status('<img src=x onerror=alert(1)>source failed','error');
  assert.equal(sanitizing.ctx.window.highLow52LiveState().message,'source failed');
  sanitizing.ctx._hl52SetState('blocked',{baselineDate:'2026-02-30',requiredBaselineDate:'2099-01-01'});
  assert.equal(sanitizing.ctx.window.highLow52LiveState().baselineDate,null);assert.equal(sanitizing.ctx.window.highLow52LiveState().requiredBaselineDate,null);
  for(const config of [{manyMissing:true},{holiday:true},{baseline:{...baseline,asOfDate:'2026-09-29'}},
    {baseline:{...baseline,validThrough:'2026-10-08'}}]){
    const t=context(config);await t.ctx.refreshHighLow52Live(true);assert.equal(t.captured.length,0,JSON.stringify(config).slice(0,100));
  }
  const recoveringConfig={baseline:{...baseline,asOfDate:'2026-09-29',updatedAt:'2026-09-29T08:00:00Z'}};
  const recovering=context(recoveringConfig);
  await recovering.ctx.refreshHighLow52Live(true);
  assert.equal(recovering.captured.length,0,'Stale comparison prices cannot produce a false live count');
  recoveringConfig.baseline={...baseline};
  await recovering.ctx.refreshHighLow52Live(true);
  assert.equal(recovering.captured.length,1,'A repaired baseline must be picked up immediately without reloading the page');
  assert.equal(recovering.captured[0].asOf,'10:14');
  recoveringConfig.stamp='20261009101500';
  await recovering.ctx.refreshHighLow52Live(true);
  assert.equal(recovering.captured.length,2,'The same session continues to publish fresh observations');
  assert.equal(recovering.captured[1].asOf,'10:15');
  for(const config of [{missing:true},{stale:true},{adjust:true,badAdjustment:true}]){
    const partial=context(config);await partial.ctx.refreshHighLow52Live(true);
    assert.equal(partial.captured.length,1,'Isolated unavailable stock no longer cancels whole market');
    assert.equal(partial.captured[0].observed,3999);assert.equal(partial.captured[0].missing,1);
    assert.equal(partial.captured[0].high,3999,'No extrapolation of missing observations');
  }
  const suspend=context({suspend:true});await suspend.ctx.refreshHighLow52Live(true);
  assert.equal(suspend.captured[0].high,3999,'Explicitly suspended stock contributes neither extreme');
  const adjusted=context({adjust:true});await adjusted.ctx.refreshHighLow52Live(true);
  assert.equal(adjusted.captured[0].high,3999);assert.equal(adjusted.captured[0].low,1,'Refresh ex-dividend basis before comparison');
  const backup=context({tencentDown:true});await backup.ctx.refreshHighLow52Live(true);
  assert.equal(backup.captured[0].high,4000,'Alternate adjusted daily source keeps quote scans working');
  const wrongBackup=context({tencentDown:true,badBackup:true});await wrongBackup.ctx.refreshHighLow52Live(true);
  assert.equal(wrongBackup.captured.length,0,'Wrong alternate instrument must be rejected');
  const independent=context({manyMissing:true});let maCalls=0;
  independent.ctx.window.loadMaBreadthBaseline=async()=>baseline;
  independent.ctx.window.applyMaBreadthLiveQuotes=async()=>{maCalls++;return false;};
  await independent.ctx.refreshHighLow52Live(true);
  assert.equal(maCalls,1,'52-week coverage failure does not prevent independent consumers from validating their observations');
  assert.deepEqual(JSON.parse(JSON.stringify(c.ctx._hl52DailyThresholds([
    ['2024-01-01',7,7,10,5],['2026-09-29',7,7,10,5],['2026-10-09',8,8,11,6]
  ],'2026-10-09','2026-09-30','2026-09-29'))),{high:10,low:5,close:7},'Resumed stock uses its actual last traded session');
  const ipo=context({baseline:{...baseline,stocks:[...stocks,{...stocks[0],code:'sz301999',firstDate:'2026-09-01'}]}});
  await ipo.ctx.refreshHighLow52Live(true);
  assert.equal(ipo.captured[0].eligible,4000);assert.equal(ipo.captured[0].universe,4001,'Recent IPOs excluded from numerator');
  const hidden=context();hidden.ctx.document.hidden=true;await hidden.ctx.refreshHighLow52Live(true);
  assert.equal(hidden.requests(),0,'Hidden tab makes no requests');
  return 'PASS: live scans, repaired previous-close lunch observations, dated baseline-gap diagnostics, explicit missing/stale coverage, 99% minimum, 364-day expiry, holiday rejection, ex-dividend correction, IPO/suspension rules, bounded concurrency and throttling';
})();


