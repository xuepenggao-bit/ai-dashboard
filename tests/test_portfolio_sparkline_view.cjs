const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const view=require('../assets/portfolio-sparkline-view.js');
const now=Date.parse('2026-11-05T14:00:00+08:00');
const row=(points=[['0930',99],['1000',101],['1100',102]])=>({key:'sz300308',date:'2026-11-05',previousClose:100,source:'腾讯财经',points:points.map(p=>({time:p[0],price:p[1]}))});
test('fixed vector size fits existing rows without a new chart instance',()=>{
  const h=view.render(row(),{name:'中际旭创',mkt:'SZ',now});
  assert.match(h,/viewBox="0 0 144 38" width="144" height="38"/);
  assert.ok(!h.includes('<canvas')&&!h.includes('<img')&&!h.includes('<foreignObject'));
  assert.match(h,/中际旭创.*2026-11-05 11:00.*102.00.*\+2.00%.*腾讯财经/);
});
test('A share x axis uses full trading day and compresses noon rather than stretching morning',()=>{
  assert.equal(view.minuteX('0930','SZ'),5);
  assert.equal(view.minuteX('1130','SZ'),72);
  assert.equal(view.minuteX('1300','SZ'),72);
  assert.equal(view.minuteX('1500','SZ'),139);
  assert.ok(view.minuteX('1100','SZ')<100);
  assert.equal(view.minuteX('1200','SZ'),null);
});
test('HK x axis has its own noon and session width; closing auction clamps to edge',()=>{
  assert.equal(view.minuteX('1200','HK'),view.minuteX('1300','HK'));
  assert.equal(view.minuteX('1600','HK'),139);
  assert.equal(view.minuteX('1610','HK'),139);
  assert.equal(view.minuteX('1611','HK'),null);
  assert.equal(view.minuteX('1230','HK'),null);
  assert.ok(view.minuteX('1130','HK')<view.minuteX('1130','SH'));
});
test('previous close stays centered and crossing paths meet exactly on baseline',()=>{
  const g=view.geometry(row([['0930',99],['1000',101]]),'SZ');
  assert.equal(g.baseline,19);
  assert.equal(g.segments.length,2);
  assert.equal(g.segments[0].kind,'down');assert.equal(g.segments[1].kind,'up');
  const a=g.segments[0].points.at(-1),b=g.segments[1].points[0];
  assert.equal(a.x,b.x);assert.equal(a.y,19);assert.equal(b.y,19);
  assert.equal(a.x,(g.points[0].x+g.points[1].x)/2);
});
test('flat curve is neutral and contains no artificial variation',()=>{
  const g=view.geometry(row([['0930',100],['1000',100],['1100',100]]),'SH');
  assert.ok(g.points.every(p=>p.y===19));assert.equal(g.segments.length,1);assert.equal(g.segments[0].kind,'flat');
  assert.match(view.render(row([['0930',100],['1000',100]]),{now}),/stroke="#65778b"/);
});
test('one opening observation is a dot, never a fabricated full-width line',()=>{
  const h=view.render(row([['0930',100]]),{now});
  assert.match(h,/port-spark-dot" cx="5" cy="19"/);
  assert.ok(!h.includes('port-spark-line'));
  assert.ok(!h.includes('port-spark-area'));
});
test('malformed curves display a compact honest placeholder without invalid SVG numbers',()=>{
  for(const r of [null,{...row(),previousClose:0},row([]),row([['1000',NaN]]),row([['1200',100]]),row([['1000',100],['0930',101]]),{...row(),date:'2026-02-30'}]){
    const h=view.render(r,{now});assert.match(h,/分时待更新/);assert.ok(!h.includes('<svg')&&!h.includes('NaN'));
  }
});
test('preopen, holiday and suspended never display an old curve',()=>{
  for(const status of ['preopen','market_closed','suspended']){
    const h=view.render(row(),{name:'测试',status,now});assert.ok(!h.includes('<svg'));assert.match(h,/role="img"/);
  }
  assert.match(view.render(row(),{status:'preopen',now}),/未开盘/);
  assert.match(view.render(row(),{status:'market_closed',now}),/休市/);
  assert.match(view.render(row(),{status:'suspended',now}),/停牌/);
});
test('loading keeps the same dimensions and reduced-motion support is present',()=>{
  const h=view.render(null,{status:'loading',now});assert.match(h,/port-spark-loader/);assert.match(h,/加载分时/);
  const css=fs.readFileSync(require('node:path').join(__dirname,'../assets/portfolio-sparklines.css'),'utf8');
  assert.match(css,/width:144px;height:38px/);assert.match(css,/prefers-reduced-motion:reduce/);
  assert.ok(!css.includes('height:61px'),'existing row height remains untouched');
});
test('cached prior-day curve is labelled as such and keeps its actual date',()=>{
  const h=view.render({...row(),date:'2026-11-04'},{now});
  assert.match(h,/is-stale/);assert.match(h,/缓存行情，非当前实时/);assert.match(h,/port-spark-cache[^>]*>11-04</);
  assert.match(view.render(row(),{status:'stale',now}),/port-spark-cache[^>]*>截至 11:00</);
});
test('same-day stale badge keeps the explicit source cutoff instead of a generic cache label',()=>{
  const h=view.render(row(),{status:'stale',label:'11:00 · 截至',now});
  assert.match(h,/port-spark-cache[^>]*>11:00 · 截至</);
  assert.match(h,/11:00 · 截至 · 缓存行情，非当前实时/);
  assert.match(view.render(row(),{status:'stale',label:'<b>11:00</b>',now}),/port-spark-cache[^>]*>&lt;b&gt;11:00&lt;\/b&gt;</);
});
test('all external names, source labels and placeholders are HTML escaped',()=>{
  const h=view.render({...row(),source:'<img src=x onerror=bad>'},{name:'"<script>bad</script>',now});
  assert.ok(!h.includes('<script>')&&!h.includes('<img'));assert.match(h,/&lt;script&gt;/);assert.match(h,/&lt;img/);
  assert.match(view.render(null,{status:'missing',label:'<b>缺失</b>'}),/&lt;b&gt;缺失&lt;\/b&gt;/);
});
test('HK tooltip uses three decimals and percentage always uses yesterday close',()=>{
  const h=view.render({...row([['0930',101.125]]),key:'hk00700'},{name:'腾讯控股',mkt:'HK',now});
  assert.match(h,/现价 101.125/);assert.match(h,/较昨收 \+1.13%/);
});
