const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
test('broker estimate is inserted immediately after the mechanical annual profit estimate in both shared views',()=>{
 const row=html.slice(html.indexOf('const mkRow=(row)=>'),html.indexOf('// ── 行数据构建'));
 assert.ok(row.indexOf('${predProfitStr}')<row.indexOf('${brokerProfitStr}'));assert.ok(row.indexOf('${brokerProfitStr}')<row.indexOf('${mktCapStr}'));
 assert.match(html,/券商预测年度净利润均值/);assert.match(html,/BrokerForecasts\.cell\(sk,d\)/);assert.match(html,/assets\/broker-forecasts\.js/);
 const calc=html.slice(html.indexOf('const buildRowData=(sk,sec)=>'),html.indexOf('// ── 排序行数组'));
 assert.match(calc,/_valPrediction\(d\)/);assert.match(calc,/BrokerForecasts\.estimate\(sk,d\)/);assert.match(calc,/ValuationHK\.pe\(mktCap,brokerProfit/);assert.match(calc,/brokerEstimate\?\.currency/);assert.doesNotMatch(calc,/ValuationHK\.pe\(mktCap,predProfit/);
});

function rowFixture({forecast={profitYi:20,currency:'CNY'},mechanical=80,market='SZ',financialCurrency='CNY',fx={rates:{HKD:1,CNY:.85,USD:.125}},cap=100,financials=true}={}){
 const broker=forecast===undefined?null:{estimate:()=>forecast};
 const c=vm.createContext({window:{BrokerForecasts:broker},BrokerForecasts:broker,ValuationHK:require('../assets/valuation-hk.js'),_PORT_PRICES:{'000001':{mktCap:cap}},_VAL_DATA:financials?{'000001':{currency:financialCurrency,annualProfit:10,qtrProfit:2}}:{},_VAL_FX:fx,_valPrediction:()=>({predRate:10,predProfit:mechanical}),_valFinite:v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))?Number(v):null});
 const start=html.indexOf('const buildRowData=(sk,sec)=>'),end=html.indexOf('\n  };',start)+5;
 vm.runInContext(html.slice(start,end).replace('const buildRowData=','globalThis.buildRowData='),c);
 return c.buildRowData({code:'000001',mkt:market},{name:'test'});
}
test('prediction PE denominator is the validated broker mean, while mechanical prediction stays unchanged',()=>{
 const row=rowFixture();assert.equal(row.pe,5);assert.equal(row.predProfit,80);assert.equal(row.brokerProfit,20);
 assert.equal(rowFixture({mechanical:200}).pe,5);assert.equal(rowFixture({forecast:{profitYi:10,currency:'CNY'}}).pe,10);
});
test('missing, zero and loss forecasts never fall back to a positive mechanical prediction',()=>{
 for(const profitYi of [null,undefined,0,-10]){const r=rowFixture({forecast:{profitYi,currency:'CNY'}});assert.equal(r.pe,null);assert.equal(r.predProfit,80);}
 assert.match(html,/券商预测年度净利润均值≤0，PE不适用/);assert.match(html,/不回退机械预测/);
});
test('broker forecast may support PE without financial actuals, but currencies still must reconcile',()=>{
 assert.equal(rowFixture({financials:false}).pe,5);
 assert.equal(rowFixture({market:'HK',financialCurrency:'USD',cap:1000}).pe,43);
 assert.equal(rowFixture({market:'HK',forecast:{profitYi:20,currency:'USD'},financialCurrency:'CNY',cap:1000}).pe,6);
 assert.equal(rowFixture({market:'HK',cap:1000,fx:null}).pe,null);
});
test('retained valid broker cache is used consistently with the visible mean and is explicitly marked',()=>{
 const r=rowFixture({forecast:{profitYi:20,currency:'CNY',stale:true,status:'source_error'}});assert.equal(r.pe,5);assert.equal(r.brokerEstimate.stale,true);assert.match(html,/使用上次有效缓存/);
});
test('daily refresh is scheduled once after close and does not require a browser token',()=>{
 const w=fs.readFileSync(path.join(root,'.github/workflows/refresh-broker-forecasts.yml'),'utf8');assert.match(w,/35 14 \* \* \*/);assert.match(w,/python \.github\/scripts\/refresh_broker_forecasts.py/);assert.match(w,/git add data\/broker_profit_forecasts.json/);assert.doesNotMatch(w,/PAT|secrets\./);
 assert.match(w,/pages: write/);assert.match(w,/gh api --method POST .*pages\/builds/);
});
test('all inline scripts still parse with the added estimate column',()=>{
 for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
});
