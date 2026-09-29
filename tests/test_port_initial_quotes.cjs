const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.TEST_HTML || path.join(__dirname, '../index.html'), 'utf8');
const quoteStart = html.indexOf('async function fetchPortPrices(){');
const quoteEnd = html.indexOf('function renderPortTop3(){', quoteStart);
const initStart = html.indexOf('async function portInit(){');
const initEnd = html.indexOf('/* 手动强制将当前数据推送到云端', initStart);
assert.ok(quoteStart > 0 && quoteEnd > quoteStart && initEnd > initStart, 'Expected portfolio function boundaries');
const quoteSource = html.slice(quoteStart, quoteEnd);
const initSource = html.slice(initStart, initEnd);
const NOW = Date.UTC(2026, 8, 28, 2, 30); // Monday 10:30 Beijing, independent of runner timezone.
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const stock = (code = '600000', mkt = 'SH') => ({code, mkt, name: code, w: 10});
const portfolio = stocks => ({_savedAt: 2, sectors: [{name: 'test', stocks}]});
function stamp(ts = NOW) {
  return new Date(ts + 8 * 3600000).toISOString().slice(0, 19).replace(/\D/g, '');
}
function tx(symbol, price = 100, quoteTs = NOW) {
  const p = Array(81).fill('');
  p[3] = String(price); p[30] = stamp(quoteTs); p[32] = '1.25';
  p[38] = '.8'; p[45] = '1000'; p[49] = '1.2'; p[50] = '1.4'; p[59] = '.3'; p[80] = '.1';
  return 'v_' + symbol + '="' + p.join('~') + '";';
}
const response = (text = '', data = {data: {diff: []}}) => ({ok: true, arrayBuffer: async () => Buffer.from(text), json: async () => data});
const symbolsFromUrl = url => (String(url).match(/\/q=([^&]+)/) || [])[1] || '';
function harness(stocks = [stock()], handler) {
  const requests = [], renders = [], elements = new Map();
  const saved = new Map([['portfolio-test', JSON.stringify(portfolio(stocks))]]);
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', title: '', disabled: false,
      classList: {add() {}, remove() {}, contains() { return false; }}});
    return elements.get(id);
  };
  const ctx = vm.createContext({Date: Clock, Number, Math, Promise, URL, AbortController, TextDecoder,
    setTimeout, clearTimeout, console: {log() {}, warn() {}, error() {}},
    _pfInflight: false, _PORT_PRICES: {}, _portSort: {}, _TAB_TS: {}, _arCur: 0,
    _portRevision: 0, _portDirty: false, PORT_KEY: 'portfolio-test', PORT_GH_FILE: 'portfolio.json',
    PORT: portfolio(stocks), portLoad() {}, _isTradingNow: () => true,
    document: {getElementById: element},
    localStorage: {getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value)},
    _portTurnoverRate(value) { const n = Number(value); return value == null || String(value).trim() === '' || !Number.isFinite(n) || n < 0 ? null : n; },
    renderPortfolio() { renders.push(copy(ctx._PORT_PRICES)); }, renderPortTop3() {}, _renderPortTopW() {},
    fetchPortFiveDayRanges: async () => {}, fetchIndexPrices: async () => {}, updateRiskDashboard() {},
    _fetchSinaRT: async () => ({}), _setSyncTs() {},
    _fetchPortfolioRemote: async () => ({data: copy(ctx.PORT)}),
    _weightCount: data => data ? data.sectors.flatMap(s => s.stocks).length : -1,
    _mergePortfolioData: primary => copy(primary), _mergeRemoteFields() {}, _historyState: () => '',
    _getGithubToken: () => '', _clonePortfolio: copy, portSaveRemote: async () => {},
    fetch: async (url, options) => {
      requests.push({url, options});
      if (handler) return handler(url, options, requests);
      const symbols = symbolsFromUrl(url);
      return response(symbols ? symbols.split(',').map(symbol => tx(symbol)).join('\n') : '');
    }
  });
  vm.runInContext(quoteSource + '\n' + initSource, ctx);
  return {ctx, requests, renders, elements};
}

module.exports = (async () => {
  let passed = 0;
  // Auxiliary metrics and a second market may be slow; ready A prices must paint now.
  {
    const slow = deferred();
    const h = harness([stock(), stock('00700', 'HK')], async url => {
      if (url.includes('q=sh600000')) return response(tx('sh600000', 101));
      await slow.promise;
      return response();
    });
    const running = h.ctx.fetchPortPrices();
    await flush();
    assert.equal(h.ctx._PORT_PRICES['600000']?.price, 101, 'A price must publish before slow HK/metrics complete');
    assert.ok(h.renders.some(row => row['600000']?.price === 101), 'A price must actually render before the barrier');
    assert.equal(h.ctx._pfInflight, true, 'Other streams are still in flight');
    slow.resolve(); await running; passed++;
  }
  for (const source of ['em', 'sina']) {
    const slow=deferred();
    const h=harness([stock('00700','HK')],async url=>{
      if(source==='em'&&url.includes('push2.eastmoney.com'))return response('',{data:{diff:[{f12:'00700',f2:419,f3:1, f124:NOW/1000}]}});
      await slow.promise;return response();
    });
    if(source==='sina')h.ctx._fetchSinaRT=async()=>({rt_hk00700:{price:419,pct:1,quoteTs:NOW}});
    const running=h.ctx.fetchPortPrices();await flush();
    assert.equal(h.ctx._PORT_PRICES['00700']?.price,419,source+' publishes without waiting for Tencent metrics');
    assert.ok(h.renders.some(row=>row['00700']?.price===419));
    slow.resolve();await running;passed++;
  }
  // A response body that stalls after headers is still covered by the timeout.
  {
    let bodyAborted=false;
    const h=harness([stock()],async(url,options)=>{
      if(url.includes('qt.gtimg.cn'))return response(tx('sh600000',103));
      return {ok:true,json:()=>new Promise((resolve,reject)=>{
        options.signal.addEventListener('abort',()=>{bodyAborted=true;reject(new Error('body timeout'));});
      })};
    });
    h.ctx.setTimeout=(fn,ms)=>setTimeout(fn,ms===5000?5:ms);
    await h.ctx.fetchPortPrices();
    assert.equal(bodyAborted,true);
    assert.equal(h.ctx._PORT_PRICES['600000'].price,103);
    assert.equal(h.ctx._pfInflight,false);passed++;
  }
  // Refresh does not blank the last successful quote, even when every source fails.
  {
    const slow = deferred();
    const h = harness([stock()], async () => { await slow.promise; throw new Error('network down'); });
    h.ctx._PORT_PRICES['600000'] = {price: 98, pct: .5, mkt: 'SH', quoteTs: NOW - 1000, src: 'tc'};
    const running = h.ctx.fetchPortPrices();
    await flush();
    assert.equal(h.ctx._PORT_PRICES['600000']?.price, 98, 'Retain price during requests');
    slow.resolve(); await running;
    assert.equal(h.ctx._PORT_PRICES['600000']?.price, 98, 'Retain price after failure');
    assert.equal(h.ctx._PORT_PRICES['600000']?.stale, true); passed++;
  }
  // An in-flight cloud roster update cannot be dropped, including same-code market changes.
  {
    const firstMetrics = deferred(); let metricRequests = 0;
    const h = harness([stock()], async url => {
      const symbols = symbolsFromUrl(url);
      if (symbols) return response(symbols.split(',').map(symbol => tx(symbol, 102)).join('\n'));
      if (++metricRequests === 1) await firstMetrics.promise;
      return response();
    });
    const first = h.ctx.fetchPortPrices(); await flush();
    h.ctx.PORT = portfolio([stock('600000', 'SZ'), stock('600001', 'SH')]);
    const overlapping = h.ctx.fetchPortPrices();
    firstMetrics.resolve(); await Promise.all([first, overlapping]);
    const quoteRequests = h.requests.filter(row => row.url.includes('qt.gtimg.cn'));
    assert.equal(quoteRequests.length, 2, 'Exactly one immediate catch-up round, without an interval tick');
    assert.ok(quoteRequests[1].url.includes('sz600000') && quoteRequests[1].url.includes('sh600001'));
    assert.equal(h.ctx._PORT_PRICES['600000'].mkt, 'SZ');
    assert.equal(h.ctx._PORT_PRICES['600001'].price, 102);
    assert.equal(h.ctx._pfInflight, false); passed++;
  }
  // Realtime Tencent HK prices are not ignored or downgraded by an older EM response.
  {
    const h = harness([stock('00700', 'HK')], async url => {
      if (url.includes('qt.gtimg.cn')) return response(tx('r_hk00700', 420));
      return response('', {data: {diff: [{f12: '00700', f2: 410, f3: 1, f124: (NOW - 60000) / 1000}]}});
    });
    await h.ctx.fetchPortPrices();
    assert.equal(h.ctx._PORT_PRICES['00700'].price, 420);
    assert.equal(h.ctx._PORT_PRICES['00700'].quoteTs, NOW);
    assert.equal(h.ctx._PORT_PRICES['00700'].src, 'tc_rt'); passed++;
  }
  // All publishers obey source time, reject future/untimed regressions, and use current metadata.
  {
    const h = harness([stock('00700', 'HK')]); const s = h.ctx.PORT.sectors[0].stocks[0];
    assert.equal(h.ctx._portPublishQuote(s, {price: 420, pct: 1, quoteTs: NOW, src: 'tc_rt'}), true);
    for (const quote of [{price: 400, pct: 1, quoteTs: NOW - 1000, src: 'em'},
      {price: 400, pct: 1, quoteTs: 0, src: 'em'}, {price: 400, pct: 1, quoteTs: NOW + 3600000, src: 'em'}]) {
      assert.equal(h.ctx._portPublishQuote(s, quote), false);
      assert.equal(h.ctx._PORT_PRICES['00700'].price, 420);
    }
    s.w = 25; s.name = 'updated';
    h.ctx._portPublishQuote({...s, w: 1, name: 'obsolete'}, {price: 421, pct: 1, quoteTs: NOW + 1000, src: 'tc_rt'});
    assert.equal(h.ctx._PORT_PRICES['00700'].w, 25);
    assert.equal(h.ctx._PORT_PRICES['00700'].name, 'updated'); passed++;
  }
  // First-load retry is independent of auto-refresh, and healthy first responses aren't doubled.
  for (const firstState of ['missing', 'old', 'fresh']) {
    let quoteRequests = 0;
    const h = harness([stock()], async url => {
      if (!url.includes('qt.gtimg.cn')) return response();
      quoteRequests++;
      const first = quoteRequests === 1;
      return response(first && firstState === 'missing' ? '' : tx('sh600000', 100 + quoteRequests,
        first && firstState === 'old' ? NOW - 240000 : NOW));
    });
    assert.equal(h.ctx._arCur, 0, 'Manual mode fixture');
    await h.ctx.portInit();
    assert.equal(quoteRequests, firstState === 'fresh' ? 1 : 2, firstState + ' first response retry count');
    assert.equal(h.ctx._PORT_PRICES['600000'].quoteTs, NOW);
    assert.equal(h.ctx._portPricesNeedRefresh(), false); passed++;
  }
  return `PASS: ${passed} initial quote scenarios (progressive rendering, retained prices, roster catch-up, HK realtime/time guards, manual startup retry)`;
})();
