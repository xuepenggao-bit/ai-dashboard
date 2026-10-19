const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const modelPath=process.env.MARKET_SESSION_MODEL||
  (fs.existsSync(path.join(__dirname,'../assets/market-session.js'))?path.join(__dirname,'../assets/market-session.js'):'/private/tmp/market-session-model.js');
const M=require(modelPath);
const now=(date,time='10:00:00')=>Date.parse(date+'T'+time+'+08:00');
const cal={schemaVersion:1,timezone:'Asia/Shanghai',markets:{
  A:{years:{'2026':{verified:true,sourceUrl:'https://www.sse.com.cn/test',holidays:['2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07'],halfDays:[]}}},
  HK:{years:{'2026':{verified:true,sourceUrl:'https://www.hkex.com.hk/test',holidays:[{date:'2026-10-19',name:'重阳节翌日'}],halfDays:[{date:'2026-12-24',closeMinute:730}]}}}}};
const A={mkt:'SH',code:'600000',w:60},HK={mkt:'HK',code:'00700',w:40};
const q=(date,time,pct=2,extra={})=>({price:100,pct,quoteTs:now(date,time),...extra});

test('Beijing clock does not depend on host timezone',()=>{
  assert.equal(M.clock(Date.parse('2026-10-18T16:30:00Z')).date,'2026-10-19');
  assert.equal(M.clock(Date.parse('2026-10-18T16:30:00Z')).minute,30);
});
test('market aliases and legacy code inference do not override an explicit market',()=>{
  assert.equal(M.marketOf({code:'00700'}),'HK');assert.equal(M.marketOf({code:'600000'}),'A');
  assert.equal(M.marketOf({mkt:'HKEX',code:'600000'}),'HK');assert.equal(M.marketOf({mkt:'US',code:'600000'}),null);
});
test('2026-10-19 is HK holiday but A-share trading day',()=>{
  assert.equal(M.marketState('HK',now('2026-10-19'),cal).status,'market_closed');
  assert.equal(M.marketState('A',now('2026-10-19'),cal).phase,'continuous');
});
test('A holiday does not close HK and weekend is closed even outside calendar coverage',()=>{
  assert.equal(M.marketState('A',now('2026-10-01'),cal).isClosed,true);
  assert.equal(M.marketState('HK',now('2026-10-01'),cal).isTradingDay,true);
  assert.equal(M.marketState('HK',now('2028-01-01'),cal).isClosed,true);
});
test('uncovered weekday calendar is unknown, never assumed closed or open',()=>{
  const s=M.marketState('A',now('2028-01-03'),cal);
  assert.equal(s.status,'calendar_unknown');assert.equal(s.isClosed,false);assert.equal(s.isTradingDay,false);
});
test('embedded holiday/half-day dates exactly match the published seed, allowing added verified years',()=>{
  assert.equal(M.validateCalendar(M.EMBEDDED_CALENDAR),true);
  const dataPath=process.env.MARKET_SESSION_CALENDAR||
    (fs.existsSync(path.join(__dirname,'../data/market_sessions.json'))?path.join(__dirname,'../data/market_sessions.json'):'/private/tmp/market-session-calendar.json');
  if(fs.existsSync(dataPath)){
    const seed=JSON.parse(fs.readFileSync(dataPath,'utf8'));
    assert.equal(M.validateCalendar(seed),true,'All published years must remain verified and valid');
    assert.equal(seed.schemaVersion,M.EMBEDDED_CALENDAR.schemaVersion);
    assert.equal(seed.timezone,M.EMBEDDED_CALENDAR.timezone);
    for(const market of ['A','HK']){
      for(const [year,entry]of Object.entries(M.EMBEDDED_CALENDAR.markets[market].years)){
        const live=seed.markets[market].years[year];
        const dates=rows=>rows.map(row=>typeof row==='string'?row:row.date).sort();
        const halfDays=rows=>rows.map(row=>typeof row==='string'?[row,market==='HK'?730:690]:[row.date,row.closeMinute]).sort();
        assert.equal(live.verified,true);
        assert.deepEqual(dates(live.holidays),dates(entry.holidays),'Embedded '+market+' '+year+' holidays must exactly match published dates');
        assert.deepEqual(halfDays(live.halfDays),halfDays(entry.halfDays),'Embedded '+market+' '+year+' half-days must exactly match published dates and closes');
        const liveSources=[live.sourceUrl,...(live.sourceUrls||[])];
        for(const source of [entry.sourceUrl,...(entry.sourceUrls||[])])assert.ok(liveSources.includes(source),'Published sources retain embedded official evidence');
        liveSources.forEach(source=>{
          const url=new URL(source),hosts=market==='HK'?['hkex.com.hk']:['sse.com.cn','szse.cn'];
          assert.equal(url.protocol,'https:');assert.ok(hosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host)),'Official exchange source only');
        });
      }
    }
  }
  assert.equal(M.marketState('HK',now('2026-10-19')).status,'market_closed');
});
test('unverified future years and unofficial/invalid calendar updates are rejected',()=>{
  const data=JSON.parse(JSON.stringify(cal));data.markets.A.years['2027']={verified:false,holidays:[],halfDays:[],sourceUrl:'https://www.sse.com.cn/test'};
  assert.equal(M.validateCalendar(data),false);assert.equal(M.setCalendar(data),false);
  assert.equal(M.marketState('A',now('2027-01-04'),data).status,'calendar_unknown');
  const bad=JSON.parse(JSON.stringify(cal));bad.markets.HK.years['2026'].sourceUrl='https://hkex.com.hk.example.com/not-official';
  assert.equal(M.setCalendar(bad),false);
  bad.markets.HK.years['2026'].sourceUrl='https://www.hkex.com.hk/test';bad.markets.HK.years['2026'].holidays.push('2026-02-30');
  assert.equal(M.setCalendar(bad),false);
});
test('holiday rejects yesterday and even same-day bogus cached values',()=>{
  for(const quote of [q('2026-10-16','16:00:00'),q('2026-10-19','10:00:00')]){
    const s=M.stockState(HK,quote,now('2026-10-19'),cal);
    assert.equal(s.label,'休市');assert.equal(s.canDisplayPrice,false);assert.equal(s.canUseReturn,false);assert.equal(s.canRecordPrice,false);
  }
});
test('open-day previous-date quote is stale, not suspended',()=>{
  const s=M.stockState(A,q('2026-10-16','15:00:00'),now('2026-10-19'),cal);
  assert.equal(s.status,'stale');assert.equal(s.canRecordPrice,false);assert.equal(s.canUseReturn,false);
});
test('same-date midnight reset of prior close is not a current trading quote',()=>{
  assert.equal(M.stockState(A,q('2026-10-19','00:01:00'),now('2026-10-19'),cal).reason,'preopen_quote');
  assert.equal(M.stockState(HK,q('2026-10-20','08:55:00'),now('2026-10-20'),cal).reason,'preopen_quote');
});
test('explicit suspension has no displayable or recordable stale price',()=>{
  const s=M.stockState(A,q('2026-10-16','15:00:00',3,{suspended:true}),now('2026-10-19'),cal);
  assert.equal(s.status,'suspended');assert.equal(s.label,'停牌');
  assert.equal(s.canDisplayPrice,false);assert.equal(s.canUseReturn,false);assert.equal(s.canRecordPrice,false);
});
test('transport stale flag does not blank a same-day last price at lunch or after close',()=>{
  for(const time of ['12:00:00','18:00:00']){
    const s=M.stockState(A,q('2026-10-19','11:29:00',3,{stale:true}),now('2026-10-19',time),cal);
    assert.equal(s.status,'valid');assert.equal(s.displayPct,3);assert.equal(s.canRecordPrice,true);
  }
});
test('A 9:00 to 9:15 shows preopen zero but never records previous close',()=>{
  for(const time of ['09:00:00','09:14:59']){
    const s=M.stockState(A,q('2026-10-16','15:00:00',8),now('2026-10-19',time),cal);
    assert.equal(s.status,'preopen');assert.equal(s.displayPct,0);assert.equal(s.canUseReturn,true);
    assert.equal(s.canDisplayPrice,false);assert.equal(s.canRecordPrice,false);
  }
  assert.equal(M.stockState(A,q('2026-10-16','15:00:00',8),now('2026-10-19','09:15:00'),cal).status,'stale');
});
test('A preopen zero never overrides a holiday or explicit suspension',()=>{
  assert.equal(M.stockState(A,q('2026-09-30','15:00:00'),now('2026-10-01','09:05:00'),cal).status,'market_closed');
  assert.equal(M.stockState(A,q('2026-10-16','15:00:00',2,{suspended:true}),now('2026-10-19','09:05:00'),cal).status,'suspended');
});
test('same-day HK opening auction is usable for display, not history recording before 9:30',()=>{
  const s=M.stockState(HK,q('2026-10-20','09:05:00',3,{volume:0,amount:0}),now('2026-10-20','09:05:00'),cal);
  assert.equal(s.status,'valid');assert.equal(s.canDisplayPrice,true);assert.equal(s.displayPct,3);assert.equal(s.canUseReturn,true);
  assert.equal(s.canRecordPrice,false);
});
test('confirmed zero activity is no_trade not suspension',()=>{
  const s=M.stockState(A,q('2026-10-19','10:00:00',0,{volume:0,amount:0}),now('2026-10-19'),cal);
  assert.equal(s.status,'no_trade');assert.equal(s.label,'未成交');assert.equal(s.canUseReturn,false);assert.equal(s.canRecordPrice,false);
});
test('null/missing activity and a single zero field are not invented zero activity',()=>{
  for(const extra of [{},{volume:0},{amount:0},{volume:null,amount:null},{volume:'',amount:''},{volume:0,amount:20}]){
    const s=M.stockState(A,q('2026-10-19','10:00:00',0,extra),now('2026-10-19'),cal);
    assert.equal(s.status,'valid');assert.equal(s.canUseReturn,true);
  }
});
test('auction zero activity does not become an apparent halt at 9:25',()=>{
  const s=M.stockState(A,q('2026-10-19','09:25:00',0,{volume:0,amount:0}),now('2026-10-19','09:25:00'),cal);
  assert.equal(s.status,'valid');assert.equal(s.canRecordPrice,false);
});
test('market lunch/session/half-day boundaries are independent',()=>{
  assert.equal(M.marketState('A',now('2026-10-20','11:30:00'),cal).phase,'lunch');
  assert.equal(M.marketState('HK',now('2026-10-20','11:30:00'),cal).phase,'continuous');
  assert.equal(M.marketState('HK',now('2026-10-20','12:00:00'),cal).phase,'lunch');
  assert.equal(M.marketState('HK',now('2026-12-24','12:00:00'),cal).phase,'closing_auction');
  assert.equal(M.marketState('HK',now('2026-12-24','12:10:00'),cal).phase,'after_close');
});
test('future values and invalid quote dates are never usable',()=>{
  assert.equal(M.stockState(A,q('2026-10-20','10:00:00'),now('2026-10-19'),cal).status,'invalid');
  assert.equal(M.stockState(A,{price:10,pct:2,quoteDate:'2026-02-30'},now('2026-10-19'),cal).status,'stale');
});
test('timestamp syntax is strictly parsed with UTC+8',()=>{
  assert.equal(M.quoteTimestamp({quoteStamp:'20261019103000'}),now('2026-10-19','10:30:00'));
  assert.equal(M.quoteTimestamp({quoteStamp:'20260230103000'}),null);
});
test('closed/suspended holdings do not dilute an eligible weighted return',()=>{
  const result=M.weightedReturn([{stock:A,quote:q('2026-10-19','10:00:00',4)},
    {stock:HK,quote:q('2026-10-16','16:00:00',-20)}],now('2026-10-19'),cal);
  assert.equal(result.value,4);assert.equal(result.weight,60);assert.equal(result.totalWeight,100);assert.equal(result.count,1);
  assert.equal(result.excluded[0].status,'market_closed');
});
test('all excluded produces null not 0%, and suspension does not dilute open holdings',()=>{
  const result=M.weightedReturn([{stock:A,quote:q('2026-10-19','10:00:00',0,{suspended:true})}],now('2026-10-19'),cal);
  assert.equal(result.value,null);assert.equal(result.weight,0);assert.equal(result.count,0);
});
test('record price has independent validity from availability of daily percent',()=>{
  const quote=q('2026-10-19','10:00:00',null);
  assert.equal(M.recordablePrice(A,quote,now('2026-10-19'),cal),100);
  assert.equal(M.eligibleReturn(A,quote,now('2026-10-19'),cal),null);
});
