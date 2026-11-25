const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('var _newsAttemptTS ='),html.indexOf('// ── Global Finance（同源缓存'));
function harness(){
  const storage=new Map(),elements={newsTop:{innerHTML:''},newsTopSource:{textContent:'',title:''}};
  const ctx=vm.createContext({console:{warn(){},log(){}},Date,Map,Set,Promise,AbortController,setTimeout,clearTimeout,
    document:{getElementById:id=>elements[id]},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},_escH:String});
  vm.runInContext(source,ctx);
  return {ctx,storage,elements};
}
const NOW=Math.floor(Date.now()/1000),item=(age,title,provider='东方财富')=>({ts:NOW-age,title,url:'https://example.com/'+encodeURIComponent(title),publisher:provider,provider});
test('publication timestamps support epoch/ISO and explicit Beijing dates, independent of browser timezone',()=>{
  const {ctx}=harness(),stamp=Date.parse('2026-11-25T12:05:17+08:00')/1000;
  for(const value of [stamp,stamp*1000,String(stamp),'2026-11-25 12:05:17','2026/11/25 12:05:17','2026-11-25T04:05:17Z'])assert.equal(ctx._newsParseTime(value),stamp);
  assert.equal(ctx._newsParseTime('not a date'),0);
});
test('top news merges by original publication time, rejects future/unsafe items and cannot roll back',()=>{
  const {ctx}=harness();
  const newest=item(20,'最新文章测试'),older=item(600,'较旧文章测试');
  ctx._newsTopMerge([newest,older],'华尔街见闻');
  ctx._newsTopMerge([item(1000,'最新文章测试'),{...item(-1000,'未来文章测试')},{...item(10,'不安全链接测试'),url:'javascript:alert(1)'},{...item(10,'无日期新闻测试'),ts:0}],'旧备份');
  assert.equal(ctx._newsTopItems.length,2);assert.equal(ctx._newsTopItems[0].ts,newest.ts);
  ctx._newsTopMerge([{...item(10,'同一文章新标题测试'),url:newest.url}],'华尔街见闻');
  assert.equal(ctx._newsTopItems.length,2,'Do not display the same article URL twice after a headline edit');
  assert.equal(ctx._newsTopItems[0].title,'同一文章新标题测试');
});
test('a slow newer source is not discarded after the fast older source wins the race',async()=>{
  const {ctx,elements}=harness();let release;
  ctx._newsEastmoneyArticles=async()=>[item(600,'快源旧闻测试')];
  ctx._newsWscnArticles=host=>host.includes('awtmt')?new Promise(resolve=>release=()=>resolve([item(20,'慢源最新新闻测试','华尔街见闻')])):Promise.reject(new Error('DNS blocked'));
  ctx._newsFetchJson=async()=>{throw new Error('No backend snapshot');};
  const pending=ctx._fetchNewsTop();
  await new Promise(resolve=>setTimeout(resolve,1));
  assert.match(elements.newsTop.innerHTML,/快源旧闻测试/,'Render each valid source as it arrives');
  release();await pending;
  assert.equal(ctx._newsTopItems[0].title,'慢源最新新闻测试');
  assert.ok(elements.newsTop.innerHTML.indexOf('慢源最新新闻测试')<elements.newsTop.innerHTML.indexOf('快源旧闻测试'));
  assert.ok(elements.newsTopSource.textContent.includes(ctx._newsTime(NOW-20,true)));
});
test('cold browser with both live sources blocked still displays shared latest five articles',async()=>{
  const {ctx,elements}=harness();ctx._newsWscnArticles=ctx._newsEastmoneyArticles=async()=>{throw Error('CORS/network blocked');};
  const items=Array.from({length:5},(_,i)=>item(60+i,'后台最新新闻测试'+i));
  const urls=[];ctx._newsFetchJson=async url=>{urls.push(url);return {updatedAt:new Date((NOW-30)*1000).toISOString(),status:'ok',items};};
  assert.equal(await ctx._fetchNewsTop(),'后台要闻');
  assert.equal(ctx._newsTopItems.length,5);assert.match(elements.newsTop.innerHTML,/后台最新新闻测试0/);
  assert.equal(urls.length,2);assert.ok(urls.some(u=>u.startsWith('https://raw.githubusercontent.com/')));
  assert.match(elements.newsTopSource.textContent,/备份/);
});
test('late stale Pages JSON cannot overwrite a newer raw snapshot and a total outage retains content',async()=>{
  const {ctx,elements}=harness();ctx._newsWscnArticles=ctx._newsEastmoneyArticles=async()=>{throw Error('offline');};
  ctx._newsFetchJson=async url=>{
    if(url.startsWith('data/'))await new Promise(resolve=>setTimeout(resolve,10));
    return {updatedAt:new Date((NOW-30)*1000).toISOString(),status:'ok',items:[url.startsWith('data/')?item(600,'旧Pages新闻测试'):item(20,'新Raw新闻测试')]};
  };
  await ctx._fetchNewsTop();assert.equal(ctx._newsTopItems[0].title,'新Raw新闻测试');
  ctx._newsFetchJson=async()=>{throw Error('offline');};await ctx._fetchNewsTop();
  assert.match(elements.newsTop.innerHTML,/新Raw新闻测试/);assert.match(elements.newsTopSource.textContent,/备份/);
});
test('retained old snapshot is usable but does not report a successful fresh update',async()=>{
  const {ctx}=harness();ctx._newsWscnArticles=ctx._newsEastmoneyArticles=async()=>{throw Error('offline');};
  ctx._newsFetchJson=async()=>({updatedAt:new Date((NOW-86400)*1000).toISOString(),status:'retained',items:[item(86400,'昨日缓存新闻测试')]});
  assert.equal(await ctx._fetchNewsTop(),'');assert.equal(ctx._newsTopItems.length,1);
});
test('direct source configuration uses the reachable official alternate, sufficient depth and required trace',async()=>{
  const {ctx}=harness();const urls=[];
  ctx._newsFetchJson=async url=>{urls.push(url);return url.includes('eastmoney')?{code:'1',data:{list:[]}}:{code:20000,data:{items:[]}};};
  await ctx._newsWscnArticles();await ctx._newsEastmoneyArticles();
  assert.match(urls[0],/api-one-wscn\.awtmt\.com/);assert.match(urls[0],/limit=30/);
  assert.match(urls[1],/req_trace=\d+/);assert.match(urls[1],/page_size=40/);
  assert.ok(!html.includes("const label=sources.length===2?'更新'"),'A check time must not pretend to be an article publication time');
});
