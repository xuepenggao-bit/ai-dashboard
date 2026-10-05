const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/high-low-52w-live.js'),'utf8');
const now=Date.parse('2026-10-09T10:15:00+08:00');
const stocks=Array.from({length:4000},(_,i)=>({code:'sh'+String(600000+i),firstDate:'2024-01-01',
  lastDate:'2026-09-30',close:7,highs:[['2026-09-30',10]],lows:[['2026-09-30',5]]}));
const baseline={schemaVersion:1,asOfDate:'2026-09-30',validThrough:'2026-10-21',updatedAt:'2026-09-30T08:00:00Z',stocks};
function quote(code,change={}){
  const f=Array(90).fill('');
  Object.assign(f,{3:'8',4:'7',6:'10',30:'20261009101400',33:'10',34:'6'},change);
  return 'v_'+code+'="'+f.join('~')+'";';
}
function context(config={}){
  let captured=[],requests=0,active=0,maxActive=0;
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const ctx=vm.createContext({Date:FakeDate,Map,Set,Promise,Number,Math,Error,setTimeout,clearTimeout,setInterval:()=>0,
    console:{warn(){}},document:{hidden:false,addEventListener(){},getElementById:()=>({classList:{contains:()=>true}})},window:{addEventListener(){}},
    _highLow52Clock:()=>({date:'2026-10-09',minute:615}),
    _setHighLow52LivePoint:r=>{captured.push(r);return true;},
    _idxFetch:async url=>{
      requests++;active++;maxActive=Math.max(maxActive,active);
      await Promise.resolve();active--;
      if(url.includes('baseline.json'))return config.baseline||baseline;
      if(url.includes('fqkline')){
        const code=/param=([^,]+)/.exec(url)[1];
        const rows=code==='sh000001'?[['2026-09-30'],['2026-10-09']]:[
          ['2024-01-01','7','7','10','5','1'],['2026-09-30','6',config.badAdjustment?'6.5':'6','9','4','1'],['2026-10-09','6','7','8','4','1']];
        return{code:0,data:{[code]:{qfqday:rows}}};
      }
      if(url.includes('qt.gtimg')){
        const codes=/q=([^&]+)/.exec(url)[1].split(',');
        return codes.map(code=>{
          if(config.missing&&code==='sh600000')return '';
          const index=code==='sh000001'||code==='sz399106';
          if(config.holiday&&index)return quote(code,{30:'20260930150000'});
          if(config.stale&&code==='sh600000')return quote(code,{30:'20260930150000'});
          if(config.suspend&&code==='sh600000')return quote(code,{6:'0',33:'0',34:'0'});
          if(config.adjust&&code==='sh600000')return quote(code,{4:'6',33:'8',34:'4'});
          return quote(code);
        }).join('\n');
      }
      throw Error('Unexpected URL '+url);
    },
  });
  vm.runInContext(source,ctx);
  return{ctx,captured,requests:()=>requests,maxActive:()=>maxActive};
}
module.exports=(async()=>{
  const c=context();
  assert.equal(c.ctx._hl52ValidBaseline(baseline),true);
  assert.equal(c.ctx._hl52ValidBaseline({...baseline,stocks:[...stocks,stocks[0]]}),false,'Duplicate stock must fail');
  assert.throws(()=>c.ctx._hl52Quotes(quote('sh600000'),['sh600000','sh600001']),/完整/);
  assert.throws(()=>c.ctx._hl52Quotes(quote('sh600000',{33:''}),['sh600000']),/完整/);
  const expired={highs:[['2025-10-09',100],['2026-09-30',10]],lows:[['2025-10-09',1],['2026-09-30',5]]};
  assert.deepEqual(JSON.parse(JSON.stringify(c.ctx._hl52Thresholds(expired,'2026-10-09'))),{high:10,low:5},'Exactly 364 calendar days, not one calendar year');
  await Promise.all([c.ctx.refreshHighLow52Live(true),c.ctx.refreshHighLow52Live(true)]);
  assert.equal(c.captured.length,1,'Only publish a complete full-market observation');
  assert.equal(c.captured[0].high,4000);assert.equal(c.captured[0].low,0);
  assert.equal(c.captured[0].eligible,4000);assert.equal(c.captured[0].asOf,'10:14');
  assert.ok(c.maxActive()<=4,'Bound parallel network work');
  const count=c.requests();await c.ctx.refreshHighLow52Live();assert.equal(c.requests(),count,'Five-minute throttle');
  for(const config of [{missing:true},{stale:true},{holiday:true},{baseline:{...baseline,asOfDate:'2026-09-29'}},
    {baseline:{...baseline,validThrough:'2026-10-08'}},{adjust:true,badAdjustment:true}]){
    const t=context(config);await t.ctx.refreshHighLow52Live(true);assert.equal(t.captured.length,0,JSON.stringify(config).slice(0,100));
  }
  const suspend=context({suspend:true});await suspend.ctx.refreshHighLow52Live(true);
  assert.equal(suspend.captured[0].high,3999,'Explicitly suspended stock contributes neither extreme');
  const adjusted=context({adjust:true});await adjusted.ctx.refreshHighLow52Live(true);
  assert.equal(adjusted.captured[0].high,3999);assert.equal(adjusted.captured[0].low,1,'Refresh ex-dividend basis before comparison');
  const ipo=context({baseline:{...baseline,stocks:[...stocks,{...stocks[0],code:'sz301999',firstDate:'2026-09-01'}]}});
  await ipo.ctx.refreshHighLow52Live(true);
  assert.equal(ipo.captured[0].eligible,4000);assert.equal(ipo.captured[0].universe,4001,'Recent IPOs excluded from numerator');
  const hidden=context();hidden.ctx.document.hidden=true;await hidden.ctx.refreshHighLow52Live(true);
  assert.equal(hidden.requests(),0,'Hidden tab makes no requests');
  return 'PASS: complete-market live scans, 364-day expiry, missing/stale/holiday rejection, ex-dividend correction, IPO/suspension rules, bounded concurrency and throttling';
})();
