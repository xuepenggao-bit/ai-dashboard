const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function context(day='2026-11-04'){
 class Clock extends Date {static now(){return Date.parse(day+'T12:00:00+08:00');}}
 const c=vm.createContext({Date:Clock,URLSearchParams,ValuationHK:require('../assets/valuation-hk.js')});
 vm.runInContext(html.slice(html.indexOf('function _valFinite('),html.indexOf('async function _valFetchJson(')),c);
 vm.runInContext(html.slice(html.indexOf('function _valAUrl('),html.indexOf('async function _valFetchA(')),c);
 return c;
}
function row(date,value,extra={}){return {SECURITY_CODE:'000001',REPORT_DATE:date+' 00:00:00',NOTICE_DATE:date,UPDATE_DATE:date,CURRENCY:'CNY',KCFJCXSYJLR:value===null?null:value*1e8,PARENT_NETPROFIT:9999e8,SJLTZ:9999,SJLHZ:9999,...extra};}
function fixture(){return [row('2024-12-31',100),row('2025-03-31',20),row('2025-06-30',70),row('2025-09-30',110),row('2025-12-31',120),row('2026-03-31',40),row('2026-06-30',100),row('2026-09-30',180)];}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,a+' != '+b);
test('all three forecast inputs come from recurring profit, not ordinary parent profit fields',()=>{
 const c=context(),d=c._valFromA(fixture());assert.equal(d.annualProfit,120);near(d.annualYoY,20);assert.equal(d.qtrProfit,80);near(d.qtrYoY,100);near(d.qtrQoQ,100/3);assert.equal(d.qtrPeriod,'2026Q3');assert.equal(d.profitBasis,'recurring_parent_net_profit');
 const p=c._valPrediction(d);near(p.predRate,(20+100+100/3)/3);near(p.predProfit,120*(1+p.predRate/100));
});
test('single-quarter Q3 is cumulative 9M minus H1, not cumulative profit or cumulative YoY',()=>{
 const d=context()._valFromA(fixture());assert.notEqual(d.qtrProfit,180);assert.notEqual(d.qtrYoY,(180/110-1)*100);near(d.qtrProfit,180-100);
});
test('Q1 sequential growth uses prior year Q4 derived from FY minus 9M',()=>{
 const d=context()._valFromA(fixture().filter(r=>r.REPORT_DATE.slice(0,10)<='2026-03-31'));assert.equal(d.qtrPeriod,'2026Q1');assert.equal(d.qtrProfit,40);near(d.qtrQoQ,300);near(d.qtrYoY,100);
});
test('latest annual report yields actual Q4, not a silently retained Q3',()=>{
 const d=context('2027-04-01')._valFromA([...fixture(),row('2026-12-31',250,{NOTICE_DATE:'2027-03-31'})]);assert.equal(d.qtrPeriod,'2026Q4');near(d.qtrProfit,70);near(d.qtrQoQ,-12.5);near(d.qtrYoY,600);near(d.annualYoY,(250/120-1)*100);
});
test('missing cumulative operand stays missing and never falls back to ordinary profit',()=>{
 const f=fixture();f.find(r=>r.REPORT_DATE.startsWith('2026-06')).KCFJCXSYJLR=null;
 const c=context(),d=c._valFromA(f);assert.equal(d.qtrProfit,null);assert.equal(d.qtrYoY,null);assert.equal(d.qtrQoQ,null);assert.equal(c._valPrediction(d).predRate,null);
});
test('latest missing recurring amount does not masquerade as older quarter or reported profit',()=>{
 const c=context(),d=c._valFromA([...fixture(),row('2026-09-30',null,{UPDATE_DATE:'2026-10-30'})]);assert.equal(d.qtrPeriod,'2026Q3');assert.equal(d.qtrProfit,null);assert.equal(c._valPrediction(d).predProfit,null);
});
test('three finite growth items are required; no two-term mean or zero padding',()=>{
 const c=context();assert.equal(c._valPrediction({profitBasis:'recurring_parent_net_profit',annualProfit:10,annualYoY:10,qtrYoY:20,qtrQoQ:null}).predRate,null);assert.equal(c._valPrediction({annualProfit:10,annualYoY:10,qtrYoY:20,qtrQoQ:30}).predRate,null);
});
test('zero/negative comparison bases are not extrapolated into normal growth forecasts',()=>{
 const c=context();for(const b of [0,-10,null,undefined,'',false])assert.equal(c._valProfitGrowth(20,b),null);near(c._valProfitGrowth(-5,10),-150);assert.equal(c._valPrediction({profitBasis:'recurring_parent_net_profit',annualProfit:-10,annualYoY:10,qtrYoY:20,qtrQoQ:30}).predProfit,null);
});
test('restated comparative row wins by update date, future and wrong-currency disclosures are excluded',()=>{
 const c=context(),f=[...fixture(),row('2025-09-30',115,{UPDATE_DATE:'2026-10-30'}),row('2026-12-31',500,{NOTICE_DATE:'2027-03-31'}),row('2026-09-30',500,{UPDATE_DATE:'2026-11-01',CURRENCY:'USD'})];const d=c._valFromA(f);assert.equal(d.reportDate,'2026-09-30');near(d.qtrYoY,(80/(115-70)-1)*100);
});
test('pure HK ordinary profit is accepted as a distinct, explicitly labelled forecast basis',()=>{
 const c=context();const hk=(date,start,amount,type)=>({REPORT_DATE:date,START_DATE:start,AMOUNT:amount*1e8,DATE_TYPE_CODE:type,STD_ITEM_CODE:'004025002',CURRENCY_CODE:'CNY'});
 const d=c._valFromHK([hk('2024-12-31','2024-01-01',80,'001'),hk('2025-12-31','2025-01-01',100,'001'),hk('2025-03-31','2025-01-01',20,'003'),hk('2025-06-30','2025-01-01',50,'002'),hk('2026-03-31','2026-01-01',20,'003'),hk('2026-06-30','2026-01-01',60,'002')]);
 assert.equal(d.profitBasis,'parent_net_profit');assert.equal(d.annualProfit,100);assert.equal(d.qtrProfit,40);near(c._valPrediction(d).predRate,(25+100/3+100)/3);assert.match(d.basisLabel,/归母/);
});
test('A API requests the verified cumulative recurring field with finite recent history',()=>{
 const u=new URL(context()._valAUrl(['300308','002463']));assert.equal(u.searchParams.get('reportName'),'RPT_F10_FINANCE_MAINFINADATA');assert.match(u.searchParams.get('columns'),/KCFJCXSYJLR/);assert.doesNotMatch(u.searchParams.get('columns'),/PARENT_NETPROFIT|SJLTZ|SJLHZ/);assert.match(u.searchParams.get('filter'),/2023-01-01/);assert.equal(u.searchParams.get('sortColumns'),'REPORT_DATE');
});
test('table and formula disclose mixed user-selected profit bases and scripts parse',()=>{
 assert.match(html,/A股及A\/H采用A股扣非归母净利润/);assert.match(html,/纯港股采用常规股东应占净利润/);assert.match(html,/上年同口径利润 ×/);assert.match(html,/最近期同比/);assert.match(html,/ValuationHK\.pe/);assert.match(html,/basisBadge/);
 for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
});

function fetchContext(){
 const c=vm.createContext({Date,URLSearchParams,AbortController,setTimeout,clearTimeout,console,ValuationHK:require('../assets/valuation-hk.js'),document:{getElementById:()=>null},PORT:{sectors:[{stocks:[{mkt:'HK',code:'02476'},{mkt:'HK',code:'00700'}]}]}});
 vm.runInContext(html.slice(html.indexOf('let _VAL_DATA'),html.indexOf('function _valFmt(')),c);
 vm.runInContext('renderValTable=()=>{};_valFetchFX=async()=>({rates:{HKD:1,CNY:.85}});',c);return c;
}
test('A/H-only holdings fetch their unheld A peer, pure HK uses income source, never ordinary fallback for AH',async()=>{
 const c=fetchContext();c.rows=fixture().map(r=>({...r,SECURITY_CODE:'300476'}));
 vm.runInContext("_valLoadAHMap=async()=>({'02476':{aCode:'300476'}});_valFetchA=async codes=>{globalThis.requestedA=codes;return rows};_valFetchHK=async code=>{globalThis.requestedHK=code;return []};",c);
 await vm.runInContext('fetchValData(true)',c);const d=vm.runInContext('_VAL_DATA',c);assert.deepEqual(Array.from(c.requestedA),['300476']);assert.equal(c.requestedHK,'00700');assert.equal(d['02476'].source,'AH');assert.equal(d['02476'].aShareCode,'300476');assert.equal(d['02476'].annualProfit,120);
});
test('failed A/H mapping cannot misclassify every HK as pure HK',async()=>{
 const c=fetchContext();vm.runInContext("_valLoadAHMap=async()=>{throw Error('mapping failed')};_valFetchHK=async()=>{throw Error('must not call ordinary fallback')};",c);
 await vm.runInContext('fetchValData(true)',c);const d=vm.runInContext('_VAL_DATA',c);assert.equal(d['02476'].profitBasis,'unavailable');assert.equal(d['00700'].profitBasis,'unavailable');
});
