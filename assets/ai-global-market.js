(function(global){
  'use strict';
  const COLORS=['#356a9a','#8b71a5','#b17a35','#258072'];
  const numeric=v=>typeof v==='number'&&Number.isFinite(v);
  const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pct=v=>numeric(v)?(v>0?'+':'')+v.toFixed(2)+'%':'—';
  const pp=v=>numeric(v)?(v>0?'+':'')+v.toFixed(2)+' pp':'—';
  const tone=v=>!numeric(v)?'':v>0?'agm-up':v<0?'agm-down':'';
  function validPrices(data){
    const now=Date.now(),today=new Date(now+8*3600000).toISOString().slice(0,10),revision=Date.parse(data?.updatedAt);
    return data?.schemaVersion===1&&Number.isFinite(revision)&&revision<=now+300000&&Array.isArray(data.markets)&&data.markets.length===4&&new Set(data.markets.map(m=>m.id)).size===4&&data.markets.every(m=>
      m.id&&m.name&&Array.isArray(m.stocks)&&m.stocks.length>=2&&m.benchmark&&[...m.stocks,m.benchmark].every(s=>s.symbol&&s.name&&/^https:\/\//.test(s.sourceUrl||'')&&Array.isArray(s.series)&&s.series.length>=21&&s.series.every((r,i)=>date(r.date)&&r.date<=today&&numeric(r.close)&&r.close>0&&(!i||r.date>s.series[i-1].date)))&&marketModel(m).dates.length>=21);
  }
  function marketModel(m){
    const securities=[...m.stocks,m.benchmark],maps=securities.map(s=>new Map(s.series.map(r=>[r.date,r.close])));
    const dates=m.benchmark.series.map(r=>r.date).filter(d=>maps.every(map=>map.has(d)));
    // Fixed sample, equal initial notional buy-and-hold: no daily rebalancing,
    // forward-filled holidays, FX conversion, or invented constituent history.
    function sampleReturn(start,end){return m.stocks.reduce((sum,_,i)=>sum+(maps[i].get(end)/maps[i].get(start)-1)*100,0)/m.stocks.length;}
    function benchmarkReturn(start,end){return(maps.at(-1).get(end)/maps.at(-1).get(start)-1)*100;}
    function period(n){if(dates.length<n+1)return{sample:null,benchmark:null,excess:null};const start=dates.at(-n-1),end=dates.at(-1),sample=sampleReturn(start,end),benchmark=benchmarkReturn(start,end);return{sample,benchmark,excess:sample-benchmark,start,end};}
    return{...m,dates,latest:dates.at(-1),day:period(1),week:period(5),month:period(20),sampleReturn,benchmarkReturn,stockMoves:m.stocks.map((s,i)=>({name:s.name,symbol:s.symbol,sourceUrl:s.sourceUrl,date:dates.at(-1),change:dates.length>=2?(maps[i].get(dates.at(-1))/maps[i].get(dates.at(-2))-1)*100:null}))};
  }
  function chartSeries(models,window=20,relative=false){
    const dates=[...new Set(models.flatMap(m=>m.dates.slice(-window-1)))].sort();
    return{dates,datasets:models.map((m,i)=>{const own=m.dates.slice(-window-1),start=own[0],set=new Set(own);return{label:m.name,data:dates.map(d=>set.has(d)?m.sampleReturn(start,d)-(relative?m.benchmarkReturn(start,d):0):null),borderColor:COLORS[i],backgroundColor:COLORS[i],borderWidth:2.2,borderDash:i===1?[6,3]:i===2?[2,3]:[],pointRadius:0,pointHoverRadius:4,tension:0,spanGaps:false,_market:m.name,_start:start};})};
  }
  function validReview(d){return d?.schemaVersion===1&&date(d.asOf)&&d.asOf<=new Date(Date.now()+8*3600000).toISOString().slice(0,10)&&typeof d.headline==='string'&&Array.isArray(d.regions)&&d.regions.length===4&&Array.isArray(d.events)&&Array.isArray(d.social)&&Array.isArray(d.sources)&&d.sources.every(s=>s.id&&s.title&&date(s.date)&&s.date<=d.asOf&&/^https:\/\//.test(s.url||''));}
  const api={validPrices,validReview,marketModel,chartSeries,pct,pp};
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(!global.document)return;
  const root=document.getElementById('aiGlobalMarketRoot'),tab=document.getElementById('tStage');if(!root||!tab)return;
  let prices=null,review=null,chart=null,pending=null,last=0,windowSize=20,relative=false;
  function sources(ids){return(review?.sources||[]).filter(s=>ids?.includes(s.id)).map(s=>'<a href="'+escape(s.url)+'" target="_blank" rel="noopener noreferrer">'+escape(s.title)+' · '+escape(s.date)+' ↗</a>').join('');}
  function block(item){return'<article class="agm-note"><span class="agm-type">'+escape(item.type||'已披露事实')+' · '+escape(item.date||review.asOf)+'</span><h4>'+escape(item.title)+'</h4><p>'+escape(item.fact)+'</p>'+(item.readThrough?'<p class="agm-interpretation"><b>传导解读</b> '+escape(item.readThrough)+'</p>':'')+'<div class="agm-sources">'+sources(item.sourceIds)+'</div></article>';}
  function render(){
    if(!review||!prices)return;
    const models=prices.markets.map(marketModel);
    const expanded=!!root.querySelector('.agm-details')?.open;
    if(chart){chart.destroy();chart=null;}
    root.innerHTML='<section class="agm-module"><header class="agm-header"><div><span class="agm-eyebrow">GLOBAL AI MARKETS · PRICE / EVIDENCE / EXPECTATIONS</span><h2>全球 AI 市场综述</h2><p>'+escape(review.headline)+'</p></div><button type="button" class="agm-refresh">↻ 更新行情</button></header><div class="agm-dates"><span>研究核验 '+escape(review.asOf)+' · '+escape(review.cutoff||'北京时间')+'</span><span>行情快照 '+escape(prices.updatedAt.replace('T',' ').slice(0,16))+' · 各市场收盘日见卡片</span></div><p class="agm-summary">'+escape(review.summary)+'</p><div class="agm-market-grid">'+models.map((m,i)=>'<article class="agm-market" style="--agm-accent:'+COLORS[i]+'"><div class="agm-market-head"><h3>'+escape(m.name)+'</h3><span>'+escape(m.currency)+' · '+escape(m.latest)+'</span></div><div class="agm-market-return"><div><span>AI 样本 · 最近交易日</span><strong class="'+tone(m.day.sample)+'">'+pct(m.day.sample)+'</strong></div><div><span>20 日相对宽基</span><b class="'+tone(m.month.excess)+'">'+pp(m.month.excess)+'</b></div></div><div class="agm-market-period"><span>5 日 <b class="'+tone(m.week.sample)+'">'+pct(m.week.sample)+'</b></span><span>20 日 <b class="'+tone(m.month.sample)+'">'+pct(m.month.sample)+'</b></span></div><div class="agm-stock-list">'+m.stockMoves.map(s=>'<a href="'+escape(s.sourceUrl)+'" target="_blank" rel="noopener noreferrer"><span>'+escape(s.name)+'</span><b class="'+tone(s.change)+'">'+pct(s.change)+'</b></a>').join('')+'</div><small>宽基：'+escape(m.benchmark.name)+' · 固定代表股等权样本，非行业指数</small></article>').join('')+'</div><section class="agm-chart-panel"><div class="agm-section-head"><div><h3>价格是否跟得上产业叙事？</h3><p>本币收盘价格收益；各地交易日不同，休市留空，不换算汇率或计入股息。</p></div><div class="agm-controls"><div role="group" aria-label="收益口径"><button data-mode="price" aria-pressed="'+!relative+'">AI 样本</button><button data-mode="relative" aria-pressed="'+relative+'">相对本地宽基</button></div><div role="group" aria-label="交易日窗口"><button data-window="20" aria-pressed="'+(windowSize===20)+'">20 日</button><button data-window="60" aria-pressed="'+(windowSize===60)+'">60 日</button></div></div></div><div class="agm-chart"><canvas id="aiGlobalMarketChart" role="img" aria-label="美国、韩国、台湾、中国代表AI股票本币收盘收益对照"></canvas></div><p class="agm-footnote">每个窗口各市场从各自首个交易日归零；等额买入固定样本、期内不再平衡。相对值为样本收益减当地宽基收益的百分点差，非汇率对冲或可投资指数。样本不代表所有 AI 企业。</p></section><div class="agm-section-head"><div><h3>四地行情：同一条产业链，不同的定价风险</h3><p>事实与推断分开；价格回撤不自动证明订单收缩，盈利增长也不自动证明估值便宜。</p></div></div><div class="agm-region-grid">'+review.regions.map(r=>'<article class="agm-region"><span class="agm-type">'+escape(r.label)+'</span><h3>'+escape(r.title)+'</h3><p>'+escape(r.fact)+'</p><div class="agm-interpretation"><b>研究判断</b><p>'+escape(r.view)+'</p></div><p class="agm-watch"><b>下一步验证</b> '+escape(r.watch)+'</p><div class="agm-sources">'+sources(r.sourceIds)+'</div></article>').join('')+'</div><details class="agm-details"><summary>展开事件、社交观点与情景监测 <span>区分新闻证据与市场叙事</span></summary><div class="agm-section-head"><div><h3>近期事件 → 上市公司传导</h3><p>没有确切因果证据时，不将同时发生写成导致；公司预测不等于实际收入。</p></div></div><div class="agm-event-grid">'+review.events.map(block).join('')+'</div><div class="agm-section-head"><div><h3>社交与公开观点：观点不是订单</h3><p>仅列可回溯原帖或原文；不代表平台整体情绪，也不按发帖热度给股票打分。</p></div></div><div class="agm-event-grid">'+review.social.map(block).join('')+'</div><div class="agm-section-head"><div><h3>从新闻到交易观察：三种条件路径</h3><p>下列为研究情景，不赋予未经验证的概率或目标价。</p></div></div><div class="agm-scenarios">'+(review.scenarios||[]).map(s=>'<article><span>'+escape(s.label)+'</span><h4>'+escape(s.title)+'</h4><p>'+escape(s.condition)+'</p><p><b>观察动作</b> '+escape(s.action)+'</p></article>').join('')+'</div><p class="agm-counter"><b>最强反方</b> '+escape(review.counterargument)+'</p><div class="agm-disclosure"><b>来源、时点与边界</b><p>'+escape(review.limitations)+'</p><p>研究日期与行情日期独立；自动任务只刷新价格，不会把旧新闻重新标成最新研究。没有一致预期、目标价模型或仓位约束，本综述用于行业观察，不构成个性化买卖建议。</p></div></details></section>';
    root.querySelector('.agm-refresh').addEventListener('click',()=>load(true));
    root.querySelector('.agm-refresh').title='读取后台最近生成的收盘快照；新闻核验日期独立显示';
    root.querySelectorAll('.agm-market').forEach((card,i)=>{
      const link=document.createElement('a');link.href=models[i].benchmark.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='宽基日线 ↗';
      card.querySelector('small').append(' · ',link);
      if(models[i].status==='retained')card.querySelector('small').append(' · 本次抓取未成功，保留上次有效数据');
    });
    root.querySelector('.agm-details').open=expanded;
    root.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{relative=b.dataset.mode==='relative';render();}));
    root.querySelectorAll('[data-window]').forEach(b=>b.addEventListener('click',()=>{windowSize=Number(b.dataset.window);render();}));
    const series=chartSeries(models,windowSize,relative);
    if(typeof global.Chart==='function')chart=new global.Chart(document.getElementById('aiGlobalMarketChart'),{type:'line',data:{labels:series.dates,datasets:series.datasets},options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#466079',font:{size:13},boxWidth:20,padding:15}},tooltip:{callbacks:{label:c=>c.dataset.label+' '+(relative?pp(c.parsed.y):pct(c.parsed.y))+' · 起点 '+c.dataset._start}}},scales:{x:{grid:{display:false},ticks:{maxTicksLimit:8,maxRotation:0,color:'#687b8f',font:{size:12},callback:(_,i)=>series.dates[i]?.slice(5)}},y:{grid:{color:'#e2e9f0'},ticks:{color:'#687b8f',font:{size:12},callback:v=>v+(relative?' pp':'%')}}}}});
  }
  async function read(file){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);try{const response=await fetch('data/'+file+'?_='+Date.now(),{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}}
  async function load(force=false){
    if(!tab.classList.contains('active')||document.hidden)return false;if(pending)return pending;if(!force&&Date.now()-last<300000)return true;last=Date.now();
    pending=(async()=>{const results=await Promise.allSettled([read('ai_global_market_prices.json'),read('ai_global_market_review.json')]);const p=results[0],r=results[1];if(p.status==='fulfilled'&&validPrices(p.value)&&(!prices||p.value.updatedAt>=prices.updatedAt))prices=p.value;if(r.status==='fulfilled'&&validReview(r.value)&&(!review||r.value.asOf>=review.asOf))review=r.value;
      if(prices&&review){render();return true;}root.innerHTML='<div class="agm-loading">跨市场研究暂未读取成功，切回本页或稍后重试；其他产业链模块照常显示。</div>';return false;})();try{return await pending;}finally{pending=null;}
  }
  global.AIGlobalMarket={...api,load};
  const start=()=>{new MutationObserver(()=>load()).observe(tab,{attributes:true,attributeFilter:['class']});document.addEventListener('visibilitychange',()=>load());global.addEventListener('resize',()=>{if(tab.classList.contains('active'))chart?.resize();});setInterval(()=>load(),300000);load();};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})(typeof window!=='undefined'?window:globalThis);
