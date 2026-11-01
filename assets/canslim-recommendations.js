/* Dated research, not a live trading signal. Scores are reproducible, not probabilities. */
(function(global){
  'use strict';
  const KEYS=['C','A','N','S','L','I','M'];
  const LABELS={C:'当季盈利',A:'年度增长',N:'新催化',S:'供需结构',L:'相对强度',I:'机构支持',M:'市场方向'};
  const num=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pct=(v,d=1)=>num(v)===null?'待核验':(v>0?'+':'')+Number(v).toFixed(d)+'%';
  const fmt=(v,d=2)=>num(v)===null?'待核验':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
  const median=a=>{a=a.map(num).filter(v=>v!==null).sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:null;};
  function scoreC(m){
    const v=num(m.q3DeductedYoy);
    if(v===null||m.q3PriorDeductedPositive!==true)return {score:2,missing:true,reason:'未取得正基数的单季扣非同比；不以累计增速或扭亏百分比替代。'};
    const raw=v>=100?5:v>=50?4:v>=25?3:v>=0?2:v>=-20?1:0;
    return {score:m.lowBase===true?Math.min(raw,3):raw,reason:'2026Q3单季扣非归母净利润同比 '+pct(v)+(m.lowBase?'；基数异常，最高3分。':'；采用扣非利润，而非累计EPS。')};
  }
  function scoreA(m){
    const annual=m.annualDeducted||[],byYear=new Map(annual.map(x=>[x.year,num(x.value)]));
    if(![2022,2023,2024,2025].every(y=>byYear.has(y)&&byYear.get(y)!==null))return {score:2,missing:true,reason:'2022–2025年度扣非利润证据未完整，不能计算三年复合增长，保守2分。'};
    if(![2022,2023,2024,2025].every(y=>byYear.get(y)>0))return {score:2,reason:'2022–2025年度扣非利润包含亏损或零值，复合增长不可比，按扭亏/波动型成长保守记2分，不把负基数转正算高增长。'};
    const cagr=(Math.pow(byYear.get(2025)/byYear.get(2022),1/3)-1)*100;
    const changes=[2023,2024,2025].map(y=>(byYear.get(y)/byYear.get(y-1)-1)*100);
    let score=cagr>=35?5:cagr>=25?4:cagr>=15?3:cagr>=0?2:changes[2]>changes[1]?1:0;
    if(Math.min(...changes)<-30)score=Math.min(score,3);
    const cash=num(m.cashConversion);if(cash!==null&&cash<.8)score=Math.max(0,score-1);
    return {score,cagr,reason:'2022→2025扣非净利润三年CAGR '+pct(cagr)+'；逐年增速 '+changes.map(x=>pct(x)).join(' / ')+(Math.min(...changes)<-30?'；曾下滑超过30%，上限3分':'')+(cash!==null&&cash<.8?'；本年前三季现金转化低于80%，扣1分。':'。')};
  }
  function scoreL(m){
    const excess=num(m.excess126);
    if(excess===null)return {score:2,missing:true,reason:'未取得可核验的126交易日股价及基准收益，信息不足。'};
    const score=excess>=30?5:excess>=15?4:excess>=0?3:excess>=-15?2:excess>=-30?1:0;
    return {score,reason:'前复权126交易日收益 '+pct(m.return126)+'，相对'+(m.benchmarkName||'基准')+'超额 '+fmt(excess,1)+'个百分点。此为基准超额代理，不是全市场RPS百分位或行业名次。'};
  }
  function scoreM(market){
    const {close,ma50,ma200,ma50Prior20}=market||{};
    if([close,ma50,ma200,ma50Prior20].some(x=>num(x)===null))return {score:2,missing:true,reason:'市场均线证据不完整，信息不足。'};
    const score=close>ma50&&ma50>ma200&&ma50>ma50Prior20?5:close>ma50&&close>ma200?4:close>ma50||close>ma200?3:ma50>ma200?1:0;
    return {score,reason:(market.name||'基准')+'收盘 '+fmt(close)+'，MA50 '+fmt(ma50)+'，MA200 '+fmt(ma200)+'；MA50较20日前'+(ma50>ma50Prior20?'上升':'下降或持平')+'。该交易市场样本采用相同环境分，不代表公司质量。'};
  }
  function evaluated(stock,market){
    const m=stock.metrics||{},manual=stock.assessments||{},scores={C:scoreC(m),A:scoreA(m),L:scoreL(m),M:scoreM(market)};
    for(const key of ['N','S','I']){
      const a=manual[key];
      scores[key]=a&&Number.isInteger(a.score)&&a.score>=0&&a.score<=5&&a.reason?{...a}:{score:2,missing:true,reason:'公开证据不足，保守2分，不以调研参与机构名单冒充持股。'};
    }
    for(const key of ['C','A','L'])scores[key].sourceIds=(stock.sources||[]).filter(x=>key==='C'?x.kind==='q3':key==='A'?['financial','annual'].includes(x.kind):x.kind===(stock.shareClass==='H'?'market_hk':'market')).map(x=>x.id).filter(Boolean);
    const total=KEYS.reduce((sum,k)=>sum+scores[k].score,0);
    return {...stock,scores,total,missingDimensions:KEYS.filter(k=>scores[k].missing)};
  }
  function rate(stock,peerPE){
    const m=stock.metrics||{},s=stock.scores,pe=num(m.peTtm),cash=num(m.cashConversion),gates=[];
    if(stock.missingDimensions.length>1)gates.push('关键维度证据不足');
    if(cash===null||cash<.5)gates.push('现金转化不足50%或待核验');
    if(pe===null||peerPE===null||pe>peerPE*1.3)gates.push('估值高于同组中位数1.3倍或待核验');
    if(s.M.score<3)gates.push('市场趋势未确认');
    if(stock.severeRisk)gates.push(stock.severeRisk);
    const recommended=stock.total>=25&&s.C.score>=4&&s.A.score>=3&&s.N.score>=3&&gates.length===0;
    const rejected=stock.total<20||s.C.score===0||Boolean(stock.severeRisk);
    return {...stock,peerPE,gates,rating:recommended?'推荐':rejected?'不推荐':'中性',ratingKey:recommended?'recommend':rejected?'avoid':'neutral'};
  }
  function prepare(data){
    return {...data,sectors:(data.sectors||[]).map(group=>{
      const items=(group.stocks||[]).map(s=>evaluated({...s,id:'A-'+s.code,securityCode:s.code,shareClass:'A',currency:'CNY'},data.market));
      const peerPE=median(items.map(s=>s.metrics?.peTtm).filter(v=>num(v)>0));
      const stocks=items.map(s=>rate(s,peerPE)).sort((a,b)=>b.total-a.total||(num(a.metrics?.peTtm)??Infinity)-(num(b.metrics?.peTtm)??Infinity)||a.code.localeCompare(b.code));
      const companies=stocks.map(a=>{
        const h=a.hShare,securities=[a];
        if(h?.verified===true&&/^\d{5}$/.test(h.code)){
          const missing=key=>({score:2,missing:true,reason:'未取得'+h.code+' H股的'+(key==='S'?'完整股份供需':'连续机构持仓')+'证据；不沿用A股'+(key==='S'?'回购/解禁':'前十股东')+'结论。'});
          const metrics={...a.metrics,...h.metrics,price:h.price,priceDate:h.priceDate,peTtm:h.peTtm,return126:num(h.metrics?.return126),excess126:num(h.metrics?.excess126),benchmarkName:h.metrics?.benchmarkName||'恒生指数'};
          const combined={...a,id:'H-'+h.code,securityCode:h.code,shareClass:'H',currency:'HKD',metrics,listingDate:h.listingDate,fxCnyPerHkd:h.fxCnyPerHkd,discountToA:h.discountToA,valuationView:h.valuationView,assessments:{N:a.assessments.N,S:h.assessments?.S||missing('S'),I:h.assessments?.I||missing('I')},sources:[...a.sources,...h.sources],marketContext:data.hkMarket};
          securities.push(rate(evaluated(combined,data.hkMarket),peerPE));
        }
        return {code:a.code,name:a.name,securities,bestScore:Math.max(...securities.map(s=>s.total))};
      }).sort((a,b)=>b.bestScore-a.bestScore||a.code.localeCompare(b.code));
      return {...group,peerPE,stocks,companies,securities:companies.flatMap(c=>c.securities)};
    })};
  }
  function valid(data){return data?.schemaVersion===1&&typeof data.asOf==='string'&&data.sectors?.length===2&&data.sectors.every(g=>g.stocks?.length>=5&&g.stocks.length<=10&&g.stocks.every(s=>/^\d{6}$/.test(s.code)&&s.name&&s.metrics&&s.sources?.some(x=>x.kind==='q3')));}
  function sourceLinks(sources){return (sources||[]).filter(s=>/^https:\/\//.test(s.url||'')).map(s=>'<a href="'+esc(s.url)+'" target="_blank" rel="noopener noreferrer">'+esc(s.name||s.title||'来源')+(s.date?' · '+esc(s.date):'')+(s.pages?' · '+esc(s.pages):'')+' ↗</a>').join('');}
  function radar(s){
    const cx=155,cy=135,r=92,point=(i,v)=>{const a=-Math.PI/2+i*2*Math.PI/7;return[cx+Math.cos(a)*r*v/5,cy+Math.sin(a)*r*v/5];};
    const poly=v=>KEYS.map((_,i)=>point(i,v).join(',')).join(' ');
    return '<svg viewBox="0 0 310 285" role="img" aria-label="'+esc(s.name)+' CAN SLIM七维评分，每项五分"><g fill="none" stroke="#d9e3ef">'+[1,2,3,4,5].map(v=>'<polygon points="'+poly(v)+'"/>').join('')+KEYS.map((_,i)=>'<path d="M'+cx+','+cy+' L'+point(i,5).join(',')+'"/>').join('')+'</g><polygon points="'+KEYS.map((k,i)=>point(i,s.scores[k].score).join(',')).join(' ')+'" fill="#2c69a52b" stroke="#27649e" stroke-width="2.5"/>'+KEYS.map((k,i)=>{const p=point(i,6.1);return '<text x="'+p[0]+'" y="'+p[1]+'" text-anchor="middle" dominant-baseline="middle" fill="#304e6c" font-size="14" font-weight="700">'+k+' '+s.scores[k].score+'</text>';}).join('')+'</svg>';
  }
  function growthChart(s){
    const a=(s.metrics.annualDeducted||[]).filter(x=>num(x.value)!==null),min=Math.min(0,...a.map(x=>x.value)),max=Math.max(1,...a.map(x=>x.value)),width=370;
    if(!a.length)return '<p class="cr-muted">年度扣非序列待补，不使用零值绘图。</p>';
    const barWidth=38,gap=width/(a.length+1),y=v=>28+(max-v)/(max-min)*84,base=y(0);
    return '<svg viewBox="0 0 370 155" role="img" aria-label="年度扣非归母净利润，亿元"><line x1="20" y1="'+base+'" x2="355" y2="'+base+'" stroke="#d9e3ef"/>'+a.map((x,i)=>{const h=Math.abs(y(x.value)-base),px=gap*(i+1);return '<rect x="'+(px-barWidth/2)+'" y="'+Math.min(y(x.value),base)+'" width="'+barWidth+'" height="'+h+'" rx="5" fill="'+(x.value>=0?'#4c7ca7':'#488879')+'"/><text x="'+px+'" y="'+(x.value>=0?y(x.value)-8:y(x.value)+14)+'" text-anchor="middle" fill="#28415c" font-size="12" font-weight="700">'+fmt(x.value/1e8,1)+'</text><text x="'+px+'" y="146" text-anchor="middle" fill="#586d81" font-size="12">'+x.year+'</text>';}).join('')+'</svg>';
  }
  function marketChart(m){
    const rows=m.chart||[];if(rows.length<2)return '';
    const vals=rows.flatMap(x=>[x.close,x.ma50,x.ma200]).map(num).filter(x=>x!==null),lo=Math.min(...vals)*.98,hi=Math.max(...vals)*1.02;
    const line=key=>rows.map((x,i)=>num(x[key])===null?'':(i?'L':'M')+(14+i/(rows.length-1)*352).toFixed(1)+','+(122-(x[key]-lo)/(hi-lo)*100).toFixed(1)).join(' ');
    return '<svg viewBox="0 0 380 150" role="img" aria-label="'+esc(m.name||'市场基准')+'最近60交易日收盘及50日200日均线"><path d="'+line('ma200')+'" fill="none" stroke="#a28a60" stroke-width="1.6" stroke-dasharray="5 4"/><path d="'+line('ma50')+'" fill="none" stroke="#7c96b0" stroke-width="1.6" stroke-dasharray="2 3"/><path d="'+line('close')+'" fill="none" stroke="#355e86" stroke-width="2.2"/><text x="14" y="145" font-size="10" fill="#738699">'+esc(rows[0].date)+'</text><text x="366" y="145" text-anchor="end" font-size="10" fill="#738699">'+esc(rows.at(-1).date)+'</text></svg>';
  }
  function marketContext(d){
    return [d.market,d.hkMarket].filter(Boolean).map(m=>{
      const ownScore=scoreM(m),isH=m===d.hkMarket;
      return '<section class="cr-market-context"><div><span class="cr-eyebrow">'+(isH?'H股市场 · 恒生指数':'A股市场 · 中证全指')+' · M '+ownScore.score+' / 5</span><h3>'+(ownScore.score<3?'市场趋势尚待确认':'市场趋势与公司质量交叉验证')+'</h3><p>'+esc(ownScore.reason)+'</p><p>'+(isH?'H股以自身价格、相对恒指走势及港股市场环境独立评价。A/H折价不自动抵消现金、流动性或趋势约束。':'A股以自身价格、相对中证全指走势及A股市场环境独立评价。公司盈利上行不等于市场方向已经转强。')+'</p><div class="cr-source-row">'+sourceLinks([{name:m.name+'历史行情',url:m.sourceUrl,date:d.priceAsOf}])+'</div></div><div class="cr-market-chart">'+marketChart(m)+'<div><span>━ 收盘</span><span>┈ MA50</span><span>┄ MA200</span></div></div></section>';
    }).join('');
  }
  function trendSVG(chart,keys,options={}){
    const rows=chart||[];if(rows.length<2)return '<p class="cr-muted">序列待核验</p>';
    const values=rows.flatMap(r=>keys.map(k=>num(r[k.key]))).filter(v=>v!==null),low=Math.min(options.zero?0:Infinity,...values),high=Math.max(...values),span=Math.max(1,high-low),lo=low-span*.12,hi=high+span*.17;
    const x=i=>48+i/(rows.length-1)*552,y=v=>177-(v-lo)/(hi-lo)*138;
    const ticks=[lo+(hi-lo)*.15,lo+(hi-lo)*.5,lo+(hi-lo)*.85];
    return '<svg viewBox="0 0 630 220" role="img" aria-label="'+esc(options.title||'样本趋势')+'">'+ticks.map(v=>'<line x1="47" x2="600" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#e2e9f0"/><text x="39" y="'+(y(v)+4)+'" text-anchor="end" fill="#75879a" font-size="11">'+fmt(v,0)+(options.percent?'%':'')+'</text>').join('')+keys.map(k=>'<path d="'+rows.map((r,i)=>(i?'L':'M')+x(i).toFixed(2)+','+y(r[k.key]).toFixed(2)).join(' ')+'" fill="none" stroke="'+k.color+'" stroke-width="2.5" '+(k.dash?'stroke-dasharray="6 4"':'')+'/>').join('')+(rows.length<=6?rows.map((r,i)=>keys.map(k=>'<circle cx="'+x(i)+'" cy="'+y(r[k.key])+'" r="3.5" fill="'+k.color+'"/><text x="'+x(i)+'" y="'+(y(r[k.key])+(k.key==='profit'?20:-11))+'" text-anchor="middle" fill="'+k.color+'" font-size="12" font-weight="650">'+fmt(r[k.key],1)+'%</text>').join('')).join(''):'')+[0,Math.floor((rows.length-1)/2),rows.length-1].map(i=>'<text x="'+x(i)+'" y="202" text-anchor="middle" font-size="11" fill="#6c8194">'+esc(rows[i].date||rows[i].label)+'</text>').join('')+'</svg>';
  }
  const api={KEYS,LABELS,num,median,scoreC,scoreA,scoreL,scoreM,evaluated,rate,prepare,valid,radar,growthChart,marketChart,trendSVG};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;
  const root=document.getElementById('canslimRecommendationsRoot'),tab=document.getElementById('tStage');if(!root||!tab)return;
  let data=null,selected={},inflight=null;
  let overviewSelection='optical';
  function customerHTML(r){return '<div class="cr-csp-relations">'+(r.customers||[]).map(x=>'<article><b>'+esc(x.name)+'</b><p>公司指引 / 披露：'+esc(x.fact)+'</p><p>产业解读：'+esc(x.readThrough)+'</p><div class="cr-source-row">'+sourceLinks((r.sources||[]).filter(s=>(x.sourceIds||[]).includes(s.id)))+'</div></article>').join('')+'</div>';}
  function peBasis(s){return s.shareClass==='H'?'PE = H股港币价格 × 人民币/港元汇率 × 全部A+H股本 ÷ 同集团最新TTM归母净利':'PE = A股人民币价格 × 全部A+H股本（如适用）÷ 最新TTM归母净利';}
  function securitySummary(s){
    const m=s.metrics,h=s.hShare;
    return '<section class="cr-security-summary"><div><span>'+esc(s.shareClass==='H'?'H股收盘价':'A股收盘价')+'</span><strong>'+esc(s.currency==='HKD'?'HK$':'¥')+fmt(m.price)+'</strong><small>'+esc(s.securityCode||s.code)+' · '+esc(m.priceDate)+'</small></div><div><span>本股类 PE TTM</span><strong>'+fmt(m.peTtm,1)+'<small>倍</small></strong><small>同集团盈利，不把H股流通市值除全集团利润</small></div>'+(h?'<div><span>H股相对A股价格</span><strong>'+pct(h.relativeToA)+'</strong><small>港币折成人民币；负为折价，正为溢价</small></div>':'')+(s.shareClass==='H'?'<p>'+esc('H股上市 '+s.listingDate+'；汇率 '+fmt(s.fxCnyPerHkd,4)+' 人民币/港元。'+(h.fxNote||'')+' 两市收盘与外汇时刻不完全一致，折溢价不是无风险套利；流动性、税费和交易通道仍需单独评估。')+'</p>':'')+'</section>';
  }
  function overviewHTML(){
    const group=data.sectors.find(g=>g.id===overviewSelection)||data.sectors[0],r=group.outlook;if(!r)return '';
    const sources=ids=>sourceLinks((r.sources||[]).filter(s=>(ids||[]).includes(s.id)));
    const blocks=items=>(items||[]).map(x=>'<article><h5>'+esc(x.title)+'</h5><p>'+esc(x.text)+'</p><div class="cr-source-row">'+sources(x.sourceIds)+'</div></article>').join('');
    const growth=group.industryMetrics||{};
    return '<section class="cr-industry-overview"><div class="cr-overview-title"><div><span class="cr-eyebrow">SECTOR OUTLOOK · DEMAND / SUPPLY / EXPECTATIONS</span><h3>行业趋势与资本开支传导</h3><p>先判断行业，再比较公司与证券价格。未来2–4季度为条件情景，不是确定预测。</p></div><span>研究 '+esc(data.asOf)+'</span></div><div class="cr-overview-tabs" role="tablist" aria-label="行业总览">'+data.sectors.map(g=>'<button role="tab" aria-selected="'+(g.id===group.id)+'" data-outlook-sector="'+esc(g.id)+'">'+esc(g.name)+'<small>'+esc(g.outlook?.sensitivity||'业务敏感性分析')+'</small></button>').join('')+'</div><div class="cr-overview-body" role="tabpanel"><div class="cr-overview-headline"><span class="cr-eyebrow">'+esc(group.name)+' · 行业判断</span><h4>'+esc(r.headline)+'</h4><p>'+esc(r.summary)+'</p></div><div class="cr-industry-kpis"><div><span>样本前三季营收同比</span><b>'+pct(growth.revenueYoy)+'</b></div><div><span>样本前三季扣非利润同比</span><b>'+pct(growth.profitYoy)+'</b></div><div><span>126交易日样本基准超额</span><b>'+fmt(growth.excess126,1)+'<small>个百分点</small></b></div></div><p class="cr-overview-note">'+esc(growth.scopeNote||'代表公司样本，不是全行业统计。')+'</p><div class="cr-industry-charts"><figure><figcaption><b>增长是否加速</b><span>样本合计单季同比 · %</span></figcaption>'+trendSVG(growth.quarters,[{key:'revenue',color:'#2c6ba0'},{key:'profit',color:'#a27e43'}],{title:'代表样本单季度营收和扣非增长',percent:true,zero:true})+'<div class="cr-chart-legend"><span class="revenue">━ 营收同比</span><span class="profit">━ 扣非同比</span></div></figure><figure><figcaption><b>盈利上行 ≠ 股价上行</b><span>起点归零 · 前复权价格收益%</span></figcaption>'+trendSVG(growth.returns,[{key:'sample',color:'#27679b'},{key:'benchmark',color:'#8e9caa',dash:true}],{title:'代表股等权价格收益与中证全指对照',percent:true,zero:true})+'<div class="cr-chart-legend"><span class="revenue">━ 代表股等权</span><span>┄ 中证全指</span></div></figure></div><p class="cr-overview-note">图形为固定样本计算，非官方行业指数、非总回报，不能据此估计未来收益。财务采用公司整体口径，不等于纯AI或对美客户收入。<span class="cr-source-row">'+sourceLinks(growth.sources)+'</span></p><section class="cr-transmission"><div class="cr-transmission-heading"><h4>美国大客户 → 可兑现的产业收入</h4><span>'+esc(r.sensitivity)+'</span></div><div class="cr-flow">'+(r.flow||[]).map((x,i)=>'<div><small>0'+(i+1)+'</small><b>'+esc(x.title)+'</b><p>'+esc(x.text)+'</p></div>').join('')+'</div>'+customerHTML(r)+'<p>'+esc(r.capexNote||'资本开支总量不等于可寻址硬件采购，传导受产品结构、交付、认证、价格与供应份额影响。')+'</p><div class="cr-source-row">'+sources(r.capexSourceIds)+'</div></section><div class="cr-industry-arguments">'+blocks(r.analysis)+'</div><section class="cr-scenarios"><h4>未来2–4季度 · 条件情景</h4><div>'+(r.scenarios||[]).map((x,i)=>'<article class="scenario-'+i+'"><span>'+esc(x.name)+'</span><h5>'+esc(x.outlook)+'</h5><p><b>触发条件</b> '+esc(x.condition)+'</p><p><b>验证 / 失效</b> '+esc(x.check)+'</p><div class="cr-source-row">'+sources(x.sourceIds)+'</div></article>').join('')+'</div><p class="cr-overview-note">上述为研究情景，无概率赋值，不是管理层业绩承诺；没有可复核行业模型时不编造增长区间或目标价。</p></section><section class="cr-monitoring"><h4>重点跟踪的变化参数</h4><div class="cr-monitoring-wrap"><table><thead><tr><th>参数 / 当前证据</th><th>上行确认信号</th><th>风险转折信号</th><th>复核节奏</th></tr></thead><tbody>'+(r.monitoring||[]).map(x=>'<tr><td><b>'+esc(x.parameter)+'</b><p>'+esc(x.baseline)+'</p><div class="cr-source-row">'+sources(x.sourceIds)+'</div></td><td>'+esc(x.upside)+'</td><td>'+esc(x.downside)+'</td><td>'+esc(x.frequency)+'</td></tr>').join('')+'</tbody></table></div></section><details class="cr-industry-sources"><summary>行业研究来源与边界</summary><p>'+esc(r.limitations||'未公开披露的客户名称、采购份额及具体订单金额不作推断；公开规划与已实现业绩分开。')+'</p><div class="cr-source-row">'+sourceLinks(r.sources)+'</div></details></div></section>';
  }
  function detail(s){
    const m=s.metrics;
    return '<article class="cr-detail" data-detail-code="'+esc(s.id||s.code)+'"><div class="cr-detail-heading"><div><span class="cr-eyebrow">公司研究 · '+esc(s.business||'')+'</span><h4>'+esc(s.name)+' <small>'+esc(s.securityCode||s.code)+' · '+esc(s.shareClass)+'股</small></h4><p>'+esc(s.thesis||'')+'</p></div><span class="cr-rating '+s.ratingKey+'">'+s.rating+'</span></div>'+securitySummary(s)+'<div class="cr-detail-layout"><div class="cr-visuals"><div class="cr-radar">'+radar(s)+'<div class="cr-radar-total"><strong>'+s.total+'</strong><span>/ 35</span></div></div><div class="cr-annual"><h5>年度扣非盈利 <span>亿元</span></h5>'+growthChart(s)+'</div></div><div class="cr-evidence"><div class="cr-facts"><div><span>Q3单季扣非同比</span><b>'+pct(m.q3DeductedYoy)+'</b></div><div><span>前三季营收同比</span><b>'+pct(m.ytdRevenueYoy)+'</b></div><div><span>前三季经营现金流</span><b>'+fmt(num(m.ytdOperatingCashFlow)===null?null:m.ytdOperatingCashFlow/1e8)+' <small>亿</small></b></div><div><span>现金流 / 归母净利</span><b>'+pct(num(m.cashConversion)===null?null:m.cashConversion*100)+'</b></div><div><span>PE TTM / A股比较组中位</span><b>'+fmt(m.peTtm,1)+' / '+fmt(s.peerPE,1)+'</b></div><div><span>近半年基准超额</span><b>'+fmt(m.excess126,1)+' <small>百分点</small></b></div></div><p class="cr-formula">财务截至2026-09-30；'+peBasis(s)+'，非预测PE。研究采用截至11月1日已披露信息（含10月30日盘后及10月31日公告），不能视为当日可交易回测。行情 '+esc(m.priceDate||data.priceAsOf)+'。'+esc(s.valuationView||'估值仅作风险约束，不等于合理价值或上涨空间。')+'</p><div class="cr-source-row">'+sourceLinks((s.sources||[]).filter(x=>['q3','financial','market','market_hk','fx','listing'].includes(x.kind)))+'</div></div></div><div class="cr-dimensions">'+KEYS.map(k=>{const a=s.scores[k];return '<section class="cr-dimension"><div><span class="cr-letter">'+k+'</span><strong>'+LABELS[k]+'</strong><b>'+a.score+'<small>/5</small></b>'+(a.missing?'<em>证据待补</em>':'')+'</div><p>'+esc(a.reason)+'</p>'+(a.sourceIds?.length?'<div class="cr-source-row">'+sourceLinks(s.sources.filter(x=>a.sourceIds.includes(x.id)))+'</div>':'')+'</section>';}).join('')+'</div><div class="cr-thesis-grid"><section><h5>为何关注 · 已有证据</h5><p>'+esc(s.whyNow||s.thesis||'')+'</p><p><b>可能的预期差：</b>'+esc(s.variant||'未建立可靠一致预期差，作为持续验证的研究项目，不宣称市场定价错误。')+'</p></section><section class="cr-risk"><h5>首先反证 · 如何失效</h5><ul>'+(s.risks||[]).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><p><b>后续验证：</b>'+esc(s.nextCheck||'下份经营披露核对交付、毛利、应收与经营现金。')+'</p></section></div>'+(s.gates.length?'<div class="cr-gates">评级约束：'+esc(s.gates.join('；'))+'。分数高不自动转为推荐。</div>':'<div class="cr-gates">推荐代表本组当前研究优先级；仍需价格与风险复核，不代表适合任何个人或承诺收益。</div>')+'<details class="cr-documents"><summary>近一个月公告与投资者交流 · '+(s.events||[]).length+'项</summary>'+(s.events||[]).map(e=>'<div class="cr-event"><time>'+esc(e.date)+'</time><div><b>'+esc(e.title)+'</b><p>'+esc(e.fact)+'</p><small>'+esc(e.type==='management'?'管理层表述，非已确认收入或利润承诺':'公司披露 / 研究核对')+'</small><div class="cr-source-row">'+sourceLinks(s.sources.filter(x=>(e.sourceIds||[]).includes(x.id)))+'</div></div></div>').join('')+'<div class="cr-source-row">'+sourceLinks(s.sources.filter(x=>!['q3','financial','market'].includes(x.kind)))+'</div>'+(s.gaps?.length?'<p class="cr-muted">待补证据：'+esc(s.gaps.join('；'))+'</p>':'')+'</details></article>';
  }
  function groupHTML(group){
    const s=group.securities.find(x=>x.id===selected[group.id])||group.securities[0];selected[group.id]=s.id;
    const rows=group.securities.map(x=>{
      const active=x.id===s.id,rank=String(group.companies.findIndex(c=>c.code===x.code)+1).padStart(2,'0');
      const price=(x.currency==='HKD'?'HK$':'¥')+fmt(x.metrics.price);
      const scores=KEYS.map(k=>'<td><span class="cr-score level-'+x.scores[k].score+(x.scores[k].missing?' is-missing':'')+'" title="'+esc(x.scores[k].reason)+'">'+x.scores[k].score+(x.scores[k].missing?'*':'')+'</span></td>').join('');
      return '<tr class="'+(active?'is-selected ':'')+(x.shareClass==='H'?'is-hshare':'')+'" data-stock="'+esc(x.id)+'"><td><button data-select-stock="'+esc(x.id)+'" aria-pressed="'+active+'"><span class="cr-rank">'+rank+'</span><span><b>'+esc(x.name)+' <em class="cr-share-class">'+x.shareClass+'股</em></b><small>'+esc(x.securityCode)+' · '+esc(x.businessShort||'')+'</small></span></button></td><td><b class="cr-list-price">'+price+'</b><small>'+esc(x.metrics.priceDate)+'</small>'+(x.shareClass==='H'?'<small>较A '+pct(x.hShare.relativeToA)+'</small>':'')+'</td><td><div class="cr-total"><b>'+x.total+'<small>/35</small></b><i><u style="width:'+x.total/35*100+'%"></u></i><span class="cr-rating '+x.ratingKey+'">'+x.rating+'</span></div></td>'+scores+'<td>'+pct(x.metrics.q3DeductedYoy)+'</td><td>'+fmt(x.metrics.peTtm,1)+'<small>倍 · A组中位 '+fmt(group.peerPE,1)+'</small></td></tr>';
    }).join('');
    return '<section class="cr-sector" data-sector="'+esc(group.id)+'"><div class="cr-sector-heading"><div><span class="cr-eyebrow">'+esc(group.en||'SECTOR RESEARCH')+'</span><h3>'+esc(group.name)+'</h3><p>'+esc(group.summary||'')+'</p></div><div class="cr-sector-count"><strong>'+group.stocks.length+'</strong><span>家公司 · '+group.securities.length+'只证券</span></div></div><div class="cr-sector-thesis">'+(group.drivers||[]).map(x=>'<div><b>'+esc(x.title)+'</b><p>'+esc(x.text)+'</p><div class="cr-source-row">'+sourceLinks(x.sources)+'</div></div>').join('')+'</div><div class="cr-table-wrap" tabindex="0" aria-label="'+esc(group.name)+'评分排序表"><table class="cr-table"><thead><tr><th>排名 / 公司</th><th>收盘价 / 币种</th><th>总分 / 评级</th>'+KEYS.map(k=>'<th title="'+LABELS[k]+'">'+k+'<small>'+LABELS[k]+'</small></th>').join('')+'<th>Q3扣非同比</th><th>PE TTM</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="cr-table-hint">公司按其最高证券得分排序，A/H两行相邻比较；每行独立使用本地价格、估值和走势。点击名称查看证据。* 为证据不足记2分。PE比较锚为本组6家A股中位数，不冒充H股市场公允估值。</p><div class="cr-selected-detail">'+detail(s)+'</div>'+(group.note?'<p class="cr-sector-note">'+esc(group.note)+'</p>':'')+'</section>';
  }
  function render(){
    const all=data.sectors.flatMap(g=>g.securities),counts=Object.fromEntries(['推荐','中性','不推荐'].map(k=>[k,all.filter(s=>s.rating===k).length]));
    root.innerHTML='<div class="cr-module"><header class="cr-hero"><div><span class="cr-eyebrow">EVIDENCE → GROWTH → PRICE DISCIPLINE</span><h2>最新标的推荐</h2><p>光模块 × PCB与材料 · 2026三季报深度研究</p><div class="cr-asof">研究 '+esc(data.asOf)+' · 近月公告 '+esc(data.windowStart)+'—'+esc(data.asOf)+' · 行情 '+esc(data.priceAsOf)+'</div></div><div class="cr-hero-score"><strong>35</strong><span>CAN SLIM 总分</span><small>7个维度 × 每项5分</small></div></header><div class="cr-snapshot"><div><span>覆盖样本</span><strong>'+data.sectors.reduce((sum,g)=>sum+g.stocks.length,0)+'<small>家公司 / '+all.length+'只证券</small></strong></div><div><span>推荐 · 深入跟踪</span><strong>'+counts.推荐+'<small>只证券</small></strong></div><div><span>中性 · 条件待验证</span><strong>'+counts.中性+'<small>只证券</small></strong></div><div><span>不推荐 · 当前证据</span><strong>'+counts.不推荐+'<small>只证券</small></strong></div></div><p class="cr-disclaimer">研究评级不是个性化投资建议，也不是买卖指令。评分采用同集团扣非盈利本地化口径；A/H采用各自价格、走势和市场环境；L采用基准超额代理，不冒称全市场RPS。样本为代表公司而非全行业筛选；未覆盖不等于不推荐。</p>'+'<div id="crIndustryOverviewSlot">'+overviewHTML()+'</div>'+marketContext(data)+data.sectors.map(groupHTML).join('')+'<details class="cr-method"><summary>评分方法、评级门槛与研究边界</summary><div class="cr-method-grid">'+(data.methodology||[]).map(x=>'<section><b>'+esc(x.title)+'</b><p>'+esc(x.text)+'</p></section>').join('')+'</div><p>总分≥25，且C≥4、A≥3、N≥3，并通过现金、估值、市场与证据约束，标为“推荐”；总分&lt;20、C=0或存在明确重大风险，标为“不推荐”；其余“中性”。估值门槛：PE不高于本组6家A股正PE中位数的1.3倍；现金门槛：前三季经营现金流/归母净利≥50%。这些是本次研究设定，不是威廉·欧奈尔原版买点规则，也不保证收益。</p><p>数据与观点为定时点研究，不随实时股价自动改变；新增财报、回购/减持、融资、产能兑现及股价大幅变化后应复核。机构缺失不以调研名单替代，未建立一致预期模型，不给目标价或上涨空间。</p><div class="cr-source-row">'+sourceLinks(data.sources)+'</div></details></div>';
  }
  root.addEventListener('click',event=>{const tabButton=event.target.closest('[data-outlook-sector]');if(tabButton){overviewSelection=tabButton.dataset.outlookSector;document.getElementById('crIndustryOverviewSlot').innerHTML=overviewHTML();return;}const button=event.target.closest('[data-select-stock]');if(!button)return;const section=button.closest('[data-sector]'),id=section.dataset.sector;selected[id]=button.dataset.selectStock;const group=data.sectors.find(x=>x.id===id),stock=group.securities.find(x=>x.id===selected[id]);section.querySelectorAll('[data-stock]').forEach(row=>{const active=row.dataset.stock===stock.id;row.classList.toggle('is-selected',active);row.querySelector('button').setAttribute('aria-pressed',String(active));});section.querySelector('.cr-selected-detail').innerHTML=detail(stock);});
  async function load(){
    if(data||inflight)return inflight;
    inflight=(async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const response=await fetch('data/canslim_recommendations.json?v=20261101b',{signal:controller.signal,cache:'no-cache'});if(!response.ok)throw Error('HTTP '+response.status);const candidate=await response.json();if(!valid(candidate))throw Error('研究数据不完整');data=prepare(candidate);render();}catch(e){root.innerHTML='<div class="cr-load-error">最新标的研究暂未加载成功。<button type="button" id="crRetry">重新加载</button></div>';root.querySelector('#crRetry')?.addEventListener('click',load);console.warn('[CAN SLIM研究]',e.message);}finally{clearTimeout(timer);inflight=null;}})();return inflight;
  }
  const observer=new MutationObserver(()=>{if(tab.classList.contains('active'))load();});observer.observe(tab,{attributes:true,attributeFilter:['class']});
  if(tab.classList.contains('active'))load();
  global.CanslimRecommendations={load,getData:()=>data};
})(typeof window==='undefined'?globalThis:window);
