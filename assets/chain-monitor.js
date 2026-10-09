/* Reported earnings, not theme scores. Monetary financial fields are CNY yuan. */
(function(global){
  'use strict';
  const n=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
  const median=a=>{a=a.map(n).filter(v=>v!==null).sort((a,b)=>a-b);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const value=(s,key)=>n(s.financials?.current?.[key]);
  const quoteStamp=q=>String(q?.dateTime||q?.date||'').replace(/\D/g,'').slice(0,14).padEnd(14,'0');
  function beijingDay(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;}
  function freshQuote(s,today=beijingDay()){const age=(Date.parse(today)-Date.parse(s.quote?.date||''))/86400000;return Number.isFinite(age)&&age>=0&&age<=10;}
  function positiveBase(s,key,period){
    const f=period?s.financials?.[period]:s.financials;
    const prev=n(f?.previous?.[key]);
    if(prev!==null)return prev>0;
    const sign=f?.yoyBase?.[key];
    if(sign!==undefined)return sign==='positive'||n(sign)>0;
    // A missing base must never turn a loss reversal into a growth candidate.
    return false;
  }
  function growth(s,key,period){
    const f=period?s.financials?.[period]:s.financials;
    return positiveBase(s,key,period)?n(f?.yoy?.[key]):null;
  }
  function stockPE(s){
    const profit=n(s.financials?.ttm?.netProfit),cap=n(s.quote?.capYi);
    // Keep the numerator/denominator identical for both saved and live quotes.
    if(profit!==null&&profit>0&&cap!==null&&cap>0)return cap*1e8/profit;
    return null;
  }
  function deductedPE(s){const profit=n(s.financials?.ttm?.deductedProfit),cap=n(s.quote?.capYi);return profit!==null&&profit>0&&cap!==null&&cap>0?cap*1e8/profit:null;}
  function classify(s,peerPE){
    const rev=growth(s,'revenue'),adj=growth(s,'deductedProfit');
    const q1=growth(s,'revenue','q1'),q2=growth(s,'revenue','q2');
    const profit=value(s,'netProfit'),cash=value(s,'operatingCashFlow');
    const cf=profit!==null&&profit>0&&cash!==null?cash/profit:null;
    const pe=stockPE(s),period=s.reportDate||'';
    const today=beijingDay();
    const fresh=period>=expectedReportDate(today);
    const quoteFresh=freshQuote(s,today);
    const operating=rev!==null&&rev>=10&&adj!==null&&adj>=15&&value(s,'deductedProfit')>0;
    const accelerating=q1!==null&&q2!==null&&q2>=q1;
    const valuation=pe!==null&&peerPE!==null&&pe<=peerPE;
    const ttmProfit=n(s.financials?.ttm?.netProfit),ttmDeducted=n(s.financials?.ttm?.deductedProfit);
    const recurringShare=ttmProfit>0&&ttmDeducted!==null?ttmDeducted/ttmProfit:null;
    const quality=cf!==null&&cf>=.5&&recurringShare!==null&&recurringShare>=.65;
    let key='wait',label='等待业绩拐点';
    const complete=['revenue','netProfit','deductedProfit','operatingCashFlow'].every(k=>value(s,k)!==null&&n(s.financials?.previous?.[k])!==null);
    if(!fresh||!quoteFresh||!complete){key='missing';label=!fresh?'等待新财报':!quoteFresh?'等待新行情':'证据待补';}
    else if(value(s,'deductedProfit')<=0){key='wait';label='等待盈利拐点';}
    else if(adj===null){key='verify';label='扭亏待确认';}
    else if(pe===null){key='wait';label='TTM盈利待稳定';}
    else if(peerPE===null){key='missing';label='可比估值待补';}
    else if(operating&&!quality){key='verify';label='核验盈利质量';}
    else if(operating&&!valuation){key='valuation';label='等待估值窗口';}
    else if(operating&&valuation&&quality&&accelerating){key='candidate';label='研究候选';}
    else if(operating){key='verify';label='等待增长确认';}
    return {key,label,rev,adj,q1,q2,accelerating,pe,peerPE,cf,operating,valuation,quality,fresh,quoteFresh,recurringShare};
  }
  function expectedReportDate(date){
    const [y,m]=date.split('-').map(Number);
    if(m>=11)return y+'-09-30';
    if(m>=9)return y+'-06-30';
    if(m>=5)return y+'-03-31';
    return (y-1)+'-09-30';
  }
  function groupsOf(data){
    return (data.groups||[]).map(g=>{
      const stocks=(data.stocks||[]).filter(s=>s.group===g.id);
      const dates=stocks.map(s=>s.reportDate).filter(Boolean).sort();
      const period=dates.length?dates[dates.length-1]:null;
      const same=stocks.filter(s=>s.reportDate===period);
      const peSamples=same.filter(s=>freshQuote(s)).map(stockPE).filter(v=>v!==null);
      const pe=median(peSamples),peCount=peSamples.length;
      const analysis=stocks.map(s=>({...s,analysis:classify(s,peCount>=2?pe:null)}));
      const valuesFor=(key,period)=>same.map(s=>growth(s,key,period)).filter(v=>v!==null);
      const midpoint=arr=>arr.length>=2?median(arr):null;
      const q1=midpoint(valuesFor('revenue','q1')),q2=midpoint(valuesFor('revenue','q2'));
      return {...g,stocks:analysis,period,coverage:same.length,total:(g.codes||stocks).length,
        revenue:midpoint(valuesFor('revenue')),profit:midpoint(valuesFor('deductedProfit')),profitCount:valuesFor('deductedProfit').length,
        pe,peCount,profitable:same.filter(s=>value(s,'deductedProfit')>0).length,
        q1,q2,candidates:analysis.filter(s=>s.analysis.key==='candidate').length};
    });
  }
  function parseQuotes(text,data,nowDate,nowStamp){
    if(!nowStamp){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));nowStamp=p.year+p.month+p.day+p.hour+p.minute+p.second;}
    const rows=new Map();
    for(const m of text.matchAll(/v_(sh|sz)(\d{6})="([^"]*)"/g)){
      const f=m[3].split('~'),code=m[2],price=n(f[3]),cap=n(f[45]),stamp=f[30]||'';
      if(!/^\d{14}$/.test(stamp)||price===null||price<=0||cap===null||cap<=0||f[2]!==code)continue;
      const date=stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8);
      const old=data.stocks.find(s=>s.code===code)?.quote;
      if(date>nowDate||stamp>nowStamp||date<(old?.date||'')||stamp<quoteStamp(old))continue;
      rows.set(code,{price,capYi:cap,pb:n(f[46]),changePct:n(f[32]),date,dateTime:stamp,source:'腾讯行情',url:'https://qt.gtimg.cn/q='+m[1]+code});
    }
    return data.stocks.map(s=>{
      const q=rows.get(s.code),profit=n(s.financials?.ttm?.netProfit);
      if(!q)return s;
      q.peTtm=profit!==null&&profit>0?q.capYi*1e8/profit:null;
      q.peTtmDate=q.date;
      q.peTtmSource='总股本按A股价估算市值 / 最新已披露TTM归母净利润';
      return {...s,quote:{...s.quote,...q}};
    });
  }
  const api={median,positiveBase,growth,stockPE,deductedPE,classify,groupsOf,parseQuotes,expectedReportDate,quoteStamp,beijingDay};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(!global.document)return;

  const root=document.getElementById('tStage');if(!root)return;
  let data=null,groups=[],selected='all',chart=null,inflight=null,lastFetch=0,lastQuote=0;
  const CACHE='chain-monitor-v1';
  const pct=v=>n(v)===null?'—':(v>0?'+':'')+Number(v).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%';
  const mult=v=>n(v)===null?'不适用':Number(v).toFixed(1)+'×';
  const col=v=>v>0?'cm-positive':v<0?'cm-negative':'';
  const badge=a=>'<span class="cm-badge '+a.key+'">'+esc(a.label)+'</span>';
  function baseLabel(s,key,period){
    const f=period?s.financials?.[period]:s.financials,curr=n(period?f?.[key]:f?.current?.[key]);
    const prev=n(f?.previous?.[key]);
    if(curr===null)return '—';
    if(prev!==null&&prev<=0){if(curr>0)return '扭亏';if(curr===0)return '盈亏平衡';if(prev===0)return '亏损';return curr>prev?'减亏':'增亏';}
    const v=growth(s,key,period);return v===null?'—':pct(v);
  }
  function sourceLinks(sources,max=4){return (sources||[]).filter(s=>/^https:\/\//.test(s.url||'')).slice(0,max).map(s=>'<a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.name||'来源')+(s.date?' · '+esc(s.date):'')+' ↗</a>').join('');}
  function skeleton(){root.innerHTML=`
    <div class="cm-hero"><div class="cm-hero-top"><div><div class="cm-eyebrow">AI SUPPLY CHAIN · EARNINGS × VALUATION</div><h2>产业链监控</h2><p>先看增长是否兑现，再看价格是否合适。把实际业绩、估值约束和下一步交易观察条件放在同一张地图上。</p></div><button class="cm-refresh" id="stageFreshBtn">↻ 刷新业绩与估值</button></div><div class="cm-status" id="stageApiTs">正在读取最新业绩与估值快照…</div></div>
    <div id="chainContent"><div class="cm-loading">正在加载产业链研究数据…</div></div>`;
    document.getElementById('stageFreshBtn').addEventListener('click',()=>refresh(true));
  }
  function sectorSummary(g){
    if(g.coverage<g.total)return '财报覆盖 '+g.coverage+'/'+g.total;
    if(g.candidates)return g.candidates+' 只通过观察筛选';
    if(g.stocks.some(s=>s.analysis.operating))return '增长兑现 · 等待条件';
    if(g.profitable<g.total)return '盈利分化 · 等待验证';
    return '等待增长改善';
  }
  function render(){
    if(!data)return;groups=groupsOf(data);
    const stocks=groups.flatMap(g=>g.stocks),fresh=stocks.filter(s=>s.analysis.fresh).length;
    const dates=stocks.map(s=>s.quote?.date).filter(Boolean).sort(),latest=dates.at(-1)||'未取得';
    const candidates=stocks.filter(s=>s.analysis.key==='candidate');
    // An observation list is not a synthetic investment score. Candidates first, then
    // companies with disclosed growth; source order is retained within each bucket.
    const priority=[...candidates,...stocks.filter(s=>s.analysis.operating&&s.analysis.key!=='candidate').sort((a,b)=>b.analysis.rev-a.analysis.rev)].slice(0,3);
    const groupMap=new Map(groups.map(g=>[g.id,g]));
    const notes=data.research?.groups||[];
    const noteFor=id=>notes.find(g=>g.id===id)||{};
    const currentDates=[...new Set(stocks.map(s=>s.reportPeriod).filter(Boolean))];
    const generated=data.generatedAt?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(data.generatedAt)):'未取得';
    const content=document.getElementById('chainContent');
    content.innerHTML=`
    <div class="cm-kpis"><div class="cm-kpi"><span>产业链覆盖</span><strong>${groups.length} 个环节</strong><small>${stocks.length} 只代表公司 · 非全行业统计</small></div><div class="cm-kpi"><span>最新应披露财报</span><strong>${fresh} / ${stocks.length}</strong><small>${esc(currentDates.join(' / '))} · 实际披露口径</small></div><div class="cm-kpi"><span>通过观察筛选</span><strong>${candidates.length} 只</strong><small>增长 + 同环节估值 + 现金转化</small></div><div class="cm-kpi"><span>估值行情日期</span><strong style="font-size:21px">${esc(latest)}</strong><small>TTM利润分母随新财报更新</small></div></div>
    ${fresh<stocks.length?'<div class="cm-asof-alert">部分公司尚未取得最新应披露财报，相关公司不进入研究候选。旧数据保留并注明报告期。</div>':''}
    <section class="cm-panel"><div class="cm-heading"><div><h3>交易观察清单</h3><p>先看通过筛选的公司，其余观察按营收增速列示，不代表预期回报排名。</p></div><span>研究判断 · 条件式观察</span></div>
    <div class="cm-opportunities">${priority.length?priority.map(s=>{
      const a=s.analysis,g=groupMap.get(s.group),note=noteFor(s.group),stockNote=s.reportDate>note.reportDate?'新报告期已更新，定性说明待最新公告复核。':note.stockNotes?.[s.code];
      return `<article class="cm-opportunity">${badge(a)}<h4>${esc(s.name)} <span class="cm-code">${esc(s.code)}</span></h4><div class="cm-explain">${esc(g.name)} · ${esc(s.reportPeriod||'')}</div><div class="cm-small-numbers"><span>收入 ${pct(a.rev)}</span><span>扣非 ${pct(a.adj)}</span><span>PE ${mult(a.pe)}</span></div><p><b>为何关注</b> ${esc(stockNote||'已披露收入与扣非利润增长，继续核对增长向现金流的转化。')}</p><p><b>触发条件</b> ${esc(a.key==='candidate'?'维持下一季经营增长与现金转化，并结合自身价格趋势确认；同环节样本估值较低不等于绝对便宜。':a.key==='valuation'?'等待估值回到同环节样本区间，或下一份正式财报继续上修盈利分母。':a.key==='verify'?'优先看到现金回款或下一季收入增速确认，暂不把账面增长直接视为机会。':'先补齐可验证财报与估值。')}</p><p><b>首先反证</b> ${esc((note.falsifier||'下一份正式财报收入或扣非利润转弱，原有增长判断失效。').replace(/^首先反证[：:]\s*/,''))}</p><div class="cm-source">${sourceLinks(s.sources,2)}</div></article>`;
    }).join(''):'<div class="cm-explain">目前没有满足观察条件的公司。保留等待，而不是强行给出交易机会。</div>'}</div></section>
    <section class="cm-panel"><div class="cm-heading"><div><h3>增长与估值地图</h3><p>各环节代表公司中位数。PE跨行业不直接判高低；高增长也不自动意味着便宜。</p></div><span>扣非增长优先 · 亏损不算低PE</span></div><div class="cm-matrix-layout"><div class="cm-chart"><canvas id="chainScatter"></canvas></div><div><div class="cm-explain" style="margin:0 0 15px">营收同比增长中位数 · 点击环节查看公司</div><div class="cm-growth-list">${groups.map(g=>`<div class="cm-growth-row"><button data-chain-group="${esc(g.id)}">${esc(g.name)}</button><div class="cm-growth-bar"><i style="width:${Math.min(100,Math.max(0,(g.revenue||0)/2))}%;background:${g.revenue<0?'#bf7d80':'#4a8e86'}"></i></div><strong class="${col(g.revenue)}">${pct(g.revenue)}</strong></div>`).join('')}</div><p class="cm-explain" style="margin-top:18px">极端同比来自低基数，图中超过300%或200倍的点压缩到边界，悬停可查看原值。上年亏损、当前亏损或覆盖不足的环节不强行画点。</p></div></div></section>
    <section class="cm-panel"><div class="cm-heading"><div><h3>产业环节对照</h3><p>同一报告期，比较真实收入、扣非利润以及Q2相对Q1的同比加速度。</p></div><span>点击环节可筛选下方公司</span></div><div class="cm-table-wrap"><table class="cm-table"><thead><tr><th>产业环节</th><th>营收同比</th><th>扣非净利同比</th><th>Q1 → Q2<br>单季营收同比</th><th>PE TTM中位数</th><th>扣非盈利覆盖</th><th>当前观察</th></tr></thead><tbody>${groups.map(g=>`<tr><td><button class="cm-sector-btn" data-chain-group="${esc(g.id)}">${esc(g.name)} ↗</button><small>${esc(g.period||'未取得报告期')} · ${g.coverage}/${g.total} 只</small></td><td><span class="cm-number ${col(g.revenue)}">${pct(g.revenue)}</span></td><td><span class="cm-number ${col(g.profit)}">${pct(g.profit)}</span><small>${g.profitCount}/${g.total} 只正基数样本</small></td><td>${pct(g.q1)} → ${pct(g.q2)}<small>${g.q1!==null&&g.q2!==null?(g.q2>=g.q1?'增长加速 / 持平':'增长减速'):'单季证据待补'}</small></td><td><b>${mult(g.pe)}</b><small>${g.peCount}/${g.total} 只TTM盈利公司${g.peCount<2?" · 样本不足":""}</small></td><td>${g.profitable}/${g.total}</td><td>${esc(sectorSummary(g))}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="cm-panel" id="chainCompanyPanel"><div class="cm-heading"><div><h3>公司业绩 × 估值明细</h3><p>不把公允价值收益、资产处置收益与主业增长混为一谈；每家公司保留报告期及来源。</p></div></div><div class="cm-toolbar"><label>产业环节 <select class="cm-select" id="chainGroupSelect"><option value="all">全部环节</option>${groups.map(g=>'<option value="'+esc(g.id)+'">'+esc(g.name)+'</option>').join('')}</select></label><span class="cm-explain">现金转化 = 经营现金流 / 归母净利润（当期）</span></div><div class="cm-table-wrap"><table class="cm-table cm-company-table"><thead><tr><th>公司 / 报告期</th><th>营收同比</th><th>归母净利同比</th><th>扣非净利同比</th><th>Q1 → Q2<br>营收同比</th><th>经营现金流<br>亿元 / 现金转化</th><th>PE TTM<br>同环节中位数</th><th>当前观察 / 来源</th></tr></thead><tbody id="chainCompanyBody"></tbody></table></div></section>
    <section class="cm-panel"><div class="cm-heading"><div><h3>产业证据与下一步催化</h3><p>事实截至 ${esc(data.research?.asOf||data.asOf)}；催化与反证为研究观察，不是公司盈利承诺。</p></div><span>事实 / 判断分开</span></div><div class="cm-sector-cards">${groups.map(g=>{
      const r=noteFor(g.id),isOld=r.reportDate&&g.period>r.reportDate;
      return `<article class="cm-sector-card"><div class="cm-heading" style="margin-bottom:5px"><h4>${esc(g.name)}</h4><span>${esc(r.asOf||data.research?.asOf||data.asOf)}</span></div><p class="cm-fact"><b>已披露事实</b> ${esc(r.fact||'已披露数据见上表；尚未取得可独立量化的主题收入证据，不将全公司增长等同AI业务增长。')}</p><p><b>下一步催化</b> ${esc(r.catalyst||'下一份正式财报确认收入、扣非利润与经营现金流同步改善。')}</p><p><b>首先反证</b> ${esc(r.falsifier||'收入增长无法转化为扣非利润和现金回款。')}</p>${isOld?'<p>新报告期财务已更新；以上定性说明仍对应旧报告期，待新公告复核。</p>':''}<div class="cm-source">${sourceLinks(r.sources,6)}</div></article>`;
    }).join('')}</div></section>
    <section class="cm-panel"><details class="cm-method"><summary>统计口径与观察规则</summary><ol><li>每个环节为2—3只代表公司样本，不等于全行业。营收、扣非增速使用同报告期、至少2只上年基数为正的公司中位数；亏损及扭亏另标，不计为低估值。</li><li>Q2单季金额由上半年累计减Q1推导，再与上年Q2比较。TTM = 上一完整财年 + 最新累计期 − 上年同期，不把半年利润简单乘2。</li><li>PE TTM = 行情总股本按A股价估算市值 / 最新已披露TTM归母净利；扣非TTM倍数另列作为交叉检查。A+H公司此处不是A/H加权总市值口径。亏损时PE不适用。只在同环节比较估值，不使用假设的远期PE或PEG。</li><li>研究候选须同时满足：最新应披露财报；营收同比≥10%；扣非同比≥15%且盈利；Q2营收同比≥Q1；现金转化≥50%；TTM扣非/归母利润≥65%；PE不高于本环节至少2只盈利样本的中位数。这是可复核的观察筛选，不是收益概率或买入评级。</li><li>现金转化低、一次性收益占比高及存货扩张需结合原始财报核验。季节性现金流会影响筛选；“未通过”不等于公司没有投资价值。</li><li>访问本标签页后台读取最新快照，并更新估值行情；可见时每5分钟刷新行情。后台每日08:19、12:19、16:19、20:19、22:19检查最新财报，失败保留上次有效结果，不用默认分数伪装实时数据。</li><li>定性证据标记核对日期，定量财报和行情各自标记日期。新财报与旧叙述冲突时，以最新公告为准。</li></ol></details></section>`;
    document.getElementById('chainGroupSelect').value=selected;
    document.getElementById('chainGroupSelect').addEventListener('change',e=>{selected=e.target.value;renderCompanies();});
    content.querySelectorAll('[data-chain-group]').forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.chainGroup;document.getElementById('chainGroupSelect').value=selected;renderCompanies();document.getElementById('chainCompanyPanel').scrollIntoView({behavior:'smooth',block:'start'});}));
    renderCompanies();renderChart();
    const warning=data.status==='ok'?'':' · 部分数据保留上次有效结果';
    document.getElementById('stageApiTs').textContent='财务快照 '+generated+' 北京时间 · 行情 '+(dates[0]||'未取得')+' — '+latest+warning+' · 定性研究 '+(data.research?.asOf||data.asOf);
  }
  function renderCompanies(){
    const body=document.getElementById('chainCompanyBody');if(!body)return;
    body.innerHTML=groups.filter(g=>selected==='all'||g.id===selected).flatMap(g=>g.stocks.map(s=>{
      const a=s.analysis,cash=value(s,'operatingCashFlow'),r=(data.research?.groups||[]).find(r=>r.id===g.id),note=s.reportDate>r?.reportDate?'新报告期已更新，历史定性说明待复核。':r?.stockNotes?.[s.code];
      return `<tr><td><span class="cm-name">${esc(s.name)}</span> <span class="cm-code">${esc(s.code)}</span><small>${esc(g.name)} · ${esc(s.reportPeriod||s.reportDate||'报告期未取得')}</small><small>披露 ${esc(s.disclosureDate||'待核验')}</small></td><td class="${col(a.rev)}">${baseLabel(s,'revenue')}</td><td>${baseLabel(s,'netProfit')}</td><td><span class="cm-number ${col(a.adj)}">${baseLabel(s,'deductedProfit')}</span></td><td>${baseLabel(s,'revenue','q1')} → ${baseLabel(s,'revenue','q2')}</td><td>${cash===null?'—':(cash/1e8).toFixed(2)}<small>${a.cf===null?'净利亏损 / 待核验':pct(a.cf*100)}</small></td><td><b>${mult(a.pe)}</b><small>扣非TTM ${mult(deductedPE(s))}</small><small>同环节样本 ${mult(a.peerPE)}</small><small>${esc(s.quote?.date||'行情未取得')}</small></td><td>${badge(a)}${note?'<small class="cm-company-note" title="'+esc(note)+'">'+esc(note)+'</small>':''}<div class="cm-source">${sourceLinks(s.sources,2)}</div></td></tr>`;
    })).join('');
  }
  function renderChart(){
    if(chart){chart.destroy();chart=null;}
    const canvas=document.getElementById('chainScatter');if(!canvas||!global.Chart)return;
    const palette=['#466d9c','#9a7752','#6573a1','#3f8f86','#ae7582','#69836b','#5488a0','#8c789e','#8b985c','#b0865f'];
    const dots=groups.filter(g=>g.coverage===g.total&&g.peCount>=2&&g.pe!==null&&g.profit!==null&&g.profitable===g.total);
    chart=new global.Chart(canvas,{type:'scatter',data:{datasets:dots.map(g=>({label:g.name,data:[{x:Math.min(200,g.pe),y:Math.min(300,Math.max(-100,g.profit))}],pointRadius:8,pointHoverRadius:11,backgroundColor:palette[groups.indexOf(g)%palette.length],borderColor:'#fff',borderWidth:2,_group:g}))},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{min:0,title:{display:true,text:'PE TTM（倍）',color:'#536b81'},grid:{color:'#edf1f5'},ticks:{color:'#64778b'}},y:{title:{display:true,text:'扣非净利润同比（%）',color:'#536b81'},grid:{color:'#edf1f5'},ticks:{color:'#64778b',callback:v=>v+'%'}}},plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:8,boxHeight:8,usePointStyle:true,padding:12}},tooltip:{callbacks:{label:c=>{const g=c.dataset._group;return g.name+'：PE '+mult(g.pe)+' · 扣非 '+pct(g.profit);}}}}}});
  }
  async function json(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);try{const r=await fetch(url,{signal:c.signal,cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(t);}}
  function valid(d){return d&&d.schemaVersion===1&&Array.isArray(d.groups)&&d.groups.length>=8&&Array.isArray(d.stocks)&&d.stocks.length>=20&&d.stocks.some(s=>s.reportDate&&s.financials?.current);}
  async function quotes(force){
    if(!data||(!force&&Date.now()-lastQuote<300000))return;
    const codes=data.stocks.map(s=>(s.code[0]==='6'?'sh':'sz')+s.code).join(',');
    const c=new AbortController(),t=setTimeout(()=>c.abort(),7000);
    try{const r=await fetch('https://qt.gtimg.cn/q='+codes+'&_='+Date.now(),{signal:c.signal,cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const raw=new TextDecoder('gbk').decode(await r.arrayBuffer());const today=beijingDay();data={...data,stocks:parseQuotes(raw,data,today)};lastQuote=Date.now();save();render();}catch(e){console.warn('[产业链估值] 保留有效快照',e.message);}finally{clearTimeout(t);}
  }
  function save(){try{localStorage.setItem(CACHE,JSON.stringify(data));}catch(_){}}
  function refresh(force){
    if(inflight)return inflight;
    if(!force&&Date.now()-lastFetch<60000)return Promise.resolve();
    const button=document.getElementById('stageFreshBtn');if(button)button.disabled=true;
    inflight=(async()=>{
      let fresh=null;
      for(const base of ['data/chain_monitor.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/chain_monitor.json']){
        try{const d=await json(base+'?_='+Date.now());if(!valid(d))throw Error('数据不完整');if(data&&String(d.generatedAt)<String(data.generatedAt))continue;fresh=d;break;}catch(e){console.warn('[产业链财报]',e.message);}
      }
      if(fresh){
        // Re-reading a static snapshot must not regress newer browser quotes.
        const old=new Map((data?.stocks||[]).map(s=>[s.code,s]));
        fresh.stocks=fresh.stocks.map(s=>{const o=old.get(s.code);return quoteStamp(o?.quote)>quoteStamp(s.quote)&&o.reportDate===s.reportDate?{...s,quote:o.quote}:s;});
        data=fresh;save();render();lastFetch=Date.now();
      }else if(data){document.getElementById('stageApiTs').textContent+=' · 网络暂不可达，保留上次有效数据';}
      else document.getElementById('chainContent').innerHTML='<div class="cm-loading">产业链快照暂未取得，请稍后刷新。不会使用旧的主观评分代替真实数据。</div>';
      if(data)await quotes(force);
    })().finally(()=>{inflight=null;if(button)button.disabled=false;});
    return inflight;
  }
  skeleton();
  try{const cached=JSON.parse(localStorage.getItem(CACHE));if(valid(cached)){data=cached;render();}}catch(_){}
  global.ChainMonitor={refresh,render,getData:()=>data};
  refresh(false);
  setInterval(()=>{if(root.classList.contains('active')&&!document.hidden){quotes(false);if(Date.now()-lastFetch>900000)refresh(false);}},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&root.classList.contains('active'))refresh(false);});
})(typeof window==='undefined'?globalThis:window);
