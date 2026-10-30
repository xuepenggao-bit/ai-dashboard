const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const filename=process.env.MARKET_RISK_JS||path.join(__dirname,'../assets/market-risk.js');
function fresh(extra={}){
  const sandbox={module:{exports:{}},console,Date,Map,Set,Math,Number,String,Array,JSON,parseFloat,parseInt,...extra};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),sandbox,{filename});return{api:sandbox.module.exports,sandbox};
}
function bars(count=80){let date=Date.UTC(2025,4,1);return Array.from({length:count},(_,i)=>{
  while([0,6].includes(new Date(date).getUTCDay()))date+=86400000;
  const close=100+i*.15+Math.sin(i*.8)*1.4,d=new Date(date).toISOString().slice(0,10);date+=86400000;
  return{date:d,close,high:close+1,low:close-1,volume:10000+i};
});}
function riskPayload(b,revision='2025-09-01T16:00:00+08:00'){
  const {api}=fresh();return{schemaVersion:1,index:{code:'000985',name:'中证全指'},source:'腾讯财经',methodology:'20日样本波动与60日最高价',updatedAt:revision,bars:b,
    series:b.map((r,i)=>{const calc=api.computeRisk(b.slice(0,i+1));return calc?{date:r.date,asOf:'15:00',status:'close',...calc}:null;}).filter(Boolean)};
}
function etfPayload(funds,updatedAt='2025-08-01T16:00:00+08:00'){
  return{schemaVersion:1,source:'交易所 ETF 份额',methodology:'份额变化×同期净值',updatedAt,funds};
}
function share(date,shares,delta,nav=1.25,navDate=date){
  const previous=shares-delta;
  return{date,status:'reported',shares,previousDate:'2025-06-02',deltaShares:delta,changePct:delta/previous*100,nav,navDate,estimatedFlowYuan:navDate===date&&nav!==null?delta*nav:null};
}
test('20日实际波动率严格采用20个log收益、样本标准差与252年化',()=>{
  const {api}=fresh(),b=bars(),result=api.computeRisk(b),last=b.slice(-21);
  const returns=last.slice(1).map((r,i)=>Math.log(r.close/last[i].close));
  const mean=returns.reduce((a,b)=>a+b,0)/20;
  const expected=Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/19)*Math.sqrt(252)*100;
  assert.ok(Math.abs(result.rv20-expected)<1e-10);
  assert.ok(Math.abs(result.rv20-Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/20)*Math.sqrt(252)*100)>1e-4);
});
test('回撤使用60日最高high而非最高收盘、窗口不包含第61日前高',()=>{
  const {api}=fresh(),b=bars(61);b[0].high=500;b[1].high=300;
  let r=api.computeRisk(b);assert.equal(r.peak60,300);
  let next=Date.parse(b.at(-1).date+'T00:00:00Z')+86400000;while([0,6].includes(new Date(next).getUTCDay()))next+=86400000;
  b.push({...b.at(-1),date:new Date(next).toISOString().slice(0,10)});r=api.computeRisk(b);
  assert.ok(r.peak60<150);assert.ok(Math.abs(r.drawdown60-(r.close/r.peak60-1)*100)<1e-10);
});
test('不足60日、空白数字、重复或逆序日期不计算、不造零',()=>{
  const {api}=fresh();assert.equal(api.computeRisk(bars(59)),null);
  for(const field of ['close','high','low','volume']){const b=bars();b[30][field]='';assert.equal(api.computeRisk(b),null);}
  const b=bars();b[21].date=b[20].date;assert.equal(api.computeRisk(b),null);
  assert.equal(api.computeRisk(bars().reverse()),null);
});
test('风险close先于live；较旧live时间和较旧修订不能回退',()=>{
  const {api}=fresh(),old={status:'close',asOf:'15:00',_revision:300};
  assert.equal(api.canReplace(old,{status:'live',asOf:'15:00'},400),false);
  assert.equal(api.canReplace({status:'live',asOf:'11:20',_revision:300},{status:'live',asOf:'11:10'},400),false);
  assert.equal(api.canReplace(old,{status:'close',asOf:'15:00'},200),false);
  assert.equal(api.canReplace({status:'live',asOf:'14:50',_revision:500},{status:'close',asOf:'15:00'},400),true);
});
test('风险payload有日线时校验公式，拒绝伪造计算值且不让旧快照回退',()=>{
  const {api}=fresh(),p=riskPayload(bars());assert.equal(api.acceptRisk(p,{persist:false}),true);
  const end=api.orderedRisk().at(-1),newer=JSON.parse(JSON.stringify(p));newer.updatedAt='2025-09-02T16:00:00+08:00';newer.series.at(-1).rv20+=20;
  api.acceptRisk(newer,{persist:false});assert.equal(api.orderedRisk().at(-1).rv20,end.rv20);
  const old=JSON.parse(JSON.stringify(p));old.updatedAt='2025-08-31T16:00:00+08:00';old.series.at(-1).asOf='15:00';
  api.acceptRisk(old,{persist:false});assert.equal(api.orderedRisk().at(-1)._revision,end._revision);
});
test('ETF数学采用份数和元，不把亿份或规模当份额',()=>{
  const {api}=fresh(),row=share('2025-06-03',12e8,2e8,1.25);const r=api.etfRow(row);
  assert.equal(r.changePct,20);assert.equal(r.estimatedFlowYuan/1e8,2.5);assert.equal(r.deltaShares/1e8,2);
  assert.equal(api.etfRow({...row,estimatedFlowYuan:2.5}),null);
  assert.equal(api.etfRow({...row,changePct:2}),null);
});
test('外部收盘风险不能绕过原始bars验证，截断或不存在该日日线均拒绝',()=>{
  const {api}=fresh(),p=riskPayload(bars());p.series=[p.series.at(-1)];
  const missing={...p,bars:[]};missing.series[0].rv20=999;assert.equal(api.acceptRisk(missing,{persist:false}),false);
  const clean=riskPayload(bars());clean.series=[clean.series.at(-1)];assert.equal(api.acceptRisk({...clean,bars:clean.bars.slice(0,-1)},{persist:false}),false);
  assert.equal(api.acceptRisk({...clean,bars:clean.bars.slice(-59)},{persist:false}),false);
  const invalid=JSON.parse(JSON.stringify(clean));invalid.bars[10].volume=0;assert.equal(api.acceptRisk(invalid,{persist:false}),false);
  assert.equal(api.orderedRisk().length,0);
});
test('今日15:00收盘在14:56不能提前显示；无时区修订和收盘前更新时间拒绝',()=>{
  const {api}=fresh(),today='2026-10-14',row={date:today,asOf:'15:00',status:'close',close:100,rv20:10,peak60:100,drawdown60:0};
  assert.equal(api.riskRow(row,Date.parse(today+'T14:56:00+08:00')),null);
  const p=riskPayload(bars());assert.equal(api.acceptRisk({...p,updatedAt:'2025-09-01T16:00:00'},{persist:false}),false);
  p.updatedAt=p.bars.at(-1).date+'T14:59:00+08:00';assert.equal(api.acceptRisk(p,{persist:false}),false);
});
test('外部收盘snapshot原子校验：新payload坏latest不污染旧rows或live计算基准',()=>{
  const {api}=fresh(),old=riskPayload(bars());assert.equal(api.acceptRisk(old,{persist:false}),true);
  const oldRows=JSON.stringify(api.orderedRisk()),oldBars=JSON.stringify(api.getRiskBars()),bad=JSON.parse(JSON.stringify(old));
  bad.updatedAt='2025-09-02T16:00:00+08:00';bad.bars.at(-1).close+=.05;bad.series.at(-1).rv20=999;
  assert.equal(api.acceptRisk(bad,{persist:false}),false);
  assert.equal(JSON.stringify(api.orderedRisk()),oldRows);assert.equal(JSON.stringify(api.getRiskBars()),oldBars);
  const base=old.bars.at(-1),date='2025-08-21',now=Date.parse(date+'T12:10:00+08:00');
  const q={date,asOf:'11:30',timestamp:Date.parse(date+'T11:30:00+08:00'),price:base.close+.2,previous:base.close,high:base.close+2,low:base.close-2,volume:1000};
  assert.equal(api.buildLive(api.getRiskBars(),q,base.date,now).previousClose,base.close);
});
test('ETF跨缺失披露与疑似拆份保留份额并明确标注，不当作0或净值缺失',()=>{
  const {api}=fresh(),base={date:'2025-06-05',shares:2e8,previousDate:'2025-06-03',deltaShares:null,changePct:null,nav:1.2,navDate:'2025-06-05',estimatedFlowYuan:null,status:'reported',metricStatus:'nonconsecutive'};
  assert.equal(api.etfRow(base).shares,2e8);assert.match(api.metricNote(base),/不连续/);
  assert.match(api.metricNote({...base,metricStatus:'split_review'}),/跳变/);
  assert.equal(api.etfRow({...base,metricStatus:'daily_change'}),null);
});
test('ETF未同步净值及完全无净值保留份额，但估算缺失不是0',()=>{
  const {api}=fresh();const stale=share('2025-06-03',12e8,2e8,1.25,'2025-06-02');
  assert.equal(api.etfRow(stale).estimatedFlowYuan,null);
  assert.equal(api.etfRow({...stale,estimatedFlowYuan:0}),null);
  const absent=share('2025-06-03',12e8,2e8,null,null);assert.equal(api.etfRow(absent).estimatedFlowYuan,null);
  const unknown={date:'2025-06-03',shares:12e8,status:'reported',previousDate:null,deltaShares:null,changePct:null,nav:null,navDate:null,estimatedFlowYuan:null};
  assert.equal(api.etfRow(unknown).deltaShares,null);assert.equal(api.etfRow({...unknown,deltaShares:undefined}),null);
  assert.equal(api.signed(undefined),'—');assert.equal(api.signed(null),'—');assert.equal(api.signed(0),'0.00');
});
test('ETF有效0和负净变化保留；非法日期、前日或字符串份额拒绝',()=>{
  const {api}=fresh();const zero=share('2025-06-03',1e8,0);assert.equal(api.etfRow(zero).estimatedFlowYuan,0);
  const out=share('2025-06-03',9e8,-1e8);assert.equal(api.etfRow(out).changePct,-10);
  assert.equal(api.etfRow({...out,shares:'900000000'}),null);
  assert.equal(api.etfRow({...out,previousDate:'2025-06-03'}),null);
  assert.equal(api.etfRow({...out,date:'2025-02-30'}),null);
});
test('ETF分基金合并，partial更新不会清空其它基金；旧来源不覆盖新日',()=>{
  const {api}=fresh();const fund=code=>({code,series:[share('2025-06-03',12e8,2e8)]});
  assert.equal(api.acceptEtf(etfPayload([fund('510300'),fund('510500'),fund('512100')]),{persist:false}),true);
  const next={...share('2025-06-04',13e8,1e8),previousDate:'2025-06-03'};
  assert.equal(api.acceptEtf(etfPayload([{code:'510300',series:[next]}],'2025-08-02T16:00:00+08:00'),{persist:false}),true);
  assert.equal(api.orderedEtf('510300').at(-1).date,'2025-06-04');assert.equal(api.orderedEtf('510500').at(-1).date,'2025-06-03');assert.equal(api.orderedEtf('512100').length,1);
  api.acceptEtf(etfPayload([fund('510300')],'2025-07-30T16:00:00+08:00'),{persist:false});assert.equal(api.orderedEtf('510300').at(-1).date,'2025-06-04');
});
test('ETF检测已知上一披露日份额不符，不掩盖数据口径冲突',()=>{
  const {api}=fresh();const first=share('2025-06-03',12e8,2e8),next={...share('2025-06-04',15e8,1e8),previousDate:'2025-06-03'};
  api.acceptEtf(etfPayload([{code:'510300',series:[first,next]}]),{persist:false});assert.equal(api.orderedEtf('510300').length,1);
});
test('单指数实时计算要求已验证上一交易日、日期、成交与前收盘一致，午盘可保留11:30报价',()=>{
  const {api}=fresh(),b=bars(80),last=b.at(-1),today='2025-08-21',now=Date.parse(today+'T12:10:00+08:00');
  const q={date:today,asOf:'11:30',timestamp:Date.parse(today+'T11:30:00+08:00'),price:last.close+.2,previous:last.close,volume:500000,high:last.close+2,low:last.close-2};
  assert.equal(api.buildLive(b,q,last.date,now).asOf,'11:30');
  assert.equal(api.buildLive(b,q,'2025-07-18',now),null);
  assert.equal(api.buildLive(b,{...q,date:'2025-07-19'},last.date,now),null);
  assert.equal(api.buildLive(b,{...q,previous:1},last.date,now),null);
  assert.equal(api.buildLive(b,{...q,volume:0},last.date,now),null);
  assert.equal(api.buildLive(b,{...q,asOf:'09:15'},last.date,now),null);
});
test('腾讯指数quote解析不将坏时间和缺失字段构造为有效行情',()=>{
  const {api}=fresh(),f=Array(40).fill('');f[2]='000985';f[3]='4100';f[4]='4090';f[6]='20000';f[30]='20251014113000';f[33]='4120';f[34]='4080';
  const q=api.parseQuote('v_sh000985="'+f.join('~')+'";');assert.equal(q.date,'2025-10-14');assert.equal(q.asOf,'11:30');assert.equal(q.high,4120);
  f[30]='20251014';assert.equal(api.parseQuote('v_sh000985="'+f.join('~')+'";'),null);
});
test('one-minute risk quotes refresh independently of the five-minute history throttle without duplicate requests',async()=>{
  const b=bars(80),base=b.at(-1),today='2025-08-21',state={now:Date.parse(today+'T10:00:00+08:00'),quotes:0,history:0,calendar:0};
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
  const p=riskPayload(b,base.date+'T18:00:00+08:00');
  const {api,sandbox}=fresh({Date:FakeDate,document:{hidden:false,readyState:'loading',addEventListener(){},getElementById:id=>id==='t0'?{classList:{contains:()=>true}}:null},
    localStorage:{getItem(){return null;},setItem(){}},setTimeout,clearTimeout,
    _hl52Daily:async()=>{state.calendar++;return b.slice(-10).map(r=>[r.date,r.close,r.close,r.high,r.low,r.volume]);},
    _idxFetch:async url=>{
      if(url.includes('market_risk')){state.history++;return p;}
      if(!url.includes('qt.gtimg'))throw Error('unexpected URL');state.quotes++;await Promise.resolve();
      const f=Array(40).fill(''),stamp=new Date(state.now+8*3600000).toISOString().replace(/[-:T]/g,'').slice(0,14);
      Object.assign(f,{2:'000985',3:String(base.close+.2),4:String(base.close),6:'1000',30:stamp,33:String(base.close+2),34:String(base.close-2)});
      return 'v_sh000985="'+f.join('~')+'";';
    }});
  await api.refreshRisk(true);assert.equal(state.history,2);assert.equal(state.quotes,1);assert.equal(api.orderedRisk().at(-1).status,'live');
  state.now+=59000;await api.refreshRisk(false);assert.equal(state.quotes,1,'A short wakeup does not add quote requests');
  state.now+=6000;await Promise.all([api.refreshRisk(false),api.refreshLive(false),api.refreshLive(false)]);
  assert.equal(state.history,2,'The historical snapshot is still cached for five minutes');assert.equal(state.quotes,2);assert.equal(state.calendar,2);
  assert.equal(api.orderedRisk().at(-1).asOf,'10:01');
  sandbox.document.hidden=true;state.now+=65000;await api.refreshLive(false);assert.equal(state.quotes,2,'Background pages do not poll');
});
test('risk calendar request failure falls back only to verified exchange dates including holidays',async()=>{
  const calendar=require('../assets/market-session.js'),{api}=fresh({PortfolioMarketSession:calendar,_hl52Daily:async()=>{throw Error('calendar CORS');}});
  assert.equal(await api.previousTradingDate('2026-10-08'),'2026-09-30');
  assert.equal(await api.previousTradingDate('2026-10-30'),'2026-10-29');
  await assert.rejects(api.previousTradingDate('2027-01-04'),/官方交易日历/,'A missing official year never becomes a weekday guess');
  const unknown=fresh({PortfolioMarketSession:{marketState:()=>({calendarKnown:false})},_hl52Daily:async()=>{throw Error('calendar CORS');}}).api;
  await assert.rejects(unknown.previousTradingDate('2026-10-30'),/官方交易日历/);
});
test('图表激活后双帧resize，后台不发请求，资产无危险innerHTML外部字符串',()=>{
  const code=fs.readFileSync(filename,'utf8');
  assert.match(code,/requestAnimationFrame\(\(\)=>requestAnimationFrame/);assert.match(code,/if\(!active\(\)\)return;restore/);
  assert.match(code,/Date\.now\(\)-riskAttempt<300000/);assert.match(code,/now-etfAttempt<\(closeWindow\?60000:1800000\)/);
  assert.match(code,/r\?\.deltaShares==null\?null:r\.deltaShares\/1e8/);assert.match(code,/c\?\.resize\(\)/);
});
test('缓存盘中点保存原始报价输入，恢复后复算；篡改RV或原始最高价不得恢复',()=>{
  let day=Date.parse(new Date(Date.now()+8*3600000).toISOString().slice(0,10)+'T00:00:00Z')-86400000,dates=[];
  while(dates.length<80){if(![0,6].includes(new Date(day).getUTCDay()))dates.unshift(new Date(day).toISOString().slice(0,10));day-=86400000;}
  const b=bars(80).map((r,i)=>({...r,date:dates[i]})),base=b.at(-1),today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),stamp=Date.parse(today+'T10:00:00+08:00');
  if(stamp>Date.now()||[0,6].includes(new Date(today+'T00:00:00Z').getUTCDay()))return;
  let stored=null;const {api}=fresh({localStorage:{setItem(k,v){if(k.includes('marketRisk'))stored=v;},getItem(){return null;}}});
  const p=riskPayload(b,base.date+'T16:00:00+08:00');assert.equal(api.acceptRisk(p),true);
  const q={date:today,asOf:'10:00',timestamp:stamp,price:base.close+.2,previous:base.close,high:base.close+2,low:base.close-2,volume:10000};
  const row=api.buildLive(b,q,base.date);assert.ok(row);
  const live={schemaVersion:1,index:{code:'000985'},source:'腾讯财经',methodology:'20日/60日风险',updatedAt:new Date().toISOString(),bars:[],series:[row]};
  assert.equal(api.acceptRisk(live,{live:true}),true);const cached=JSON.parse(stored);
  assert.equal(cached.series.at(-1).liveHigh,q.high);
  const restored=fresh().api;assert.equal(restored.acceptRisk(cached,{persist:false,fromCache:true}),true);assert.equal(restored.orderedRisk().at(-1).status,'live');
  const tampered=JSON.parse(stored);tampered.series.at(-1).rv20=999;
  const rejected=fresh().api;rejected.acceptRisk(tampered,{persist:false,fromCache:true});assert.equal(rejected.orderedRisk().at(-1).status,'close');
});
test('切页激活真正resize三张图，隐藏tab不读取数据，60日数据初次可完整绘制',async()=>{
  const instances=[],frames=[],observers=[],elements=new Map(),p=riskPayload(bars());let isActive=false,requests=0;
  class FakeChart{constructor(ctx,config){this.data=config.data;this.options=config.options;this.resizes=0;instances.push(this);}update(){}resize(){this.resizes++;}}
  const element=id=>{if(!elements.has(id))elements.set(id,{id,textContent:'',innerHTML:'',getContext(){return{id};},classList:{contains(){return isActive;}}});return elements.get(id);};
  const document={hidden:false,readyState:'complete',getElementById:element,addEventListener(){}};
  const {api}=fresh({document,Chart:FakeChart,requestAnimationFrame(fn){frames.push(fn);},MutationObserver:class{constructor(fn){observers.push(fn);}observe(){}},
    localStorage:{getItem(){return null;},setItem(){}},setInterval(){},addEventListener(){},_idxFetch:async url=>{requests++;return url.includes('market_risk')?p:etfPayload([{code:'510300',series:[share('2025-06-03',12e8,2e8)]}]);}});
  assert.equal(requests,0);assert.equal(instances.length,3);api.acceptRisk(p,{persist:false});
  assert.ok(instances[0].data.labels.length>0);isActive=true;observers[0]();
  while(frames.length)frames.shift()();await Promise.resolve();await Promise.resolve();
  assert.ok(instances.every(c=>c.resizes===1));assert.equal(requests,4);
  isActive=false;observers[0]();assert.equal(requests,4);
});
