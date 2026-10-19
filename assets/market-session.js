(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.PortfolioMarketSession=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  // Official cash-equity exchange calendar (not the Stock Connect calendar).
  // Embedded so a holiday is recognized before the first asynchronous fetch.
  const EMBEDDED_CALENDAR={schemaVersion:1,updatedAt:'2026-10-19T09:00:00+08:00',timezone:'Asia/Shanghai',
    scope:'沪深A股与香港现金股票市场；不是沪深港通交易日历',markets:{
      A:{label:'沪深A股',years:{'2026':{verified:true,
        sourceUrl:'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml',
        sourceUrls:['https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml','https://www.szse.cn/disclosure/notice/general/t20251222_618087.html'],
        holidays:['2026-01-01','2026-01-02','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-23','2026-04-06','2026-05-01','2026-05-04','2026-05-05','2026-06-19','2026-09-25','2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07'],halfDays:[]}}},
      HK:{label:'香港股票',years:{'2026':{verified:true,
        sourceUrl:'https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf',
        holidays:['2026-01-01','2026-02-17','2026-02-18','2026-02-19','2026-04-03','2026-04-06','2026-04-07','2026-05-01','2026-05-25','2026-06-19','2026-07-01','2026-10-01','2026-10-19','2026-12-25'],
        halfDays:[{date:'2026-02-16',closeMinute:730},{date:'2026-12-24',closeMinute:730},{date:'2026-12-31',closeMinute:730}]}}}
    }};
  let defaultCalendar=EMBEDDED_CALENDAR;
  const MINUTE=60000;
  const A_ALIASES=new Set(['A','SH','SZ','SHA','SZA','SSE','SZSE','沪A','深A','A股']);
  const HK_ALIASES=new Set(['HK','HKEX','HKG','港股']);

  function finite(value){
    if(value==null||value===''||typeof value==='boolean') return null;
    const number=Number(value);
    return Number.isFinite(number)?number:null;
  }
  function validDate(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))) return false;
    const d=new Date(value+'T00:00:00Z');
    return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
  }
  function clock(nowMs){
    const value=nowMs==null?Date.now():Number(nowMs);
    if(!Number.isFinite(value)) throw new TypeError('Invalid market clock');
    const d=new Date(value+8*60*MINUTE);
    return {date:d.toISOString().slice(0,10),year:String(d.getUTCFullYear()),
      weekday:d.getUTCDay(),minute:d.getUTCHours()*60+d.getUTCMinutes(),
      second:d.getUTCSeconds(),nowMs:value};
  }
  function marketOf(stockOrMarket,code){
    const stock=stockOrMarket&&typeof stockOrMarket==='object'?stockOrMarket:null;
    const value=String(stock?(stock.mkt||stock.market||''):stockOrMarket||'').trim().toUpperCase();
    const symbol=String(stock?stock.code||'':code||'').trim();
    if(HK_ALIASES.has(value)) return 'HK';
    if(A_ALIASES.has(value)) return 'A';
    // A missing market is common in older portfolio JSON. An explicit unknown
    // market, however, must not silently become an A share based on its code.
    if(!value&&/^\d{5}$/.test(symbol)) return 'HK';
    if(!value&&/^\d{6}$/.test(symbol)) return 'A';
    return null;
  }
  function dateEntry(entries,date){
    return (Array.isArray(entries)?entries:[]).find(entry=>
      (typeof entry==='string'?entry:entry&&entry.date)===date);
  }
  function closeMinute(halfDay,market){
    const numeric=finite(halfDay&&typeof halfDay==='object'?halfDay.closeMinute:null);
    if(numeric!=null&&Number.isInteger(numeric)&&numeric>570&&numeric<=970) return numeric;
    const value=halfDay&&typeof halfDay==='object'?(halfDay.close||halfDay.closeTime):null;
    if(/^\d{2}:\d{2}$/.test(String(value||''))){
      const parts=value.split(':').map(Number);
      if(parts[0]<24&&parts[1]<60) return parts[0]*60+parts[1];
    }
    return market==='HK'?730:690;
  }
  function trustedSource(value,market){
    try{
      const url=new URL(String(value||''));
      const hosts=market==='HK'?['hkex.com.hk']:['sse.com.cn','szse.cn'];
      return url.protocol==='https:'&&hosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host));
    }catch(_){return false;}
  }
  function validYear(year,key,market){
    if(!/^\d{4}$/.test(String(key))||!year||year.verified!==true||!trustedSource(year.sourceUrl,market)||
      !Array.isArray(year.holidays)||!Array.isArray(year.halfDays)) return false;
    const holidayDates=year.holidays.map(entry=>typeof entry==='string'?entry:entry&&entry.date);
    const halfDates=year.halfDays.map(entry=>typeof entry==='string'?entry:entry&&entry.date);
    const dates=holidayDates.concat(halfDates);
    return dates.every(date=>validDate(date)&&date.slice(0,4)===String(key))&&
      new Set(dates).size===dates.length&&year.halfDays.every(entry=>{
        if(typeof entry==='string') return true;
        const n=finite(entry&&entry.closeMinute);
        return n!=null&&Number.isInteger(n)&&n>570&&n<=970;
      });
  }
  function validateCalendar(calendar){
    if(!calendar||calendar.schemaVersion!==1||calendar.timezone!=='Asia/Shanghai'||!calendar.markets) return false;
    return ['A','HK'].every(market=>{
      const years=calendar.markets[market]&&calendar.markets[market].years;
      return !!years&&Object.keys(years).length>0&&Object.entries(years).every(([key,value])=>validYear(value,key,market));
    });
  }
  function marketState(market,nowMs,calendar){
    const c=clock(nowMs),mkt=marketOf(market);
    const base={market:mkt,date:c.date,minute:c.minute,calendarKnown:false,
      isTradingDay:false,isClosed:false,phase:'unknown',status:'calendar_unknown',
      label:'交易日历待确认',reason:'calendar_coverage_missing'};
    if(!mkt) return {...base,status:'unsupported_market',label:'市场未识别',reason:'unsupported_market'};
    const data=calendar||defaultCalendar;
    const year=data&&data.markets&&data.markets[mkt]&&data.markets[mkt].years&&data.markets[mkt].years[c.year];
    // Weekends are known without assuming that an unannounced weekday is open.
    if(c.weekday===0||c.weekday===6){
      return {...base,calendarKnown:true,isClosed:true,phase:'closed',status:'market_closed',label:'休市',reason:'weekend'};
    }
    if(!validYear(year,c.year,mkt)) return base;
    const holiday=dateEntry(year.holidays,c.date);
    if(holiday){
      return {...base,calendarKnown:true,isClosed:true,phase:'closed',status:'market_closed',label:'休市',reason:'holiday',
        holidayName:typeof holiday==='object'?holiday.name||'':''};
    }
    const halfDay=dateEntry(year.halfDays,c.date),close=halfDay?closeMinute(halfDay,mkt):(mkt==='HK'?970:900);
    const continuousClose=mkt==='HK'?close-10:close;
    let phase='before_open';
    if(mkt==='A'&&c.minute>=540&&c.minute<555) phase='preopen';
    else if(c.minute>=(mkt==='HK'?540:555)&&c.minute<570) phase='auction';
    else if(c.minute>=570&&c.minute<continuousClose){
      phase=(c.minute>=(mkt==='HK'?720:690)&&c.minute<780)?'lunch':'continuous';
    }else if(c.minute>=continuousClose){
      phase=mkt==='HK'&&c.minute<close?'closing_auction':'after_close';
    }
    return {...base,calendarKnown:true,isTradingDay:true,isClosed:false,status:'trading_day',phase,
      halfDay:!!halfDay,closeMinute:close,continuousCloseMinute:continuousClose,label:phase==='before_open'||phase==='preopen'?'未开盘':
        phase==='lunch'?'午间休市':phase==='after_close'?'已收盘':'交易日',reason:'published_calendar'};
  }
  function quoteTimestamp(quote){
    if(!quote||typeof quote!=='object') return null;
    const raw=finite(quote.quoteTs??quote.timestamp);
    if(raw!=null&&raw>0){
      const ts=raw<100000000000?raw*1000:raw;
      if(ts<=8640000000000000) return ts;
    }
    const stamp=String(quote.quoteStamp||quote.quoteTime||'').replace(/\D/g,'');
    if(/^\d{14}$/.test(stamp)){
      const date=stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8);
      const hour=Number(stamp.slice(8,10)),minute=Number(stamp.slice(10,12)),second=Number(stamp.slice(12,14));
      if(validDate(date)&&hour<24&&minute<60&&second<60){
        return Date.parse(date+'T'+stamp.slice(8,10)+':'+stamp.slice(10,12)+':'+stamp.slice(12,14)+'+08:00');
      }
    }
    return null;
  }
  function quoteDate(quote){
    const ts=quoteTimestamp(quote);
    if(ts!=null) return clock(ts).date;
    const value=String(quote&&(quote.quoteDate||quote.date)||'').slice(0,10);
    return validDate(value)?value:null;
  }
  function explicitlySuspended(stock,quote){
    return !!(stock&&stock.suspended===true||quote&&quote.suspended===true||
      quote&&['suspended','halted'].includes(String(quote.tradingStatus||'').toLowerCase()));
  }
  function stockState(stock,quote,nowMs,calendar){
    const c=clock(nowMs),market=marketState(marketOf(stock),c.nowMs,calendar);
    const price=finite(quote&&quote.price),pct=finite(quote&&quote.pct),date=quoteDate(quote),stamp=quoteTimestamp(quote);
    const base={...market,status:'missing',label:'暂无行情',quoteDate:date,price,pct,
      canDisplayPrice:false,canUseReturn:false,canRecordPrice:false,displayPct:null,reason:'quote_missing'};
    // A market holiday always wins over cached price, suspension and preopen rules.
    if(market.isClosed) return {...base,status:'market_closed',label:'休市',reason:market.reason};
    if(!market.calendarKnown) return {...base,status:market.status,label:market.label,reason:market.reason};
    if(explicitlySuspended(stock,quote)) return {...base,status:'suspended',label:'停牌',reason:'explicit_suspension'};
    if(stamp!=null&&stamp>c.nowMs+5*MINUTE||date&&date>c.date){
      return {...base,status:'invalid',label:'行情待确认',reason:'future_quote'};
    }
    const aZero=market.market==='A'&&c.minute>=540&&c.minute<555;
    if(market.phase==='before_open'||market.phase==='preopen'){
      return {...base,status:'preopen',label:'未开盘',canDisplayPrice:!aZero&&price!=null&&price>0,
        canUseReturn:aZero&&price!=null&&price>0,displayPct:aZero?0:null,reason:aZero?'a_preopen_zero':'preopen'};
    }
    if(!(price>0)) return base;
    if(date!==c.date){
      return {...base,status:'stale',label:'待更新',reason:date?'previous_session_quote':'quote_date_missing'};
    }
    const volume=finite(quote&&quote.volume),amount=finite(quote&&quote.amount);
    const quoteMinute=stamp!=null?clock(stamp).minute:null;
    if(quoteMinute!=null&&quoteMinute<(market.market==='HK'?540:555)){
      return {...base,status:'stale',label:'待更新',reason:'preopen_quote'};
    }
    // Zero activity is not proof of a suspension (illiquid HK shares can have no
    // prints). Require both actual source fields, and never reinterpret auction
    // or a missing/null field as a completed zero-activity trading observation.
    const noTrade=volume===0&&amount===0&&c.minute>=570&&
      (quoteMinute==null?quote.noTradeConfirmed===true:quoteMinute>=570);
    if(noTrade) return {...base,status:'no_trade',label:'未成交',reason:'confirmed_zero_activity'};
    return {...base,status:'valid',label:'',reason:'same_session_quote',
      canDisplayPrice:true,canUseReturn:pct!=null,canRecordPrice:market.phase!=='auction',displayPct:pct};
  }
  function eligibleReturn(stock,quote,nowMs,calendar){
    const state=stockState(stock,quote,nowMs,calendar);
    return state.canUseReturn?state.displayPct:null;
  }
  function recordablePrice(stock,quote,nowMs,calendar){
    const state=stockState(stock,quote,nowMs,calendar);
    return state.canRecordPrice?state.price:null;
  }
  function weightedReturn(entries,nowMs,calendar){
    let sum=0,weight=0,count=0,totalWeight=0;
    const excluded=[];
    (entries||[]).forEach(entry=>{
      const stock=entry.stock||entry,quote=entry.quote||null,w=finite(entry.weight??stock.w);
      if(!(w>0)) return;
      totalWeight+=w;
      const state=stockState(stock,quote,nowMs,calendar);
      if(!state.canUseReturn){excluded.push({code:stock.code,market:state.market,status:state.status,weight:w});return;}
      sum+=w*state.displayPct;weight+=w;count++;
    });
    return {value:weight>0?sum/weight:null,weight,count,totalWeight,excluded};
  }
  function setCalendar(calendar){
    if(!validateCalendar(calendar)) return false;
    defaultCalendar=JSON.parse(JSON.stringify(calendar));return true;
  }
  return {VERSION:1,EMBEDDED_CALENDAR,finite,validDate,validateCalendar,clock,marketOf,marketState,quoteTimestamp,quoteDate,
    stockState,eligibleReturn,recordablePrice,weightedReturn,setCalendar};
});
