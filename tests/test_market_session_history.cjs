const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const sourcePath=process.env.MARKET_SESSION_HTML || (fs.existsSync(path.join(__dirname,'../index.html'))?path.join(__dirname,'../index.html'):'/private/tmp/market-session-history.js');
const source=fs.readFileSync(sourcePath,'utf8');
const names=['_histBeijingDate','_histReturnEligible','_histStatusLabel','_histCsiValue','_computePortPct','addHistRecord','fixHistCsi','recomputeHistReturns'];
function extract(name){
  const start=source.indexOf('async function '+name+'(')>=0?source.indexOf('async function '+name+'('):source.indexOf('function '+name+'(');
  assert.ok(start>=0,'Missing function '+name);
  const end=source.indexOf('\n}',start)+2;
  assert.ok(end>start,'Missing end '+name);
  return source.slice(start,end);
}
const code=names.map(extract).join('\n');
function makeContext(){
  const now=Date.parse('2026-10-19T07:15:00Z');
  class FrozenDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context={Date:FrozenDate,console,PORT:{sectors:[],history:[]},_PORT_PRICES:{},_IDX_CACHE:{},TAB_ORDER:['tPort','tHist'],alerts:[],confirmations:[],saves:0,remoteSaves:0,switches:[],fetches:0};
  context.alert=text=>context.alerts.push(text);
  context.confirm=text=>{context.confirmations.push(text);return true;};
  context.portSave=()=>context.saves++;
  context.portSaveRemote=()=>context.remoteSaves++;
  context.portLoad=()=>{};
  context.renderHistTable=()=>{};
  context.switchTab=index=>context.switches.push(index);
  context.fetchPortPrices=async()=>context.fetches++;
  context.fetchIndexPrices=async()=>context.fetches++;
  context._touchHistoryRecord=(record,stamp=now)=>{record._updatedAt=stamp;};
  context._portStockState=(stock,quote)=>{
    const status=quote && quote.testStatus || 'missing';
    const valid=status==='valid';
    return {status,canUseReturn:valid,canRecordPrice:valid};
  };
  vm.createContext(context);
  vm.runInContext(code,context);
  return context;
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('Legacy records keep prior-close-weight attribution',()=>{
  const c=makeContext();
  assert.equal(c._computePortPct([{code:'a',w:20,pct:2},{code:'b',w:80,pct:-4}],[{code:'a',w:80},{code:'b',w:20}]),0.8);
});
test('Closed and suspended stocks are absent from both weighted numerator and denominator',()=>{
  const c=makeContext();
  assert.equal(c._computePortPct([{code:'a',w:70,pct:9,status:'market_closed'},{code:'b',w:20,pct:7,status:'suspended'},{code:'c',w:10,pct:4,status:'valid',returnEligible:true}],null),4);
});
test('Explicit ineligibility takes priority over an accidentally retained percentage',()=>{
  const c=makeContext();
  assert.equal(c._computePortPct([{code:'a',w:100,pct:0,status:'valid',returnEligible:false}],null),null);
});
test('A genuine zero return remains eligible',()=>{
  const c=makeContext();
  assert.equal(c._computePortPct([{code:'a',w:100,pct:0,status:'valid',returnEligible:true}],null),0);
});
test('No eligible stock returns null instead of artificial zero',()=>{
  const c=makeContext();
  for(const status of ['market_closed','suspended','stale','no_trade','preopen','missing','calendar_unknown','invalid','unsupported_market']){
    assert.equal(c._computePortPct([{code:'a',w:100,pct:3,status}],null),null,status);
  }
});
test('Snapshot keeps holdings while removing suspended and closed prices and returns',async()=>{
  const c=makeContext();
  c.PORT.sectors=[{name:'组合',stocks:[{code:'a',mkt:'SH',name:'A',w:70},{code:'b',mkt:'HK',name:'B',w:20},{code:'c',mkt:'HK',name:'C',w:10}]}];
  const quoteTs=Date.parse('2026-10-19T07:00:00Z');
  c._PORT_PRICES={a:{price:19,pct:8,quoteTs,testStatus:'market_closed'},b:{price:13,pct:-5,quoteTs,testStatus:'suspended'},c:{price:10,pct:5,quoteTs,testStatus:'valid'}};
  c._IDX_CACHE={'中证全指':{price:100,pct:-1,quoteTs,testStatus:'valid'}};
  await c.addHistRecord();
  const record=plain(c.PORT.history[0]);
  assert.equal(record.date,'2026-10-19');
  assert.equal(record.weight,100);
  assert.equal(record.portPct,5);
  assert.equal(record.csiPct,-1);
  assert.deepEqual(record.stocks.map(s=>[s.code,s.price,s.pct,s.returnEligible]),[['a',null,null,false],['b',null,null,false],['c',10,5,true]]);
  assert.equal(record.stocks[0].quoteDate,'2026-10-19');
  assert.equal(c.saves,1);assert.equal(c.remoteSaves,1);assert.deepEqual(c.switches,[1]);
});
test('All closed markets still preserve stock positions without recording old quotes',async()=>{
  const c=makeContext();
  c.PORT.sectors=[{name:'组合',stocks:[{code:'a',mkt:'SH',name:'A',w:100}]}];
  c._PORT_PRICES={a:{price:10,pct:5,quoteTs:Date.parse('2026-10-16T07:00:00Z'),testStatus:'market_closed'}};
  c._IDX_CACHE={'中证全指':{price:100,pct:5,quoteTs:Date.parse('2026-10-16T07:00:00Z'),testStatus:'market_closed'}};
  await c.addHistRecord();
  const record=c.PORT.history[0];
  assert.equal(record.weight,100);assert.equal(record.portPct,null);assert.equal(record.csiPct,null);
  assert.equal(record.stocks[0].price,null);assert.equal(record.stocks[0].pct,null);
  assert.equal(record.stocks[0].quoteDate,'2026-10-16');
});
test('No quote can become a zero-price snapshot',async()=>{
  const c=makeContext();
  c.PORT.sectors=[{name:'组合',stocks:[{code:'a',mkt:'SH',name:'A',w:30}]}];
  await c.addHistRecord();
  assert.equal(c.PORT.history[0].stocks[0].price,null);
  assert.equal(c.PORT.history[0].stocks[0].pct,null);
  assert.equal(c.PORT.history[0].portPct,null);
});
test('Recording uses Beijing date independently of browser timezone',()=>{
  const c=makeContext();
  assert.equal(c._histBeijingDate(Date.parse('2026-10-18T17:00:00Z')),'2026-10-19');
});
test('Preopen display-only zeros cannot become historical prices, returns or benchmarks',async()=>{
  const c=makeContext();
  c.PORT.sectors=[{name:'组合',stocks:[{code:'a',mkt:'SH',name:'A',w:100}]}];
  c._PORT_PRICES={a:{price:10,pct:6,quoteTs:Date.parse('2026-10-16T07:00:00Z')}};
  c._IDX_CACHE={'中证全指':{price:100,pct:9,quoteTs:Date.parse('2026-10-16T07:00:00Z')}};
  c._portStockState=()=>({status:'preopen',canUseReturn:true,canRecordPrice:false,displayPct:0});
  await c.addHistRecord();
  const record=c.PORT.history[0];
  assert.equal(record.portPct,null);assert.equal(record.csiPct,null);
  assert.equal(record.stocks[0].price,null);assert.equal(record.stocks[0].pct,null);
});
test('Benchmark correction can update today only, never a past missing date',async()=>{
  const c=makeContext();
  c.PORT.history=[{date:'2026-10-16',csiPct:null},{date:'2026-10-19',csiPct:null}];
  c._IDX_CACHE={'中证全指':{price:100,pct:1.25,testStatus:'valid'}};
  await c.fixHistCsi();
  assert.equal(c.PORT.history[0].csiPct,null);
  assert.equal(c.PORT.history[1].csiPct,1.25);
});
test('Closed benchmark does not fill intentional holiday nulls',async()=>{
  const c=makeContext();
  c.PORT.history=[{date:'2026-10-19',csiPct:null}];
  c._IDX_CACHE={'中证全指':{price:100,pct:9,testStatus:'market_closed'}};
  await c.fixHistCsi();
  assert.equal(c.PORT.history[0].csiPct,null);assert.equal(c.saves,0);
});
test('Manual recompute clears explicitly excluded returns but keeps unflagged legacy missing records',()=>{
  const c=makeContext();
  c.PORT.history=[{date:'2026-10-16',portPct:8,stocks:[{code:'a',w:100,pct:null}]},{date:'2026-10-19',portPct:5,stocks:[{code:'a',w:100,pct:9,status:'suspended',returnEligible:false}]}];
  c.recomputeHistReturns();
  assert.equal(c.PORT.history[0].portPct,8);
  assert.equal(c.PORT.history[1].portPct,null);
});
test('History detail status labels clearly identify exclusions',()=>{
  const c=makeContext();
  assert.equal(c._histStatusLabel({status:'market_closed'}),'休市');
  assert.equal(c._histStatusLabel({status:'suspended'}),'停牌');
  assert.equal(c._histStatusLabel({status:'stale'}),'无当日行情');
});
