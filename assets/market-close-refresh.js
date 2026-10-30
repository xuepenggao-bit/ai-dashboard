(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.MarketCloseRefresh=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const OFFSET=8*60*60*1000,CLOSE_MINUTE=16*60+10;
  const KEY='market_close_refresh_v1:',LEASE_MS=5*60*1000,MAX_ATTEMPTS=96,MAX_BACKOFF_MS=30*60*1000;
  function retryDelay(attempts){return attempts===1?60000:attempts===2?300000:attempts===3?900000:MAX_BACKOFF_MS;}
  function beijingClock(ms){
    const d=new Date(ms+OFFSET);
    return {date:d.toISOString().slice(0,10),weekday:d.getUTCDay(),
      minute:d.getUTCHours()*60+d.getUTCMinutes(),
      cutoff:Date.parse(d.toISOString().slice(0,10)+'T16:10:00+08:00')};
  }
  function timestamp(value){
    if(typeof value!=='number'||!Number.isFinite(value)||value<0) return null;
    return value;
  }
  function createController(options){
    const opts=options||{},now=opts.now||Date.now;
    const storage=opts.storage,refresh=opts.refresh||function(args){return root.refreshMacro(args);};
    const visible=opts.isVisible||function(){return true;};
    const active=opts.isActive||function(){return true;};
    const getSession=opts.getMarketSession||function(){return root.PortfolioMarketSession;};
    const later=opts.setTimer||function(fn,ms){return setTimeout(fn,ms);};
    const cancel=opts.clearTimer||function(id){clearTimeout(id);};
    const owner=String(now())+'-'+Math.random().toString(36).slice(2);
    const memory=Object.create(null);
    let flight=null,wake=null,lastStatus=null,destroyed=false,storageDisabled=false;
    function fresh(date){return {date,attempts:0,nextAttemptAt:0,lastAttemptAt:0,completedAt:null,startedAt:null,failed:[]};}
    function validMeta(value,c,time){
      if(!value||value.date!==c.date) return null;
      const m=fresh(c.date);
      if(Number.isInteger(value.attempts)&&value.attempts>=0&&value.attempts<=MAX_ATTEMPTS) m.attempts=value.attempts;
      if(timestamp(value.lastAttemptAt)!=null&&value.lastAttemptAt<=time) m.lastAttemptAt=value.lastAttemptAt;
      if(timestamp(value.nextAttemptAt)!=null&&value.nextAttemptAt<=time+MAX_BACKOFF_MS) m.nextAttemptAt=value.nextAttemptAt;
      const start=timestamp(value.startedAt),end=timestamp(value.completedAt);
      // A saved flag alone is not proof: only a completed forced post-close round counts.
      if(value.forced===true&&start!=null&&end!=null&&start>=c.cutoff&&end>=start&&end<=time&&beijingClock(end).date===c.date){
        m.startedAt=start;m.completedAt=end;m.forced=true;
      }
      if(Array.isArray(value.failed)) m.failed=value.failed.filter(v=>typeof v==='string').slice(0,30);
      if(value.lease&&typeof value.lease.owner==='string'&&timestamp(value.lease.until)!=null&&
        value.lease.until>time&&value.lease.until<=time+LEASE_MS) m.lease=value.lease;
      return m;
    }
    function read(c,time){
      let m=memory[c.date]||fresh(c.date);
      try{
        const raw=!storageDisabled&&storage&&storage.getItem(KEY+c.date);
        const parsed=raw?validMeta(JSON.parse(raw),c,time):null;
        if(parsed) m=parsed;
      }catch(_){storageDisabled=true;}
      // Revalidate memory too after clock changes or sleep.
      m=validMeta(m,c,time)||fresh(c.date);
      memory[c.date]=m;
      return m;
    }
    function write(m){
      memory[m.date]=m;
      try{if(storage&&!storageDisabled) storage.setItem(KEY+m.date,JSON.stringify(m));}catch(_){storageDisabled=true;}
    }
    function tradingDay(c,time){
      if(c.weekday===0||c.weekday===6) return false;
      const session=getSession();
      if(session&&typeof session.marketState==='function'){
        try{
          const a=session.marketState('A',time),hk=session.marketState('HK',time);
          if(a&&hk&&a.calendarKnown&&hk.calendarKnown&&a.isClosed&&hk.isClosed) return false;
        }catch(_){}
      }
      return true;
    }
    function publish(state,m,c,extra){
      const status=Object.assign({state,date:c.date,attempts:m.attempts,completedAt:m.completedAt,failed:m.failed||[]},extra||{});
      lastStatus=status;
      if(typeof opts.onStatus==='function') opts.onStatus(status);
      return status;
    }
    function release(m){if(m.lease&&m.lease.owner===owner) delete m.lease;}
    function reportTimes(report,c,time){
      if(!report||typeof report!=='object') return null;
      const start=timestamp(report.startedAt),end=timestamp(report.completedAt);
      if(start==null||end==null||end<start||end>time||beijingClock(end).date!==c.date) return null;
      return {start,end};
    }
    function observe(report){
      const time=now(),c=beijingClock(time),m=read(c,time),times=reportTimes(report,c,time);
      if(flight) flight.observed=report;
      if(times&&report.forced===true&&report.ok===true&&Array.isArray(report.failed)&&report.failed.length===0&&
        times.start>=c.cutoff&&tradingDay(c,time)){
        m.startedAt=times.start;m.completedAt=times.end;m.forced=true;m.nextAttemptAt=0;m.failed=[];
        release(m);write(m);publish('complete',m,c);
        return true;
      }
      return false;
    }
    function schedule(ms){
      if(wake!=null) cancel(wake);
      wake=later(function(){wake=null;ensure();},ms);
    }
    function settle(current,report,error){
      const time=now(),c=beijingClock(time);
      if(report) observe(report);
      const actual=report||current.observed,m=read(c,time);
      if(flight===current) flight=null;
      if(current.date!==c.date){
        const old=memory[current.date];if(old){release(old);write(old);}
        schedule(0);return lastStatus;
      }
      release(m);
      if(m.completedAt!=null){write(m);return publish('complete',m,c);}
      const times=reportTimes(actual,c,time);
      // refreshMacro reuses an existing promise. A pre-close or non-forced round
      // does not consume a failed attempt; request a genuinely forced round next.
      if(!error&&times&&(actual.forced===false||(actual.forced===true&&times.start<c.cutoff))){
        m.nextAttemptAt=time+1000;write(m);schedule(1000);
        return publish('scheduled',m,c,{waitingForFreshRound:true});
      }
      m.attempts=Math.min(MAX_ATTEMPTS,m.attempts+1);
      m.failed=Array.isArray(actual&&actual.failed)&&actual.failed.length?
        actual.failed.filter(v=>typeof v==='string').slice(0,30):['刷新未完整完成'];
      // Disclosures can arrive well after 16:10. Keep checking with bounded
      // backoff instead of permanently stopping after the first three tries.
      m.nextAttemptAt=m.attempts<MAX_ATTEMPTS?time+retryDelay(m.attempts):0;
      write(m);
      if(m.attempts<MAX_ATTEMPTS) schedule(m.nextAttemptAt-time);
      return publish('partial',m,c,{retryAt:m.nextAttemptAt||null});
    }
    function ensure(){
      if(destroyed) return Promise.resolve(lastStatus);
      const time=now(),c=beijingClock(time),m=read(c,time);
      if(m.completedAt!=null) return Promise.resolve(publish('complete',m,c));
      if(!tradingDay(c,time)) return Promise.resolve(publish('closed',m,c));
      if(c.minute<CLOSE_MINUTE) return Promise.resolve(publish('scheduled',m,c));
      if(!visible()||!active()) return Promise.resolve(publish('inactive',m,c));
      if(flight) return flight.promise;
      if(m.attempts>=MAX_ATTEMPTS) return Promise.resolve(publish('partial',m,c,{retryAt:null}));
      if(m.nextAttemptAt>time) return Promise.resolve(publish(m.attempts?'partial':'scheduled',m,c,{retryAt:m.nextAttemptAt}));
      if(m.lease&&m.lease.owner!==owner) return Promise.resolve(publish('refreshing',m,c));
      m.lastAttemptAt=time;m.lease={owner,until:time+LEASE_MS};write(m);
      // Read back the lease to avoid the usual duplicate work across open tabs.
      const confirmed=read(c,time);
      if(confirmed.lease&&confirmed.lease.owner!==owner) return Promise.resolve(publish('refreshing',confirmed,c));
      const current={date:c.date,observed:null,promise:null};flight=current;
      publish('refreshing',confirmed,c);
      current.promise=Promise.resolve().then(function(){return refresh({force:true,reason:'close'});})
        .then(function(report){return settle(current,report,null);},function(error){return settle(current,null,error);});
      return current.promise;
    }
    function destroy(){destroyed=true;if(wake!=null) cancel(wake);wake=null;}
    return {ensure,observe,getStatus:function(){return lastStatus;},destroy};
  }
  let defaultController=null,interval=null,observer=null,attached=false;
  function renderStatus(status){
    const element=root.document&&root.document.getElementById('marketCloseStatus');
    if(!element) return;
    const labels={scheduled:'每日16:10后统一刷新',refreshing:'正在刷新收盘指标',complete:'收盘后已核验',partial:'收盘指标待补齐',closed:'今日两市休市',inactive:'每日16:10后统一刷新'};
    element.textContent=labels[status.state]||labels.scheduled;
    element.dataset.state=status.state;
    element.title=status.failed.length?status.failed.join('、'):
      status.completedAt!=null?'北京时间 '+new Date(status.completedAt+OFFSET).toISOString().slice(11,16)+' 完成':'';
  }
  function init(){
    if(attached||!root.document) return;
    attached=true;
    let storage;try{storage=root.localStorage;}catch(_){}
    defaultController=createController({storage,
      isVisible:function(){return root.document.visibilityState!=='hidden';},
      isActive:function(){const tab=root.document.getElementById('t0');return !!(tab&&tab.classList.contains('active'));},
      onStatus:renderStatus});
    const check=function(){defaultController.ensure();};
    root.document.addEventListener('visibilitychange',check);
    root.addEventListener('pageshow',check);
    root.addEventListener('focus',check);
    root.addEventListener('storage',function(event){if(event.key&&event.key.indexOf(KEY)===0) check();});
    const tab=root.document.getElementById('t0');
    if(tab&&typeof root.MutationObserver==='function'){
      observer=new root.MutationObserver(check);observer.observe(tab,{attributes:true,attributeFilter:['class']});
    }
    interval=root.setInterval(check,30000);check();
  }
  const api={createController,beijingClock,init,
    ensure:function(){if(!defaultController) init();return defaultController&&defaultController.ensure();},
    observe:function(report){if(!defaultController) init();return defaultController?defaultController.observe(report):false;}};
  if(root.document){
    if(root.document.readyState==='loading') root.document.addEventListener('DOMContentLoaded',init,{once:true});
    else init();
  }
  return api;
});
