const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../assets/valuation-table.css'),'utf8');
const source=html.slice(html.indexOf('function _valFmt('),html.indexOf('// ── TAB ─'));
const period='2026-01-01—2026-06-30（半年）',annual='截至2025-12-31年度';
function fixture(view='sector',extra={}){
  const elements={};const getElementById=id=>elements[id]||(elements[id]={innerHTML:'',textContent:''});
  const BrokerForecasts={getData:()=>({}),estimate:()=>({profitYi:20,currency:'CNY'}),cell:()=>'<div class="bf-cell" style="min-width:154px;max-width:300px"><strong>20.00</strong><details class="bf-reports"><summary>预测明细 · 5家</summary><div>测试来源明细</div></details></div>'};
  const c=vm.createContext({window:{BrokerForecasts},BrokerForecasts,document:{getElementById},ValuationHK:require('../assets/valuation-hk.js'),
    PORT:{sectors:[{name:'科技组合',color:'#2563eb',stocks:[{name:'测试科技',code:'00700',mkt:'HK',industry:'科技',w:5}]}]},
    _PORT_PRICES:{'00700':{price:100.5,pct:1.5,mktCap:1000}},_VAL_DATA:{'00700':{annualProfit:100,annualPeriod:annual,annualYoY:10,qtrProfit:45.67,qtrPeriod:period,qtrYoY:20,qtrQoQ:30,currency:'CNY',profitBasis:'parent_net_profit',basisLabel:'归母净利 · 港股',basisNote:'按半年比较，不冒称单季度',...extra}},
    _VAL_STATUS:{loading:false},_VAL_TS:0,_VAL_SEC_SORT:{},_VAL_IND_SORT:{},_VAL_VIEW:view,_VAL_FX:{rates:{HKD:1,CNY:.85}},
    _valFinite:v=>v==null?null:Number(v),_valPrediction:()=>({predRate:20,predProfit:120})});
  vm.runInContext(source,c);c.renderValTable();return{output:elements['val-table-inner'].innerHTML,c};
}
const strip=h=>h.replace(/<[^>]*>/g,'').replace(/&[^;]+;/g,' ');
test('recent reporting range is retained as an escaped tooltip, not a visible line in either view',()=>{
  for(const view of ['sector','industry']){
    const {output}=fixture(view),cell=output.match(/<td class="val-recent-profit"([^>]*)>([\s\S]*?)<\/td>/);
    assert.ok(cell);assert.match(cell[1],new RegExp('title="'+period+'"'));
    assert.equal(strip(cell[2]),'45.67');assert.doesNotMatch(cell[2],/<br>|半年|2026-01-01/);
    const allText=strip(output);assert.doesNotMatch(allText,/2026-01-01|2026-06-30|截至2025-12-31年度/);
    assert.match(output,/title="按半年比较，不冒称单季度"/);
  }
});
test('annual profit keeps a short fiscal year and full report date only in the title',()=>{
  const {output}=fixture(),cell=output.match(/<td class="val-annual-profit"([^>]*)>([\s\S]*?)<\/td>/);
  assert.ok(cell);assert.match(cell[1],new RegExp('title="'+annual+'"'));assert.match(strip(cell[2]),/2025$/);
  assert.doesNotMatch(strip(cell[2]),/截至|12-31|年度/);
});
test('period titles, stock names and currency badges cannot inject markup',()=>{
  const {output}=fixture('sector',{qtrPeriod:'"<img src=x onerror=bad>',annualPeriod:'2025" onclick="bad',currency:'CNY<img>'});
  assert.match(output,/title="&quot;&lt;img src=x onerror=bad&gt;"/);
  assert.match(output,/CNY&lt;img&gt;/);assert.doesNotMatch(output,/<img|onclick="bad/);
});
test('the shared table keeps all thirteen fields and fixed column weights totaling one hundred',()=>{
  for(const view of ['sector','industry']){
    const {output}=fixture(view),headers=output.match(/<thead>([\s\S]*?)<\/thead>/)[1],weights=[...output.matchAll(/<col style="width:(\d+)%">/g)].map(m=>+m[1]);
    assert.equal((headers.match(/<th\b/g)||[]).length,13);assert.equal(weights.length,13);assert.equal(weights.reduce((a,b)=>a+b,0),100);
    assert.ok(weights[10]>=12,'broker forecast retains readable width');
    assert.ok(output.indexOf('年度利润预测')<output.indexOf('券商预测年度净利润均值'));
    assert.ok(output.indexOf('券商预测年度净利润均值')<output.indexOf('总市值'));
    assert.match(output,/<details class="bf-reports">/);assert.match(output,/预测明细 · 5家/);
    assert.match(output,/class="val-data-table"/);assert.doesNotMatch(output,/overflow-x:auto/);
  }
});
test('layout overrides legacy widths without cropping evidence or shrinking all data to tiny fonts',()=>{
  assert.match(html,/assets\/valuation-table\.css\?v=20261105a/);
  assert.match(css,/table-layout:fixed/);assert.match(css,/white-space:normal!important/);
  assert.match(css,/\.bf-cell\{[^}]*min-width:0!important;max-width:100%!important/);
  assert.match(css,/\.val-data-table td\{font-size:13px/);
  assert.match(css,/\.bf-reports li a\{[^}]*white-space:normal!important;overflow:visible!important/);
  assert.doesNotMatch(css,/overflow-x:hidden|text-overflow:ellipsis|transform:scale|zoom:/);
});
test('rendering changes preserve forecast PE arithmetic and parse all inline scripts',()=>{
  const {output}=fixture();assert.match(strip(output),/43x/);
  assert.match(html,/ValuationHK\.pe\(mktCap,brokerProfit/);
  assert.doesNotMatch(html,/\$\{qtrPeriodStr\}/);
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc=/.test(m[1])&&m[2].trim())new vm.Script(m[2]);
});
