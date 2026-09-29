const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const html = fs.readFileSync(process.env.TEST_HTML || path.join(__dirname, '../index.html'), 'utf8');
function node(tag = 'div') {
  return { tag, children: [], style: { setProperty() {} }, textContent: '',
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; } };
}
const elements = Object.fromEntries(['arrLatestEvent', 'creditRatingGrid', 'creditRatingTs', 'creditRatingNote'].map(id => [id, node()]));
const context = vm.createContext({ URL, document: { createElement: node, getElementById: id => elements[id] } });
for (const [start, end] of [['_renderArrLatestEvent(d)', '_setCloudSource(id,item)'], ['_renderCreditRatings(d)', '_renderAiTrend(d)']]) {
  vm.runInContext(html.slice(html.indexOf('function ' + start + '{'), html.indexOf('function ' + end + '{')), context);
}
const data = {
  arr_checked_at: '2026-09-29', arr_anthropic: [470, 650],
  arr_latest_events: {
    openai: { company: 'OpenAI', summary: '400亿美元', numeric: true, source_date: '2026-08-13', source_url: 'https://www.bloomberg.com/news/article' },
    anthropic: { company: 'Anthropic', summary: '年底预期，未计入曲线', numeric: false, disclosure_type: 'forecast', source_date: '2026-09-18', source_url: 'https://www.nytimes.com/news/article' }
  }
};
const before = JSON.stringify(data);
context._renderArrLatestEvent(data);
const text = n => n.textContent + n.children.map(text).join('');
assert.equal(elements.arrLatestEvent.children.length, 3);
assert.match(text(elements.arrLatestEvent), /OpenAI/);
assert.match(text(elements.arrLatestEvent), /Anthropic 预期动态/);
assert.match(text(elements.arrLatestEvent), /2026-09-29/);
assert.equal(JSON.stringify(data), before, 'rendering must not promote forecasts into actual series');
data.arr_latest_events.openai.source_url = 'https://bloomberg.com.evil.invalid/';
data.arr_latest_events.anthropic.source_url = 'javascript:alert(1)';
context._renderArrLatestEvent(data);
assert.equal(elements.arrLatestEvent.children.flatMap(n => n.children).filter(n => n.tag === 'a').length, 0);
context._renderArrLatestEvent({});
assert.equal(elements.arrLatestEvent.children.length, 0);
assert.equal(elements.arrLatestEvent.style.display, 'none');
context._renderCreditRatings({ credit_ratings: { checked_at: '2026-09-29', as_of: '2026-08-21', companies: {
  microsoft: { display_name: 'Microsoft', ratings: { sp: { rating: 'AAA', outlook: 'Stable' }, fitch: { rating: 'WD', note: '撤销评级' } }, last_action: { label: '确认评级', detail: '公开报道' } },
  amazon: { display_name: 'Amazon', ratings: { sp: { rating: 'AA', outlook: 'Stable' } }, last_action: { kind: 'flat', label: '展望调整', detail: '正面调为稳定，评级不变' } }
} } });
assert.match(text(elements.creditRatingGrid), /WD/);
assert.match(text(elements.creditRatingGrid), /展望调整/);
assert.equal(elements.creditRatingTs.textContent, '公开来源核查 2026-09-29');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) new vm.Script(match[1]);
}
console.log('PASS: both companies, forecast separation, source safety, check dates, rating actions, inline syntax');
