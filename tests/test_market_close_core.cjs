'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const repo = process.env.MARKET_CLOSE_ROOT
  ? path.resolve(process.env.MARKET_CLOSE_ROOT)
  : path.resolve(__dirname, '..');
const htmlPath = process.env.DASHBOARD_HTML || path.join(repo, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const quiet = {log() {}, warn() {}, error() {}};
const afterClose = Date.parse('2026-10-19T08:10:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));

function extracted(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(html);
  assert.ok(match, 'missing production function ' + name);
  const end = html.indexOf('\n}', match.index);
  assert.ok(end > match.index, 'missing closing brace for ' + name);
  const source = html.slice(match.index, end + 2);
  new vm.Script(source);
  return source;
}

function evaluate(names, values) {
  const context = vm.createContext({console: quiet, setTimeout, clearTimeout,
    AbortController, TextDecoder, TextEncoder, ...values});
  for (const name of names) vm.runInContext(extracted(name), context);
  return context;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fakeDate(stamp) {
  return class extends Date {
    constructor(...args) { super(...(args.length ? args : [stamp])); }
    static now() { return stamp; }
  };
}

function macroFixture(overrides = {}, stamp = afterClose) {
  const calls = [], observations = [], classes = new Set();
  const button = {disabled: false, classList: {
    add: value => classes.add(value), remove: value => classes.delete(value),
  }};
  const status = {textContent: '', title: ''}, alert = {style: {display: 'block'}};
  const elements = {macroBtnRefresh: button, macroTs: status, macroAlert: alert};
  const operation = name => async force => { calls.push([name, force]); return true; };
  const values = {
    Date: fakeDate(stamp), document: {getElementById: id => elements[id] || null},
    TAB_ORDER: ['tPort', 't0'], _TAB_TS: {},
    _beijingMarketClock: () => ({minutes: Math.floor((stamp / 60000 + 480) % 1440)}),
    fetchMacroKpis: operation('kpis'), fetchDailyCharts: operation('daily'),
    refreshHighLow52: operation('highLow'), refreshBreadthTrendLive: operation('live'),
    fetchVixChart: operation('vix'),
  };
  const window = {
    refreshMaBreadth: operation('ma'), refreshMarketRisk: operation('risk'),
    refreshEtfShares: operation('etf'), refreshMarketQuality: operation('quality'),
    refreshMarketHeat: operation('heat'), AccountOpenings: {refresh: operation('accounts')},
    MarketCloseRefresh: {observe: report => observations.push(report)},
  };
  Object.assign(values, overrides.values || {});
  Object.assign(window, overrides.window || {});
  values.window = window;
  const context = evaluate(['_macroRefreshTask', 'refreshMacro'], values);
  return {context, calls, observations, button, status, alert, classes};
}

test('forced after-close refresh invokes all nine mandatory production modules', async () => {
  const f = macroFixture();
  const report = await f.context.refreshMacro({force: true, reason: 'close'});
  assert.deepEqual(f.calls.map(row => row[0]).sort(),
    ['kpis', 'daily', 'highLow', 'ma', 'risk', 'etf', 'quality', 'heat', 'accounts', 'vix'].sort());
  assert.ok(f.calls.filter(row => row[0] !== 'vix').every(row => row[1] === true));
  assert.equal(report.results.filter(row => row.required).length, 9);
  assert.equal(report.forced, true);
  assert.equal(report.ok, true);
  assert.equal(report.failed.length, 0);
  assert.equal(f.observations[0], report);
  assert.match(f.status.textContent, /全部指标已核验/);
  assert.equal(f.button.disabled, false);
  assert.equal(f.classes.has('loading'), false);
});

test('ordinary refresh preserves non-forced behavior and boolean true forces all modules', async () => {
  for (const options of [{}, true]) {
    const f = macroFixture();
    const report = await f.context.refreshMacro(options);
    const forced = options === true;
    assert.equal(report.forced, forced);
    assert.ok(f.calls.filter(row => row[0] !== 'vix').every(row => row[1] === forced));
  }
});

test('false results and thrown module errors are isolated and restore the button', async () => {
  const f = macroFixture({window: {
    refreshMarketRisk: async () => false,
    refreshEtfShares: async () => { throw Error('disclosure not available'); },
  }});
  const report = await f.context.refreshMacro({force: true});
  assert.equal(report.ok, false);
  assert.deepEqual(Array.from(report.failed).sort(), ['ETF份额', '波动与回撤'].sort());
  assert.ok(f.calls.some(row => row[0] === 'accounts'));
  assert.ok(f.calls.some(row => row[0] === 'heat'));
  assert.equal(report.results.length, 10);
  assert.equal(f.button.disabled, false);
  assert.equal(f.classes.has('loading'), false);
  assert.equal(f.alert.style.display, 'none');
  assert.match(f.status.textContent, /2项源暂不可用/);
  assert.match(f.status.title, /ETF份额/);
  assert.equal(f.context.refreshMacro.pending, null);
});

test('a not-yet-loaded module is reported without preventing independent modules', async () => {
  const f = macroFixture({window: {refreshMaBreadth: undefined}});
  const report = await f.context.refreshMacro({force: true});
  assert.deepEqual(Array.from(report.failed), ['均线广度']);
  assert.equal(report.results.find(row => row.name === '均线广度').error, '模块尚未就绪');
  assert.ok(f.calls.some(row => row[0] === 'quality'));
  assert.ok(f.calls.some(row => row[0] === 'accounts'));
});

test('concurrent refresh callers share one pending execution and one final report', async () => {
  const gate = deferred(); let count = 0;
  const f = macroFixture({values: {fetchDailyCharts: async () => { count++; return gate.promise; }}});
  const first = f.context.refreshMacro({force: true}), second = f.context.refreshMacro({force: true});
  await tick();
  assert.equal(count, 1);
  assert.equal(f.button.disabled, true);
  assert.ok(f.context.refreshMacro.pending);
  gate.resolve(true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(f.observations.length, 1);
  assert.equal(f.context.refreshMacro.pending, null);
  assert.equal(f.button.disabled, false);
});

test('16:10 and later do not scan live breadth and optional iVIX failure does not fail the refresh', async () => {
  for (const stamp of [afterClose, afterClose + 3600000]) {
    const f = macroFixture({values: {fetchVixChart: async () => { throw Error('optional source unavailable'); }}}, stamp);
    const report = await f.context.refreshMacro({force: true});
    assert.equal(f.calls.some(row => row[0] === 'live'), false);
    assert.equal(report.ok, true);
    assert.equal(report.failed.length, 0);
    const vix = report.results.find(row => row.name === 'iVIX');
    assert.equal(vix.required, false);
    assert.equal(vix.ok, false);
  }
  const before = macroFixture({}, afterClose - 60000);
  await before.context.refreshMacro({force: true});
  assert.ok(before.calls.some(row => row[0] === 'live'));
});

test('task wrapper catches false values, errors and timeouts without rejecting siblings', async () => {
  let expire;
  const context = evaluate(['_macroRefreshTask'], {
    setTimeout: callback => { expire = callback; return 1; }, clearTimeout() {},
  });
  const timeout = context._macroRefreshTask('slow', () => new Promise(() => {}));
  expire();
  const results = await Promise.all([
    timeout, context._macroRefreshTask('false', () => false),
    context._macroRefreshTask('throw', () => { throw Error('bad input'); }),
    context._macroRefreshTask('good', () => true),
  ]);
  assert.deepEqual(results.map(row => row.ok), [false, false, false, true]);
  assert.equal(results[0].error, '读取超时');
  assert.equal(results[2].error, 'bad input');
});

const capCodes = ['sh000002', 'sz399107', 'sz399102', 'sh000680'];
function quoteText(codes, values, field, stamp = '20261019150000') {
  return codes.map((code, index) => {
    const fields = Array(46).fill(''); fields[30] = stamp; fields[field] = values[index];
    return 'v_' + code + '="' + fields.join('~') + '";';
  }).join('\n');
}
function capFixture(fetcher) {
  let fetches = 0;
  const rows = Object.fromEntries(capCodes.map((code, i) => [code, {yi: [100000, 90000, 30000, 40000][i], stamp: '20261016150000'}]));
  const context = evaluate(['_parseMacroMarketCaps', '_macroCapBreakdown', 'fetchMacroMarketCaps'], {
    Date: fakeDate(afterClose), _MACRO_CAP_CONFIG: capCodes.map(code => ({code})),
    _macroCapState: {loaded: true, attempt: afterClose - 60000, pending: null, rows},
    _renderMacroMarketCaps() {}, localStorage: {setItem() {}, getItem() { return null; }},
    fetch: (...args) => { fetches++; return fetcher(...args); },
  });
  return {context, fetches: () => fetches, rows};
}

test('market-cap cache is reused normally, while force bypasses five-minute throttling and awaits the response', async () => {
  const gate = deferred(), f = capFixture(() => gate.promise);
  assert.equal(await f.context.fetchMacroMarketCaps(false), true);
  assert.equal(f.fetches(), 0);
  let finished = false;
  const pending = f.context.fetchMacroMarketCaps(true).then(value => { finished = true; return value; });
  await tick(); assert.equal(f.fetches(), 1); assert.equal(finished, false);
  gate.resolve({ok: true, arrayBuffer: async () => new TextEncoder().encode(
    quoteText(capCodes, [101000, 91000, 31000, 41000], 45)).buffer});
  assert.equal(await pending, true);
  assert.equal(f.context._macroCapState.rows.sh000002.yi, 101000);
  assert.equal(f.context._macroCapState.pending, null);
});

test('failed forced market-cap checks return false and preserve the last good snapshot', async () => {
  const f = capFixture(async () => { throw Error('offline'); });
  assert.equal(await f.context.fetchMacroMarketCaps(true), false);
  assert.equal(f.context._macroCapState.rows, f.rows);
  assert.equal(f.context._macroCapState.pending, null);
});

function kpiFixture(capJob, raw) {
  const flags = [];
  const context = evaluate(['fetchMacroKpis'], {
    Date: fakeDate(afterClose), document: {getElementById() { return null; }},
    fetchMacroMarketCaps: force => { flags.push(force); return capJob; },
    fetch: async () => ({ok: true, arrayBuffer: async () => new TextEncoder().encode(raw).buffer,
      json: async () => ({result: {data: []}})}),
  });
  return {context, flags};
}
const peText = quoteText(['sh000001', 'sz399001', 'sz399006', 'sh000688'], [15, 28, 45, 90], 39);

test('KPI refresh propagates force and waits for the real market-cap job before reporting success', async () => {
  const gate = deferred(), f = kpiFixture(gate.promise, peText);
  let finished = false;
  const pending = f.context.fetchMacroKpis(true).then(value => { finished = true; return value; });
  await tick(); assert.deepEqual(f.flags, [true]); assert.equal(finished, false);
  gate.resolve(true);
  assert.equal(await pending, true);
});

test('KPI success requires both a successful market-cap read and all four valid PE observations', async () => {
  assert.equal(await kpiFixture(Promise.resolve(false), peText).context.fetchMacroKpis(true), false);
  assert.equal(await kpiFixture(Promise.resolve(true), '').context.fetchMacroKpis(true), false);
});

function accountFixture(fetcher) {
  const accountSource = fs.readFileSync(path.join(repo, 'assets/account-openings.js'), 'utf8');
  const listeners = {}, elements = new Map(), timers = new Set();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', style: {},
      classList: {contains() { return false; }, toggle() {}}});
    return elements.get(id);
  };
  const context = vm.createContext({console: quiet, Date: fakeDate(afterClose), Intl,
    AbortController, fetch: fetcher, localStorage: {getItem() { return null; }, setItem() {}},
    document: {readyState: 'loading', hidden: false, getElementById: element,
      addEventListener: (name, callback) => { listeners[name] = callback; }},
    MutationObserver: class { observe() {} },
    setTimeout: callback => { timers.add(callback); return callback; },
    clearTimeout: callback => timers.delete(callback), setInterval() {}, addEventListener() {},
  });
  context.window = context;
  vm.runInContext(accountSource, context);
  listeners.DOMContentLoaded();
  assert.ok(context.AccountOpenings, 'production account module must initialize');
  return context;
}

test('actual account-opening module returns false when all network sources fail', async () => {
  let calls = 0;
  const context = accountFixture(async () => { calls++; throw Error('offline'); });
  assert.equal(await context.AccountOpenings.refresh(true), false);
  assert.equal(calls, 2);
  assert.equal(context.AccountOpenings.getData().check.status, 'seed');
});

test('actual account-opening module returns true for a valid response even if another source fails', async () => {
  let calls = 0, context;
  context = accountFixture(async () => {
    calls++;
    if (calls === 2) throw Error('raw source offline');
    return {ok: true, json: async () => JSON.parse(JSON.stringify(context.AccountOpenings.SEED))};
  });
  assert.equal(await context.AccountOpenings.refresh(true), true);
  assert.equal(calls, 2);
});
