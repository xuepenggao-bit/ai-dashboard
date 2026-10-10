const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../assets/account-openings.js');
const copy=()=>structuredClone(m.SEED);
test('attachment seed uses personal accounts and same-month YTD comparison',()=>{
  const s=m.summarize(copy());
  assert.equal(s.currentTotal,2702.3923);
  assert.equal(s.previousTotal,2007.2841);
  assert.equal(s.month,9);
  assert.equal(s.yoy.toFixed(2),'34.63');
  assert.equal(s.previous.reduce((a,b)=>a+b,0).toFixed(4),'2733.2351');
});
test('unpublished current months are null, not zero or last value',()=>{
  const s=m.summarize(copy());
  assert.deepEqual(s.current.slice(9),[null,null,null]);
  assert.equal(s.previous.filter(v=>v!==null).length,12);
});
test('future placeholder, summaries, malformed values and negative numbers are excluded',()=>{
  const d=copy();d.records.push(
    {year:2026,month:10,personalWan:100,reportMonth:'202609'},
    {year:2026,month:11,personalWan:0,reportMonth:'202611'},
    {year:2026,month:12,personalWan:-1,reportMonth:'202612'},
    {year:2026,month:13,personalWan:2702,reportMonth:'202612'},
    {year:2026,month:10,personalWan:'invalid',reportMonth:'202610'}
  );
  assert.deepEqual(m.summarize(d).current,m.summarize(m.SEED).current);
});
test('year rollover compares correct prior year, without recycling old current year',()=>{
  const d=copy();d.displayYear=2027;
  assert.equal(m.summarize(d).currentTotal,null);
  d.records.push({year:2027,month:1,personalWan:500,reportMonth:'202701'});
  const s=m.summarize(d);
  assert.equal(s.month,1);assert.equal(s.currentTotal,500);assert.equal(s.previousTotal,490.5257);
});
test('gaps in either YTD series do not produce an incomplete misleading YoY',()=>{
  const d=copy();d.records=d.records.filter(r=>!(r.year===2025&&r.month===4));
  assert.equal(m.summarize(d).previousTotal,null);assert.equal(m.summarize(d).yoy,null);
  d.records=d.records.filter(r=>!(r.year===2026&&r.month===4));
  assert.equal(m.summarize(d).currentTotal,null);
});
test('later official report can correct a value and adds a new month',()=>{
  const d=copy();d.latestReportMonth='202610';d.lastCheckedAt='2026-11-05T08:41:00+08:00';
  d.records=d.records.filter(r=>r.year===2025);
  d.records.find(r=>r.month===8).personalWan=264.0364;
  d.records.push({year:2026,month:10,personalWan:200,reportMonth:'202610'});
  assert.equal(m.newer(d,m.SEED),true);
  const s=m.summarize(m.mergeSnapshots(d,m.SEED));
  assert.equal(s.currentTotal,2902.3923);assert.equal(s.previousTotal,2237.5061);
});
test('stale server or cached snapshot cannot regress the latest report',()=>{
  const old=copy();old.latestReportMonth='202608';old.lastCheckedAt='2026-10-10T10:00:00+08:00';
  assert.equal(m.newer(old,m.SEED),false);
  const d=copy();d.lastCheckedAt='2026-10-10T08:41:00+08:00';
  assert.equal(m.newer(m.SEED,d),false);assert.equal(m.newer(d,m.SEED),true);
  const stale={...d,records:[{year:2026,month:9,personalWan:1,reportMonth:'202608'}]};
  assert.equal(m.summarize(m.mergeSnapshots(stale,m.SEED)).current[8],189.9667);
});
test('invalid cache or empty response never replaces built-in attachment seed',()=>{
  for(const d of [null,{},[],{schemaVersion:1,displayYear:2026,records:[]}])assert.equal(m.newer(d,m.SEED),false);
  assert.equal(m.valid(m.SEED),true);
  assert.equal(m.newer(m.SEED,m.SEED),false);
});
test('failed or lower-authority snapshot cannot undo an official same-report correction',()=>{
  const old=copy();old.lastCheckedAt='2026-10-10T08:41:00+08:00';
  const august=old.records.find(r=>r.year===2025&&r.month===8);
  august.personalWan=264.0364;august.source='上交所官方月报';
  const stale=copy();stale.lastCheckedAt='2026-10-11T08:41:00+08:00';stale.check={status:'error'};
  assert.equal(m.newer(stale,old),true);
  const merged=m.mergeSnapshots(stale,old);
  assert.equal(merged.records.find(r=>r.year===2025&&r.month===8).personalWan,264.0364);
  assert.equal(merged.check.status,'error');
  stale.records.find(r=>r.year===2025&&r.month===8).source='上交所官方月报';
  assert.equal(m.mergeSnapshots(stale,old).records.find(r=>r.year===2025&&r.month===8).personalWan,264.0364);
});
