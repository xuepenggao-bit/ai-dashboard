const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const m=require('../assets/valuation-hk.js');
const DAY=86400000,ASOF='2026-11-04',NOW=Date.parse(ASOF+'T13:00:00+08:00');
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,actual+' != '+expected);
function row(end,value,extra={}){return {SECUCODE:'00700.HK',REPORT_DATE:end,START_DATE:end.slice(0,4)+'-01-01',STD_REPORT_DATE:end,FISCAL_YEAR:'12-31',DATE_TYPE_CODE:end.endsWith('12-31')?'001':end.endsWith('06-30')?'002':'003',STD_ITEM_CODE:'004025002',ITEM_NAME:'股东应占溢利',AMOUNT:value,CURRENCY:'人民币',CURRENCY_CODE:'CNY',...extra};}
// Verified Eastmoney original-currency parent profit; numeric units here are currency yuan.
function tencent(){return [row('2024-12-31',194073e6),row('2025-03-31',47821e6),row('2025-06-30',103449e6),row('2025-09-30',166582e6),row('2025-12-31',224842e6),row('2026-03-31',58093e6),row('2026-06-30',114115e6)];}
function fxLine(pair,value,stamp='2026-11-04 12:58:00',ticker=pair){return 'v_wh'+pair+'="name,0,'+ticker+','+value+',0,'+stamp+',0";';}
test('pure HK uses original-currency ordinary parent profit and derives real single-quarter growth',()=>{
 const d=m.fromHK(tencent(),ASOF);assert.equal(d.profitBasis,'parent_net_profit');assert.equal(d.currency,'CNY');near(d.annualProfit,2248.42);near(d.annualYoY,15.854343468694765);near(d.qtrProfit,560.22);near(d.qtrYoY,.7082764075645454);near(d.qtrQoQ,-3.5649734047131343);assert.equal(d.periodMonths,3);assert.match(d.qtrPeriod,/2026-04-01—2026-06-30（单季）/);
});
test('Q1 sequential comparison uses previous Q4 from FY minus 9M',()=>{
 const d=m.fromHK(tencent().filter(r=>r.REPORT_DATE<='2026-03-31'),ASOF);near(d.qtrProfit,580.93);near(d.qtrQoQ,(58093/(224842-166582)-1)*100);near(d.qtrYoY,(58093/47821-1)*100);
});
test('semiannual-only reporter compares H1 with prior H2 and clearly labels the six-month period',()=>{
 const data=[row('2024-12-31',100),row('2025-06-30',60),row('2025-12-31',140),row('2026-06-30',120)];
 const d=m.fromHK(data,ASOF);assert.equal(d.periodMonths,6);near(d.qtrProfit,120/1e8);near(d.qtrYoY,100);near(d.qtrQoQ,50);assert.match(d.qtrPeriod,/半年/);assert.doesNotMatch(d.qtrPeriod,/Q2/);assert.match(d.basisNote,/不冒称单季度/);
});
test('semiannual full-year reporter gets H2 from FY minus H1, not the whole year as a quarter',()=>{
 const data=[row('2024-06-30',30),row('2024-12-31',100),row('2025-06-30',60),row('2025-12-31',140)];
 const d=m.fromHK(data,ASOF);assert.equal(d.periodMonths,6);near(d.qtrProfit,80/1e8);near(d.qtrYoY,(80/70-1)*100);near(d.qtrQoQ,(80/60-1)*100);assert.match(d.qtrPeriod,/2025-07-01—2025-12-31/);
});
test('March fiscal year follows actual START_DATE/REPORT_DATE, never normalized STD_REPORT_DATE',()=>{
 const data=[row('2024-09-30',768953000,{START_DATE:'2024-04-01',DATE_TYPE_CODE:'002',FISCAL_YEAR:'3-31'}),row('2025-03-31',1432427000,{START_DATE:'2024-04-01',STD_REPORT_DATE:'2024-12-31',DATE_TYPE_CODE:'001',FISCAL_YEAR:'3-31'}),row('2025-09-30',1266629000,{START_DATE:'2025-04-01',DATE_TYPE_CODE:'002',FISCAL_YEAR:'3-31'}),row('2026-03-31',1936162000,{START_DATE:'2025-04-01',STD_REPORT_DATE:'2025-12-31',DATE_TYPE_CODE:'001',FISCAL_YEAR:'3-31'})];
 const d=m.fromHK(data,ASOF);assert.equal(d.reportDate,'2026-03-31');assert.equal(d.annualPeriod,'截至2026-03-31年度');assert.equal(d.periodMonths,6);near(d.qtrProfit,6.69533);near(d.annualYoY,35.16653902781781);near(d.qtrYoY,.9132234269918715);near(d.qtrQoQ,-47.14055970611758);
});
test('income field identity and original currency are mandatory; ordinary indicators or total net income are not substitutes',()=>{
 assert.equal(m.fromHK([{...row('2026-06-30',10),STD_ITEM_CODE:'004012999'}],ASOF),null);
 const d=m.fromHK([row('2025-06-30',10,{CURRENCY_CODE:'USD',CURRENCY:'美元'}),row('2026-06-30',30,{CURRENCY_CODE:'USD',CURRENCY:'美元'})],ASOF);assert.equal(d.currency,'USD');near(d.qtrYoY,200);
});
test('a reporting-currency change cannot create mixed-currency annual or quarterly growth',()=>{
 const data=[row('2024-12-31',100),row('2025-12-31',120),row('2026-03-31',40,{CURRENCY_CODE:'USD',CURRENCY:'美元'}),row('2026-06-30',90,{CURRENCY_CODE:'USD',CURRENCY:'美元'})];
 const d=m.fromHK(data,ASOF);assert.equal(d.currency,'USD');assert.equal(d.annualProfit,null);assert.equal(d.annualYoY,null);assert.equal(d.qtrYoY,null);near(d.qtrQoQ,25);
});
test('negative or zero comparison profit is not turned into an ordinary growth forecast',()=>{
 for(const base of [0,-10]){const d=m.fromHK([row('2025-06-30',base),row('2025-12-31',base+10),row('2026-06-30',20)],ASOF);assert.equal(d.qtrYoY,null);}
});
test('missing cumulative operands do not become zeros or fall back to a stale period',()=>{
 const data=tencent();data.at(-1).AMOUNT=null;const d=m.fromHK(data,ASOF);assert.equal(d.reportDate,'2026-06-30');assert.equal(d.qtrProfit,null);assert.equal(d.qtrYoY,null);assert.equal(d.qtrQoQ,null);
 const noH1=m.fromHK([row('2025-09-30',100),row('2026-09-30',200)],ASOF);assert.equal(noH1.periodMonths,null);assert.equal(noH1.qtrProfit,null);
});
test('future, malformed, conflicting and cross-issuer financial rows cannot silently enter a calculation',()=>{
 assert.equal(m.fromHK([row('2026-12-31',10)],ASOF),null);assert.equal(m.fromHK([row('2026-06-31',10)],ASOF),null);
 assert.equal(m.fromHK([row('2026-06-30',10),row('2026-06-30',20)],ASOF),null);
 assert.equal(m.fromHK([row('2026-03-31',10),row('2026-06-30',20,{SECUCODE:'01810.HK'})],ASOF),null);
});
test('A/H copies matched A-share recurring data without mutating it, never falling back to HK ordinary profit',()=>{
 const a={annualProfit:100,annualYoY:30,qtrProfit:20,qtrYoY:40,qtrQoQ:50,currency:'CNY',profitBasis:'recurring_parent_net_profit',reportDate:'2026-09-30'},before=JSON.stringify(a),d=m.fromAH(a,'300308');
 assert.equal(d.source,'AH');assert.equal(d.aShareCode,'300308');assert.equal(d.currency,'CNY');assert.equal(d.annualProfit,100);assert.match(d.basisLabel,/A股 300308/);assert.equal(JSON.stringify(a),before);
 for(const invalid of [null,{...a,profitBasis:'parent_net_profit'},{...a,currency:'HKD'}]){const missing=m.fromAH(invalid,'300308');assert.equal(missing.annualProfit,null);assert.equal(missing.qtrYoY,null);assert.match(missing.basisNote,/不得回退/);}
 assert.throws(()=>m.fromAH(a,'3308'));
});
test('complete A/H list preserves exact A codes and markets; partial or malformed maps throw instead of misclassifying pure HK',()=>{
 const rows=[{f12:'03308',f13:116,f14:'中际旭创',f191:'300308',f192:0,f193:'中际旭创'},{f12:'00981',f13:116,f14:'中芯国际',f191:'688981',f192:1,f193:'中芯国际'}],parsed=m.parseAH(rows,2);
 assert.deepEqual(parsed['00981'],{hkCode:'00981',aCode:'688981',aMarket:'SH',hkName:'中芯国际',aName:'中芯国际'});assert.equal(parsed['03308'].aMarket,'SZ');
 for(const [data,total]of [[rows,3],[[],0],[[rows[0],rows[0]],2],[[{...rows[0],f13:1}],1],[[{...rows[0],f192:1}],1],[[{...rows[0],f191:'bad'}],1]])assert.throws(()=>m.parseAH(data,total));
});
test('published mapping snapshot can be fully validated without heuristic company-name matching',()=>{
 const file=path.join(__dirname,'../data/ah_share_map.json');if(!fs.existsSync(file))return;const d=JSON.parse(fs.readFileSync(file));const rows=d.pairs.map(r=>({f12:r.hkCode,f13:116,f14:r.hkName,f191:r.aCode,f192:r.aMarket==='SH'?1:0,f193:r.aName}));assert.equal(Object.keys(m.parseAH(rows,d.total)).length,d.total);
});
test('FX binds ticker field, converts USDHKD direction, and supports compact and formatted Beijing timestamps',()=>{
 const fx=m.parseFX(fxLine('HKDCNY',.88)+fxLine('USDHKD',7.8,'20261104125900'),NOW);assert.equal(fx.rates.HKD,1);assert.equal(fx.rates.CNY,.88);near(fx.rates.USD,1/7.8);assert.equal(fx.dateTime,'2026-11-04 12:59:00');assert.equal(fx.rateDateTimes.CNY,'2026-11-04 12:58:00');
});
test('stale, future, invalid, wrong-symbol and malformed-timestamp FX rates are omitted, never zero-filled',()=>{
 for(const text of [fxLine('HKDCNY',.88,'2026-10-27 12:00:00'),fxLine('HKDCNY',.88,'2026-11-04 13:06:00'),fxLine('HKDCNY',0),fxLine('HKDCNY','bad'),fxLine('HKDCNY',.88,'2026-11-04 12:58:00','USDHKD'),fxLine('HKDCNY',.88,'2026-02-31 12:00:00')]){const fx=m.parseFX(text,NOW);assert.deepEqual(fx.rates,{HKD:1});assert.equal(fx.dateTime,null);}
 const allowed=m.parseFX(fxLine('HKDCNY',.88,'2026-11-04 13:04:59'),NOW);assert.equal(allowed.rates.CNY,.88);
});
test('partial or duplicate FX retains only valid newest observed rates',()=>{
 const fx=m.parseFX(fxLine('HKDCNY',.88)+fxLine('HKDCNY',.87,'2026-11-03 12:00:00')+fxLine('USDHKD',7.8,'2026-10-01 12:00:00'),NOW);assert.equal(fx.rates.CNY,.88);assert.equal(fx.rates.USD,undefined);
});
test('PE converts market capitalization to the profit reporting currency and refuses missing FX or losses',()=>{
 const fx=m.parseFX(fxLine('HKDCNY',.88)+fxLine('USDHKD',7.8),NOW);assert.equal(m.pe(100,10,'HKD','CNY',fx,NOW),9);assert.equal(m.pe(100,10,'CNY','CNY',null,NOW),10);assert.equal(m.pe(100,2,'HKD','USD',fx,NOW),6);assert.equal(m.pe(100,10,'USD','CNY',fx,NOW),69);
 for(const args of [[100,10,'HKD','CNY',null],[100,10,'HKD','JPY',fx],[100,0,'HKD','CNY',fx],[100,-1,'HKD','CNY',fx],[null,10,'HKD','HKD',fx],[100,10,'HKD','CNY',{rates:{HKD:1,CNY:0}}]])assert.equal(m.pe(...args,NOW),null);
});
test('cached FX quote expiry is rechecked at PE calculation, including after browser background suspension',()=>{
 const fx=m.parseFX(fxLine('HKDCNY',.88)+fxLine('USDHKD',7.8),NOW);
 assert.equal(m.pe(100,10,'HKD','CNY',fx,NOW+8*DAY),null);assert.equal(m.pe(100,10,'USD','CNY',fx,NOW+8*DAY),null);
 assert.equal(m.pe(100,10,'HKD','CNY',fx,NOW-DAY),null);
 assert.equal(m.pe(100,10,'CNY','CNY',fx,NOW+8*DAY),10,'same-currency PE needs no FX');
});
