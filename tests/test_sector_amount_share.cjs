const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('var _sectorShareLastGood='),html.indexOf('function _updateAllSectorAmountShares()'));
const elements={};
const context=vm.createContext({Map,Number,console,
  _marketTurnoverSnapshot:{yi:100,date:'2026-09-15',tod:'10:00'},
  _turnoverCmpCache:{data:null},
  document:{getElementById:id=>elements[id]||(elements[id]={textContent:'',classList:{add(){},remove(){}}})}
});
vm.runInContext(source,context);
const data={todayDate:'2026-09-15',tod:'10:01',todayCum:12e8,labels:['10:00','10:01'],todayAmount:[10e8,12e8]};
assert.equal(context._sectorAmountShare(data),10,'A newer sector minute must align backwards, not disappear');
context._turnoverCmpCache.data={todayDate:'2026-09-15',labels:['10:00','10:01'],todayAmountYi:[100,120]};
assert.equal(context._sectorAmountShareSnapshot(data).tod,'10:01','Use newest shared minute');
for(const code of ['BK1136','BK0877','BK1137']){
  context._updateSectorAmountShare({code},data);
  assert.equal(elements['sectorAmountShareValue-'+code].textContent,'10.00%');
}
context._marketTurnoverSnapshot={yi:0,date:'',tod:''};
assert.equal(context._sectorAmountShare(data),10,'Persisted minute series can supply missing realtime denominator');
context._turnoverCmpCache.data=null;
context._updateSectorAmountShare({code:'BK1136'},data);
assert.equal(elements['sectorAmountShareValue-BK1136'].textContent,'10.00%','Temporary outage retains last good same-day share');
assert.ok(elements['sectorAmountShareNote-BK1136'].textContent.includes('最近有效'));
context._updateSectorAmountShare({code:'BK1136'},{...data,todayDate:'2026-09-16'});
assert.equal(elements['sectorAmountShareValue-BK1136'].textContent,'—','Never carry yesterday ratio into a new day');
context._marketTurnoverSnapshot={yi:100,date:'2026-09-14',tod:'10:01'};
assert.equal(context._sectorAmountShare(data),null,'Never divide data from different dates');
context._marketTurnoverSnapshot={yi:120,date:'2026-09-15',tod:'10:02'};
assert.equal(context._sectorAmountShare(data),10,'Small time difference gets labelled near-time fallback');
assert.equal(context._sectorAmountShareSnapshot(data).aligned,false);
context._marketTurnoverSnapshot.tod='10:30';
assert.equal(context._sectorAmountShare(data),null,'Do not mix materially different intraday times');
context._marketTurnoverSnapshot={yi:200,date:'2026-09-15',tod:'16:00'};
assert.equal(context._sectorAmountShare({...data,tod:'15:00',todayCum:20e8,labels:['15:00'],todayAmount:[20e8]}),10,'After-close requests align to 15:00');
context._marketTurnoverSnapshot={yi:100,date:'2026-09-15',tod:'10:00'};
context._updateSectorAmountShare({code:'BK0877'},data);
assert.equal(elements['sectorAmountShareValue-BK0877'].textContent,'10.00%','Older response cannot regress latest saved ratio');
console.log('PASS: all three sectors, async minute alignment, cached denominator, outage retention, day isolation and close-time alignment');
