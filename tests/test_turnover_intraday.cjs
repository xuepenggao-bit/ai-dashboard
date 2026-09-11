const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('var _turnoverCmpCache ='), html.indexOf('// ── 细分板块（东方财富：'));
const current = '2026-09-11';
const previous = '2026-09-10';
const minuteRows = (date, amounts) => ['09:30', '09:31', '15:00'].map((time, i) => date+' '+time+','+amounts[i]);
const storage = new Map();
let calls = 0;
let failAll = false;
const context = vm.createContext({
  console: {warn() {}}, Date, Map, Set, AbortController, setTimeout, clearTimeout, TextDecoder,
  localStorage: {getItem: key => storage.get(key), setItem: (key,value) => storage.set(key,value)},
  _breadthBeijingClock: () => ({date: current, isTrading: true, minute: 600}),
  _idxFetch: async url => {
    calls++;
    if(failAll || url.includes('push2his.')) throw new Error('simulated source outage');
    const amounts = url.includes('1.000001') ? [1e8,2e8,3e8] : [2e8,3e8,4e8];
    return {data:{trends:minuteRows(current,amounts)}};
  },
});
vm.runInContext(source, context);
context._turnoverFetchMinutes=context._idxFetch;
module.exports = (async () => {
  const first = await context._turnoverCompare();
  assert.equal(first.todayCumYi, 15, 'Both exchanges must be summed in yuan then converted');
  assert.equal(first.yestDate, '', 'Missing previous day must not fabricate yesterday');
  assert.ok(context._turnoverAmountChartSvg(first).includes('mktTurnoverChart'), 'Today-only curve must render');
  const firstCalls = calls;
  await context._turnoverCompare();
  assert.equal(calls, firstCalls, 'Repeated refresh must respect three-minute throttle');

  context._turnoverMergeDays('1.000001', context._turnoverParseRows(minuteRows(previous,[1e8,1e8,2e8])));
  context._turnoverMergeDays('0.399106', context._turnoverParseRows(minuteRows(previous,[2e8,2e8,2e8])));
  const paired = context._turnoverBuildCompare();
  assert.equal(paired.yestFullYi, 10);
  assert.equal(paired.yestSameYi, 10);
  assert.ok(context._turnoverAmountChartSvg(paired).includes('stroke-dasharray="6 4"'));

  context._turnoverMergeDays('1.000001', context._turnoverParseRows([current+' 09:30,999']));
  assert.equal(context._turnoverBuildCompare().todayCumYi, 15, 'Shorter response must not replace complete day');
  context._turnoverCmpAttempt = 0;
  failAll = true;
  const failed = await context._turnoverCompare();
  assert.equal(failed.todayCumYi, 15, 'Outage must retain successful curve');
  context._turnoverMinuteDays = {};
  context._turnoverCmpCache = {ts:0,data:null};
  context._turnoverStorageLoaded = false;
  context._turnoverLoadSaved();
  assert.equal(context._turnoverCmpCache.data.todayCumYi,15,'Reload must restore persisted curve');

  context._turnoverMinuteDays = {};
  context._turnoverMergeDays('1.000001',context._turnoverParseRows(minuteRows(current,[1e8,2e8,3e8])));
  assert.equal(context._turnoverBuildCompare(),null,'One exchange alone must not masquerade as both');
  context._turnoverMergeDays('0.399106',context._turnoverParseRows(minuteRows(current,[2e8,3e8,4e8]).slice(0,2)));
  const aligned = context._turnoverBuildCompare();
  assert.equal(aligned.tod,'09:31');
  assert.equal(aligned.todayCumYi,8,'Exchanges must align to the earlier available minute');
  return 'PASS: fallback, today-only, paired curves, throttle, stale data, persistence, market completeness and time alignment';
})();
