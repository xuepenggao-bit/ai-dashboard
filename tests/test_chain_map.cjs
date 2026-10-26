const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Freeze the review day so these fixtures remain stable through reporting deadlines.
class ReviewDate extends Date{
  constructor(...args){super(...(args.length?args:['2026-10-26T05:00:00Z']));}
  static now(){return Date.parse('2026-10-26T05:00:00Z');}
}
const sandbox={module:{exports:{}},Date:ReviewDate,Intl,console};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/chain-monitor.js'),'utf8'),sandbox);
const m=sandbox.module.exports;
function stock(code,group,overrides={}){
  return {code,group,name:'样本'+code,reportDate:'2026-06-30',disclosureDate:'2026-08-29',
    financials:{current:{revenue:130,netProfit:30,deductedProfit:28,operatingCashFlow:22},
      previous:{revenue:100,netProfit:20,deductedProfit:20,operatingCashFlow:18},
      yoy:{revenue:30,netProfit:50,deductedProfit:40},
      q1:{previous:{revenue:50},yoy:{revenue:20}},q2:{previous:{revenue:50},yoy:{revenue:40}},
      ttm:{netProfit:5e8,deductedProfit:4.5e8}},
    quote:{date:'2026-10-26',price:10,capYi:100},
    sources:[{name:'发行人正式报告',url:'https://example.com/issuer-report.pdf',date:'2026-08-29',evidence:'issuer_filing'}],
    ...overrides};
}
function group(id,stocks){return {id,name:id,codes:stocks.filter(s=>s.group===id).map(s=>s.code)};}
function input(stocks){return {groups:Array.from(new Set(stocks.map(s=>s.group)),id=>group(id,stocks)),stocks};}
function mapGroup(overrides={}){
  return {id:'sector',name:'产业环节',coverage:2,total:3,pe:40,peCount:2,profit:25,profitCount:2,
    profitable:2,marketCapYi:300,capCoverage:3,...overrides};
}
test('map accounts for every covered sector exactly once rather than silently dropping pending sectors',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/chain_monitor.json'),'utf8'));
  const groups=m.groupsOf(data),entries=m.mapEntries(groups);
  assert.equal(entries.length,data.groups.length);
  assert.equal(entries.length,10);
  assert.equal(new Set(entries.map(e=>e.group.id)).size,10);
  assert.deepEqual(Array.from(entries,e=>e.group.id).sort(),data.groups.map(g=>g.id).sort());
  for(const entry of entries){
    assert.equal(typeof entry.plottable,'boolean');
    assert.equal(entry.plottable,entry.reasons.length===0);
    if(entry.plottable){assert.ok(Number.isFinite(entry.group.pe));assert.ok(Number.isFinite(entry.group.profit));}
    else assert.ok(entry.reasons.every(reason=>typeof reason==='string'&&reason.length>0));
  }
});
test('two comparable latest-period samples can plot despite incomplete release coverage or a loss elsewhere',()=>{
  const partial=mapGroup({coverage:2,total:3});
  const losses=mapGroup({coverage:3,total:3,profitable:1,profit:-20});
  const entries=m.mapEntries([partial,losses]);
  assert.equal(entries[0].plottable,true);
  assert.equal(entries[1].plottable,true);
  assert.equal(entries[1].group.profit,-20,'negative growth is a valid coordinate, not missing evidence');
});
test('missing axes or insufficient comparable samples stay pending and never become zero coordinates',()=>{
  const groups=[mapGroup({profit:null}),mapGroup({pe:null}),mapGroup({profitCount:1}),
    mapGroup({peCount:1}),mapGroup({marketCapYi:null})];
  const before=JSON.stringify(groups),entries=m.mapEntries(groups);
  for(const entry of entries){assert.equal(entry.plottable,false);assert.ok(entry.reasons.length>0);}
  assert.equal(entries[0].group.profit,null);
  assert.equal(entries[1].group.pe,null);
  assert.equal(JSON.stringify(groups),before,'chart classification must not alter source coordinates');
});
test('each stock gets a same-report-period peer PE instead of the latest sector period',()=>{
  const a=stock('100001','chip'),b=stock('100002','chip'),
    c=stock('100003','chip',{reportDate:'2026-09-30'}),d=stock('100004','chip',{reportDate:'2026-09-30'});
  b.quote.capYi=200;c.quote.capYi=1000;d.quote.capYi=1200;
  const rows=m.groupsOf(input([a,b,c,d]))[0].stocks;
  assert.equal(rows.find(s=>s.code===a.code).analysis.peerPE,30);
  assert.equal(rows.find(s=>s.code===b.code).analysis.peerPE,30);
  assert.equal(rows.find(s=>s.code===c.code).analysis.peerPE,220);
  assert.equal(rows.find(s=>s.code===d.code).analysis.peerPE,220);
});
test('an isolated H1 company cannot borrow two Q3 peers to become a candidate',()=>{
  const h1=stock('100001','chip'),q3a=stock('100002','chip',{reportDate:'2026-09-30'}),
    q3b=stock('100003','chip',{reportDate:'2026-09-30'});
  q3a.quote.capYi=1000;q3b.quote.capYi=1200;
  const row=m.groupsOf(input([h1,q3a,q3b]))[0].stocks.find(s=>s.code===h1.code);
  assert.equal(row.analysis.peerPE,null);
  assert.notEqual(row.analysis.key,'candidate');
});
test('watchlist gives new formal quarters priority over extreme H1 revenue growth',()=>{
  const old=stock('100001','memory'),fresh=stock('100002','pcb',{reportDate:'2026-09-30',disclosureDate:'2026-10-23'});
  old.financials.yoy.revenue=99999;old.financials.current.operatingCashFlow=-10;
  fresh.financials.current.operatingCashFlow=-10;
  fresh.sources[0].date='2026-10-23';
  const rows=m.watchlistOf(input([old,fresh]),2);
  assert.equal(rows.length,2);
  assert.equal(rows[0].code,fresh.code);
  for(const s of rows){assert.ok(s.watchEvidenceDate);assert.ok(s.watchReason);}
});
test('watchlist spreads across sectors before allowing a low-base sector to fill remaining slots',()=>{
  const stocks=[];
  for(let i=0;i<4;i++){
    const s=stock('20000'+i,'memory');s.financials.yoy.revenue=10000-i;s.financials.current.operatingCashFlow=-1;stocks.push(s);
  }
  for(let i=0;i<5;i++){
    const s=stock('30000'+i,'sector-'+i);s.financials.current.operatingCashFlow=-1;stocks.push(s);
  }
  const rows=m.watchlistOf(input(stocks),6);
  assert.equal(rows.length,6);
  assert.equal(new Set(rows.map(s=>s.group)).size,6);
  assert.equal(new Set(rows.map(s=>s.code)).size,6);
  assert.equal(rows.filter(s=>s.group==='memory').length,1);
});
test('watchlist excludes stale reports, stale quotes, incomplete accounts and unverified sources',()=>{
  const valid=stock('100000','valid'),oldReport=stock('100001','old',{reportDate:'2020-06-30'}),
    oldQuote=stock('100002','oldquote'),incomplete=stock('100003','incomplete'),
    noSource=stock('100004','nosource',{sources:[]}),nonIssuer=stock('100005','nonissuer'),
    unsafe=stock('100006','unsafe'),futureSource=stock('100007','future-source'),
    futureDisclosure=stock('100008','future-disclosure',{disclosureDate:'2099-01-01'});
  oldQuote.quote.date='2020-01-01';delete incomplete.financials.current.operatingCashFlow;
  nonIssuer.sources[0].evidence='third_party';unsafe.sources[0].url='http://example.com/report';
  futureSource.sources[0].date='2099-01-01';
  const rows=m.watchlistOf(input([valid,oldReport,oldQuote,incomplete,noSource,nonIssuer,unsafe,futureSource,futureDisclosure]),20);
  assert.deepEqual(Array.from(rows,s=>s.code),[valid.code]);
});
