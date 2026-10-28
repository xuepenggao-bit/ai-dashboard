const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('function _macroRefreshCaption('),html.indexOf('window.addEventListener(\'highlow52-live-state\''));
function view(state,stamp='2026-10-28T10:30:00+08:00'){
 const now=Date.parse(stamp),element={textContent:'',title:''},report={ok:true,failed:[],completedAt:now};
 const context={Date,document:{getElementById:()=>element},window:{highLow52LiveState:()=>state},_beijingMarketClock:()=>{const d=new Date(now+8*3600000);return{day:d.getUTCDay(),minutes:d.getUTCHours()*60+d.getUTCMinutes()};}};
 vm.createContext(context);vm.runInContext(source,context);context._macroRefreshCaption(report,now);return{element,report,context,now};
}
test('a successful historical read does not claim that blocked live data is current',()=>{
 const {element,report}=view({date:'2026-10-28',status:'blocked',message:'基准截至10月26日，需10月27日'});
 assert.equal(report.ok,true,'Keep the established snapshot-completion contract');assert.equal(report.realtimePending,true);
 assert.match(element.textContent,/52周今日统计待更新/);assert.doesNotMatch(element.textContent,/全部指标已核验/);assert.match(element.title,/需10月27日/);
});
test('loading becomes ready without turning an old summary into a fresh-data claim',()=>{
 const state={date:'2026-10-28',status:'loading',message:'正在统计'},v=view(state);assert.equal(v.report.realtimePending,true);
 state.status='ready';v.context._macroRefreshCaption(v.report,v.now);assert.equal(v.report.realtimePending,false);assert.match(v.element.textContent,/盘中数据以图内时间为准/);
});
test('preopen and historical-day states do not create a false live failure',()=>{
 assert.equal(view({date:'2026-10-28',status:'idle'},'2026-10-28T08:00:00+08:00').report.realtimePending,false);
 assert.equal(view({date:'2026-10-27',status:'blocked'}).report.realtimePending,false);
});
