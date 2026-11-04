const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
test('broker estimate is inserted immediately after the mechanical annual profit estimate in both shared views',()=>{
 const row=html.slice(html.indexOf('const mkRow=(row)=>'),html.indexOf('// ── 行数据构建'));
 assert.ok(row.indexOf('${predProfitStr}')<row.indexOf('${brokerProfitStr}'));assert.ok(row.indexOf('${brokerProfitStr}')<row.indexOf('${mktCapStr}'));
 assert.match(html,/券商预测年度净利润均值/);assert.match(html,/BrokerForecasts\.cell\(sk,d\)/);assert.match(html,/assets\/broker-forecasts\.js/);
 const calc=html.slice(html.indexOf('const buildRowData=(sk,sec)=>'),html.indexOf('// ── 排序行数组'));
 assert.match(calc,/_valPrediction\(d\)/);assert.match(calc,/ValuationHK\.pe\(mktCap,predProfit/);assert.doesNotMatch(calc,/BrokerForecasts|meanProfitYi/);
});
test('daily refresh is scheduled once after close and does not require a browser token',()=>{
 const w=fs.readFileSync(path.join(root,'.github/workflows/refresh-broker-forecasts.yml'),'utf8');assert.match(w,/35 14 \* \* \*/);assert.match(w,/python \.github\/scripts\/refresh_broker_forecasts.py/);assert.match(w,/git add data\/broker_profit_forecasts.json/);assert.doesNotMatch(w,/PAT|secrets\./);
 assert.match(w,/pages: write/);assert.match(w,/gh api --method POST .*pages\/builds/);
});
test('all inline scripts still parse with the added estimate column',()=>{
 for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
});
