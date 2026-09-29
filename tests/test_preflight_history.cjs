const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.TEST_HTML || path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf("const PRE_KEY='preflight_log_v1';");
const end = html.indexOf('// ── REFRESH', start);
const tabStart = html.indexOf('function _tabRefresh(idx){');
const tabEnd = html.indexOf('function switchTab(idx){', tabStart);
assert.ok(start > 0 && end > start && tabStart > 0 && tabEnd > tabStart, 'Expected preflight source boundaries');
const source = html.slice(start, end) + '\n' + html.slice(tabStart, tabEnd);
const KEY = 'preflight_log_v1';
const NOW = Date.UTC(2026, 8, 29, 2, 30);
const TODAY = '2026-09-29';
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const record = (date = TODAY, ans = {q1: '平稳', q2: '4'}) => ({date, ans, ts: '10:30', light: 'green', quad: 'KL', flags: []});
const history = count => Array.from({length: count}, (_, i) => record(new Date(NOW - i * 86400000).toISOString().slice(0, 10)));
const response = (value, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => copy(value)});
const apiResponse = (log, sha = 'read-sha') => response({sha, content: Buffer.from(JSON.stringify(log)).toString('base64')});
const putResponse = (sha = 'written-sha') => response({content: {sha}});

function harness({cache = null, token = '', blockedStorage = false, rawCache, handler} = {}) {
  let now = NOW, timerId = 0;
  const timers = new Map(), requests = [], elements = new Map();
  const saved = new Map();
  if (cache !== null) saved.set(KEY, JSON.stringify(cache));
  if (rawCache !== undefined) saved.set(KEY, rawCache);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
        classList: {add: (...names) => names.forEach(n => classes.add(n)),
          remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n)}});
    }
    return elements.get(id);
  }
  const options = ['平稳', '亢奋', '紧张沉重'].map(value => {
    const el = element('q1-' + value);
    el.dataset = {q: 'q1', v: value, warn: value === '平稳' ? '0' : '1'};
    el.parentElement = {querySelectorAll: () => options};
    return el;
  });
  const note = element('note'); note.dataset = {q: 'q4note'};
  const ctx = vm.createContext({Date: Clock, Number, Math, Promise, AbortController,
    console: {log() {}, warn() {}, error() {}},
    TAB_ORDER: ['tPort', 't0', 'tHist', 'tPre', 'tTrade', 'tVal', 'tStage'],
    _TAB_TS: {3: NOW}, _TAB_THROTTLE: 30000, PORT_GH_REPO: 'test/dashboard',
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, {fn, at: now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    confirm: () => true,
    document: {getElementById: element, querySelectorAll(selector) {
      if (selector === '#tPre .popt') return options;
      if (selector === '#tPre .pnote') return [note];
      return [];
    }},
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error('Storage blocked'); return saved.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage) throw new Error('Storage blocked'); saved.set(key, value); }
    },
    _getGithubToken: () => token,
    _githubApiHeaders: extra => ({Accept: 'application/vnd.github+json', ...extra}),
    _decodeGhContent: value => JSON.parse(Buffer.from(value || '', 'base64').toString('utf8')),
    _b64Encode: value => Buffer.from(value).toString('base64'),
    fetch: async (url, options = {}) => {
      const req = {url: String(url), options}; requests.push(req);
      if (!handler) throw new Error('Unexpected fetch ' + url);
      return handler(req, requests);
    }
  });
  vm.runInContext(source, ctx);
  return {ctx, requests, saved, timers, element, note, options,
    state: expression => vm.runInContext(expression, ctx),
    setToken(value) { token = value; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id); timer.fn();
      }
      await flush();
    }
  };
}

module.exports = (async () => {
  let passed = 0;
  const failures = [];
  const test = async (name, run) => {
    try { await run(); passed++; }
    catch (error) { failures.push(name + ': ' + error.message); }
  };

  await test('first visit renders all cached rows despite boot throttle', async () => {
    const remote = deferred(), log = history(77);
    const h = harness({cache: log, handler: () => remote.promise});
    h.ctx._tabRefresh(3);
    assert.equal((h.element('preHist').innerHTML.match(/<tr style=/g) || []).length, 78);
    assert.equal(h.requests.length, 1, 'first tab access starts refresh despite _TAB_TS[3]');
    assert.equal(h.state('_PRE.q1'), '平稳');
    remote.resolve(response(log)); await flush();
    assert.equal(h.state('_preRefreshPending'), null);
  });

  await test('idle warmup and first tab access deduplicate and hydrate today', async () => {
    const remote = deferred();
    const h = harness({handler: () => remote.promise});
    const warm = h.ctx._preRefreshHistory(), visit = h.ctx.preLoad();
    assert.equal(warm, visit, 'one shared refresh promise');
    assert.equal(h.requests.length, 1);
    remote.resolve(response([record()])); await Promise.all([warm, visit]);
    assert.equal(h.state('_PRE.q1'), '平稳', 'first visit should hydrate saved answers after warmup');
  });

  for (const action of ['click', 'note', 'reset']) await test(action + ' survives delayed refresh and revisit', async () => {
    const remote = deferred();
    const h = harness({cache: [record()], handler: () => remote.promise});
    const pending = h.ctx.preLoad();
    if (action === 'click') h.ctx.preClick(h.options[1]);
    if (action === 'note') { h.note.value = 'unsaved draft'; h.ctx.preNote(h.note); }
    if (action === 'reset') h.ctx.preReset();
    h.ctx.preLoad();
    remote.resolve(response([record(TODAY, {q1: '紧张沉重', q4note: 'cloud note'})])); await pending;
    if (action === 'click') assert.equal(h.state('_PRE.q1'), '亢奋');
    if (action === 'note') assert.equal(h.state('_PRE.q4note'), 'unsaved draft');
    if (action === 'reset') assert.equal(h.state('Object.keys(_PRE).length'), 0);
    assert.equal(h.state('_preFormDirty'), true);
  });

  await test('read-only API leaves authoritative write SHA intact', async () => {
    const h = harness({token: 'test', handler: () => apiResponse([record()], 'display-sha')});
    h.state("_preSha='write-sha'");
    assert.equal((await h.ctx._preGhGet()).length, 1);
    assert.equal(h.state('_preSha'), 'write-sha');
    assert.ok(h.requests[0].url.startsWith('https://api.github.com/'));
  });

  await test('save supersedes pending display read and preserves other dates', async () => {
    const remote = deferred(), old = history(77);
    const h = harness({cache: old, handler: req => {
      if (req.options.method === 'PUT') return putResponse();
      if (req.url.startsWith('https://api.')) return apiResponse(old, 'base-sha');
      return remote.promise;
    }});
    const pending = h.ctx.preLoad(); h.setToken('test'); h.ctx.preClick(h.options[1]);
    await h.ctx.preSubmit();
    const written = h.requests.find(r => r.options.method === 'PUT');
    const body = JSON.parse(written.options.body);
    const log = JSON.parse(Buffer.from(body.content, 'base64').toString());
    assert.equal(body.sha, 'base-sha'); assert.equal(log.length, 77);
    assert.equal(log[0].ans.q1, '亢奋');
    assert.deepEqual(log.slice(1), old.slice(1));
    const status = h.element('preSaveTip').textContent;
    remote.resolve(response(old)); await pending;
    assert.equal(h.state('_preSha'), 'written-sha');
    assert.equal(JSON.parse(h.saved.get(KEY))[0].ans.q1, '亢奋');
    assert.equal(h.element('preSaveTip').textContent, status);
  });

  await test('new edits during PUT stay dirty and writes serialize', async () => {
    const put = deferred();
    const h = harness({cache: [record()], token: 'test', handler: req =>
      req.options.method === 'PUT' ? put.promise : apiResponse([record()])});
    h.state("_preFormDay='2026-09-29';_preLastSync=Date.now()");
    await h.ctx.preLoad(); h.ctx.preClick(h.options[1]);
    const saving = h.ctx.preSubmit(); await flush();
    h.note.value = 'typed during PUT'; h.ctx.preNote(h.note);
    await h.ctx.preDeleteRecord(TODAY); await h.ctx.preSubmit();
    assert.equal(h.requests.length, 2, 'overlapping writes do not begin');
    put.resolve(putResponse()); await saving;
    assert.equal(h.state('_preFormDirty'), true);
    assert.equal(h.state('_PRE.q4note'), 'typed during PUT');
    assert.equal(JSON.parse(h.saved.get(KEY))[0].ans.q4note, undefined);
  });

  await test('delete wins pending read and later stale CDN is excluded', async () => {
    const remote = deferred(), old = history(3), target = old[1].date;
    let deleted = false;
    const h = harness({cache: old, handler: req => {
      if (req.options.method === 'PUT') { deleted = true; return putResponse(); }
      if (req.url.startsWith('https://api.')) return apiResponse(deleted ? old.filter(r => r.date !== target) : old);
      return remote.promise;
    }});
    const pending = h.ctx.preLoad(); h.setToken('test');
    await h.ctx.preDeleteRecord(target);
    remote.resolve(response(old)); await pending;
    assert.equal(h.state('_preReadCache().length'), 2);
    assert.equal(h.element('preHist').innerHTML.includes(target), false);
    h.setToken(''); await h.advance(31000); await h.ctx.preLoad();
    assert.equal(h.requests.filter(r => !r.url.startsWith('https://api.')).length, 1,
      'post-write refresh must not query stale CDN even without token');
    assert.equal(h.state('_preReadCache().length'), 2);
  });

  for (const action of ['submit', 'delete']) await test('failed ' + action + ' leaves displayed and cached history unchanged', async () => {
    const old = history(3);
    const h = harness({cache: old, token: 'test', handler: req =>
      req.options.method === 'PUT' ? response({}, 409) : apiResponse(old)});
    h.state('_preLastSync=Date.now()'); await h.ctx.preLoad();
    const before = h.element('preHist').innerHTML;
    if (action === 'submit') { h.ctx.preClick(h.options[1]); await h.ctx.preSubmit(); }
    else await h.ctx.preDeleteRecord(old[1].date);
    assert.equal(h.element('preHist').innerHTML, before);
    assert.deepEqual(JSON.parse(h.saved.get(KEY)), old);
    assert.equal(h.state('_preWriting'), false);
    assert.match(h.element('preSaveTip').textContent, /失败/);
  });

  await test('authoritative read failure never PUTs cached history', async () => {
    const h = harness({cache: history(3), token: 'test', handler: () => response({}, 503)});
    await h.ctx.preSubmit();
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.method, undefined);
    assert.equal(h.state('_preWriting'), false);
    assert.equal(JSON.parse(h.saved.get(KEY)).length, 3);
  });

  await test('blocked storage still supports in-memory refresh and revisits', async () => {
    const h = harness({blockedStorage: true, handler: () => response(history(3))});
    await h.ctx.preLoad();
    assert.equal(h.state('_preReadCache().length'), 3);
    await h.ctx.preLoad(); assert.equal(h.requests.length, 1);
    assert.ok(h.element('preHist').innerHTML.includes(TODAY));
  });

  await test('malformed cache and malformed CDN fall back to API', async () => {
    const h = harness({rawCache: '{broken', handler: req =>
      req.url.startsWith('https://api.') ? apiResponse(history(2)) : response({bad: true})});
    await h.ctx.preLoad();
    assert.equal(h.requests.length, 2); assert.equal(h.state('_preReadCache().length'), 2);
  });

  await test('CDN 404 falls back instead of erasing cached history', async () => {
    const h = harness({cache: history(3), handler: req =>
      req.url.startsWith('https://api.') ? apiResponse(history(3)) : response({}, 404)});
    await h.ctx.preLoad();
    assert.equal(h.requests.length, 2); assert.equal(h.state('_preReadCache().length'), 3);
  });

  await test('stalled JSON body times out, aborts, releases refresh and retries', async () => {
    const never = new Promise(() => {});
    let healthy = false;
    const h = harness({cache: history(3), handler: req => healthy
      ? (req.url.startsWith('https://api.') ? apiResponse(history(4)) : response(history(4)))
      : {ok: true, status: 200, json: () => never}});
    const pending = h.ctx.preLoad(); await flush();
    await h.advance(3500);
    assert.equal(h.requests.length, 2, 'CDN body timeout starts API fallback');
    assert.equal(h.requests[0].options.signal.aborted, true);
    await h.advance(6000); await pending;
    assert.equal(h.requests[1].options.signal.aborted, true);
    assert.equal(h.state('_preRefreshPending'), null);
    assert.equal(h.timers.size, 0); assert.equal(h.state('_preReadCache().length'), 3);
    healthy = true; await h.ctx.preLoad();
    assert.equal(h.state('_preReadCache().length'), 4);
  });

  if (failures.length) throw new Error(failures.length + ' preflight scenario(s) failed:\n' + failures.join('\n'));
  return `PASS: ${passed} preflight history scenarios (cache-first, first access, dedupe, drafts, writes, SHA, CDN safety, storage and timeouts)`;
})();

if (require.main === module) {
  module.exports.then(message => console.log(message), error => { console.error(error.stack || error); process.exitCode = 1; });
}
