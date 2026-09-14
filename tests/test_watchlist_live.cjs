const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('var _newsAttemptTS ='), html.indexOf('// ── Global Finance（同源缓存'));
const storage = new Map();
const elements = {newsWatchlist:{innerHTML:''},newsWatchlistSource:{textContent:''}};
const context = vm.createContext({
  console:{warn(){},log(){}}, Date, Map, Set, Promise, AbortController, setTimeout, clearTimeout,
  PORT:{sectors:[{stocks:[{name:'江波龙'},{name:'兆易创新'},{name:'江波龙'}]}]},
  document:{getElementById:id=>elements[id]},
  localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
  _escH: text=>String(text),
});
vm.runInContext(source, context);
module.exports = (async () => {
  assert.equal(context._watchlistStocks().length,2,'Deduplicate dual listings');
  assert.equal(context._watchlistEpoch('2026-09-14 13:53:12'),Date.parse('2026-09-14T13:53:12+08:00')/1000);
  const item=(ts,name='江波龙')=>({title:'公司新闻'+ts,ts,stockName:name,url:'https://example.com/'+ts,provider:'东方财富'});
  const stocks=context._watchlistStocks();
  context._watchlistMerge([item(200)],stocks);
  context._watchlistMerge([item(100)],stocks);
  assert.equal(context._watchlistItems[0].ts,200,'Late old cache must not overwrite newer live items');
  context._watchlistMerge([item(300,'已删除股票')],stocks);
  assert.equal(context._watchlistItems.length,2,'Exclude removed holdings');
  let calls=0, active=0, peak=0;
  context._watchlistSearch=async stock=>{
    calls++;active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,2));active--;
    return [item(400+calls,stock.name)];
  };
  context._newsFetchJson=async()=>{await new Promise(resolve=>setTimeout(resolve,15));return {items:[item(100)],updatedAt:'2026-09-14T01:59:13Z'};};
  await context._fetchNewsWatchlist(false);
  assert.equal(calls,2);
  assert.ok(elements.newsWatchlistSource.textContent.includes('已核查'));
  assert.ok(context._watchlistItems[0].ts>=400);
  await context._fetchNewsWatchlist(false);
  await context._fetchNewsWatchlist(true);
  assert.equal(calls,2,'Rapid refresh, including force, must not spam source');
  context._watchlistLiveAttempt-=300001;
  await context._fetchNewsWatchlist(false);
  assert.equal(calls,4,'Live query repeats after five minutes');
  context.PORT.sectors[0].stocks.push({name:'新加入股票'});
  await context._fetchNewsWatchlist(false);
  assert.equal(calls,7,'Changed portfolio triggers a new scan without waiting');
  assert.ok(peak<=3,'Limit direct query concurrency');
  context._watchlistSearch=async()=>{throw new Error('offline');};
  context._watchlistLiveAttempt-=300001;
  const latest=context._watchlistItems[0].ts;
  await context._fetchNewsWatchlist(false);
  assert.equal(context._watchlistItems[0].ts,latest,'Source outage retains latest known articles');
  assert.ok(elements.newsWatchlistSource.textContent.includes('直连暂不可达'));
  assert.equal(context._watchlistInflight,null,'Inflight state resets');

  // Test the actual JSONP transport with a simulated script response.
  vm.runInContext(source,context);
  context.window={};let removed=0;
  context.document.createElement=()=>({remove(){removed++;}});
  context.document.head={appendChild(script){
    const url=new URL(script.src);
    const cb=url.searchParams.get('cb');
    const query=JSON.parse(url.searchParams.get('param'));
    assert.equal(query.param.cmsArticleWebOld.sort,'time');
    context.window[cb]({result:{cmsArticleWebOld:[{title:'江波龙午后新闻',date:'2026-09-14 13:53:12',url:'http://finance.eastmoney.com/a/1.html'}]}});
  }};
  const result=await context._watchlistSearch({name:'江波龙'});
  assert.equal(result.length,1);
  assert.ok(result[0].url.startsWith('https://'));
  assert.equal(removed,1);
  assert.equal(Object.keys(context.window).length,0,'JSONP callbacks are cleaned up');
  return 'PASS: live refresh, throttle, portfolio changes, concurrency, cache race, outage, China time and JSONP cleanup';
})();
