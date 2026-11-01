/* Public-evidence monitor. Perez positioning is a disclosed heuristic, not a dated prediction. */
(function(global){
 'use strict';
 const n=v=>typeof v!=='boolean'&&v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
 const clamp=(v,lo=0,hi=100)=>Math.min(hi,Math.max(lo,v));
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=(v,d=1)=>n(v)===null?'证据待补':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d});
 const pct=v=>n(v)===null?'不可比':(v>0?'+':'')+fmt(v)+'%';
 const median=a=>{a=a.map(n).filter(x=>x!==null).sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:null;};
 const mean=a=>{a=a.map(n).filter(x=>x!==null);return a.length?a.reduce((v,x)=>v+x,0)/a.length:null;};
 const recent=(a,sortKey='effectiveDate')=>[...(a||[])].sort((x,y)=>String(x[sortKey]).localeCompare(String(y[sortKey]))||String(x.disclosedAt).localeCompare(String(y.disclosedAt))).at(-1);
 function valid(d){return d?.schemaVersion===1&&Array.isArray(d.series)&&d.series.length>=6&&d.series.every(s=>s.id&&['hyperscaler','neocloud','arr'].includes(s.group)&&Array.isArray(s.observations))&&Array.isArray(d.sources);}
 function annualGrowth(s){
  const guide=recent(s.observations.filter(x=>x.type==='guidance'));
  if(!guide)return null;
  const year=Number(String(guide.period).match(/^CY(20\d{2})$/)?.[1]),prior=recent(s.observations.filter(x=>x.type==='actual'&&x.period==='CY'+(year-1)));
  if(!prior||s.comparable===false||guide.comparable===false||prior.comparable===false||guide.basisKey!==prior.basisKey||!(prior.valueUsdB>0))return null;
  return {id:s.id,name:s.name,growth:(guide.valueUsdB/prior.valueUsdB-1)*100,from:prior.period,to:guide.period,fromValue:prior.valueUsdB,toValue:guide.valueUsdB,note:'本年指引中点相对上年实际，非已实现同比',sourceIds:[prior.sourceId,guide.sourceId]};
 }
 function runRateGrowth(s){
  const points=s.observations.filter(x=>x.type==='run_rate'),last=recent(points);if(!last)return null;
  const baseline=recent(points.filter(x=>x.effectiveDate<last.effectiveDate&&x.effectiveDate.startsWith(String(Number(last.effectiveDate.slice(0,4))-1))));
  if(!baseline||s.comparable===false||last.comparable===false||baseline.comparable===false||baseline.basisKey!==last.basisKey||!(baseline.valueUsdB>0))return null;
  return {id:s.id,name:s.name,growth:(last.valueUsdB/baseline.valueUsdB-1)*100,from:baseline.effectiveDate,to:last.effectiveDate,note:'相对上年末已披露里程碑，非严格同期同比',sourceIds:[baseline.sourceId,last.sourceId]};
 }
 function periodEnd(row){
  const date=String(row.effectiveDate||row.date||'');if(/^20\d{2}-\d{2}-\d{2}$/.test(date))return date;
  const period=String(row.period||''),year=period.match(/20\d{2}/)?.[0];if(!year)return '';
  const quarter=period.match(/Q([1-4])/),half=period.match(/H([12])/),month=quarter?Number(quarter[1])*3:half?Number(half[1])*6:/(?:FY|CY)/.test(period)?12:null;
  if(!month)return '';return new Date(Date.UTC(Number(year),month,0)).toISOString().slice(0,10);
 }
 function cashEvidence(d){
  const sourceMap=new Map((d.sources||[]).map(x=>[x.id,x])),asOf=Date.parse(d.asOf),rows=(d.riskMetrics||[]).filter(x=>x.companyId&&n(x.value)!==null).map(x=>{const effectiveDate=periodEnd(x),disclosedAt=x.disclosedAt||x.sourceDate||(x.sourceIds||[]).map(id=>sourceMap.get(id)?.date||'').sort().at(-1)||'',ageDays=effectiveDate?Math.floor((asOf-Date.parse(effectiveDate))/86400000):null;return {...x,effectiveDate,disclosedAt,ageDays,fresh:ageDays!==null&&ageDays>=0&&ageDays<=210&&!!disclosedAt&&disclosedAt<=d.asOf};});
  const profit=rows.filter(x=>['gaap_net_loss','net_loss_continuing_operations','gaap_operating_margin_pct','gaap_net_income'].includes(x.metric)),cash=rows.filter(x=>x.metric==='simple_operating_cash_flow_less_cash_capex');
  const latestPerCompany=a=>[...new Map([...a].sort((x,y)=>x.effectiveDate.localeCompare(y.effectiveDate)||x.disclosedAt.localeCompare(y.disclosedAt)).map(x=>[x.companyId,x])).values()];
  const p=latestPerCompany(profit),c=latestPerCompany(cash),freshP=p.filter(x=>x.fresh),freshC=c.filter(x=>x.fresh),profitScore=freshP.length?freshP.filter(x=>x.value>=0).length/freshP.length*100:null,cashScore=freshC.length?freshC.filter(x=>x.value>=0).length/freshC.length*100:null;
  return {score:mean([profitScore,cashScore]),profitPositive:freshP.filter(x=>x.value>=0).length,profitCount:freshP.length,cashPositive:freshC.filter(x=>x.value>=0).length,cashCount:freshC.length,stale:p.length+c.length>freshP.length+freshC.length,rows:[...p.map(x=>({...x,evidenceType:'profit'})),...c.map(x=>({...x,evidenceType:'cash'}))]};
 }
 function model(d){
  const construction=d.series.filter(s=>s.group==='hyperscaler').map(annualGrowth).filter(Boolean),neo=d.series.filter(s=>s.group==='neocloud').map(annualGrowth).filter(Boolean),arr=d.series.filter(s=>s.group==='arr').map(runRateGrowth).filter(Boolean);
  const cloud=d.commercialEvidence?.cloudRevenue?.companies||{},cloudGrowth=Object.values(cloud).map(c=>n(c.latest_yoy_pct??c.latest_yoy??c.latest?.yoy_pct??c.quarters?.at(-1)?.yoy_pct)).filter(v=>v!==null);
  const inputs=[{id:'hyperscaler',name:'云厂商建设强度',weight:35,growth:median(construction.map(x=>x.growth)),items:construction,denominator:100},{id:'neocloud',name:'Neocloud扩张强度',weight:25,growth:median(neo.map(x=>x.growth)),items:neo,denominator:150},{id:'arr',name:'模型公司商业化增长',weight:30,growth:median(arr.map(x=>x.growth)),items:arr,denominator:200},{id:'cloud',name:'云业务变现佐证',weight:10,growth:median(cloudGrowth),items:[],denominator:50}];
  for(const x of inputs)x.score=x.growth===null?null:clamp(x.growth/x.denominator*100);
  const available=inputs.filter(x=>x.score!==null),weight=available.reduce((v,x)=>v+x.weight,0),heat=weight?Math.round(available.reduce((v,x)=>v+x.score*x.weight,0)/weight):null;
  const commercial=mean(inputs.filter(x=>['arr','cloud'].includes(x.id)).map(x=>x.score)),cash=cashEvidence(d),growth=median(construction.map(x=>x.growth));
  const latestArr=d.series.filter(s=>s.group==='arr').map(s=>recent(s.observations.filter(o=>o.type==='run_rate'))).filter(Boolean),maxArr=latestArr.length?Math.max(...latestArr.map(x=>x.valueUsdB)):null;
  let phase=1,reason='建设强度高、商业化快速增长，但样本盈利与现金回报尚未共同确认，倾向安装期的狂热阶段。';
  const maturityYears=n(d.commercialEvidence?.matureEvidenceYears)||0;
  if(weight<60){phase=null;reason='可用指标权重不足60%，不足以定位阶段；保留证据，不用缺失值补零。';}
  else if(heat!==null&&heat<30&&commercial!==null&&commercial<35&&maxArr!==null&&maxArr<2){phase=0;reason='建设与商业化尚小，偏向技术爆发、早期验证；仍需观察持续付费和基础设施落地。';}
  else if(((commercial??0)>=65||(maturityYears>=2&&maxArr>=2&&(median(cloudGrowth)??-1)>=0))&&(cash.score??0)>=65&&cash.profitCount>=2&&cash.cashCount>=2){
   if((growth??Infinity)<=15&&(inputs[2].growth??Infinity)<=20&&maturityYears>=2){phase=3;reason='变现和现金纪律稳定、增长趋缓且有至少两年成熟证据，类比部署期的成熟阶段。';}
   else{phase=2;reason='持续商业化与样本盈利、现金回报形成共振，类比部署期的协同阶段；仍需制度和跨行业生产率证据确认。';}
  }
  const labels=['爆发 Irruption','狂热 Frenzy','协同 Synergy','成熟 Maturity'];
  const local=phase===0?clamp((heat||0)/100,.1,.9):phase===1?clamp(((heat||0)*.45+(commercial||0)*.35+(100-(cash.score??50))*.2)/100,.1,.9):phase===2?clamp(((commercial||0)+(cash.score||0))/200,.1,.9):.55;
  const position=phase===null?null:(phase+(.15+local*.7))/4;
  const stale=cash.stale||latestArr.some(x=>(Date.parse(d.asOf)-Date.parse(x.effectiveDate))/86400000>90),confidence=weight===100&&cash.profitCount>=2&&cash.cashCount>=2&&!stale?'中等':'中低 / 部分证据滞后';
  return {heat,weight,inputs,commercial,cash,phase,position,label:phase===null?'证据不足':labels[phase],period:phase===null?'暂不定位':phase<2?'安装期 Installation':'部署期 Deployment',reason,confidence,turningRisk:(growth!==null&&growth<0&&(cash.score??0)<35),stale};
 }
 function links(d,ids){return(d.sources||[]).filter(s=>(ids||[]).includes(s.id)&&/^https:\/\//.test(s.url)).map(s=>'<a href="'+esc(s.url)+'" target="_blank" rel="noopener noreferrer">'+esc(s.name||s.id)+' · '+esc(s.datePrecision==='year'?String(s.date).slice(0,4):s.date)+' ↗</a>').join('');}
 const COLORS=['#32699a','#8f7350','#4e8c80','#8578a5'];
 function comparableSegment(series,a,b){return series.comparable!==false&&a.comparable!==false&&b.comparable!==false&&!!a.basisKey&&a.basisKey===b.basisKey;}
 function metricChart(series){
  if(!series.length)return '';
  const numeric=o=>n(o.valueUsdB)!==null&&o.valueUsdB>0&&Number.isFinite(Date.parse(o.effectiveDate)),isArr=series[0].group==='arr',all=series.flatMap(s=>s.observations).filter(numeric);if(!all.length)return '<p class="aic-chart-empty">暂无可用的已核验数值；不以零替代缺失数据。</p>';
  const max=Math.max(1,...all.map(o=>o.highUsdB??o.valueUsdB)),minDate=Math.min(...all.map(o=>Date.parse(o.effectiveDate))),maxDate=Math.max(...all.map(o=>Date.parse(o.effectiveDate))),years=[...new Set(all.map(o=>o.period))].sort();
  const x=o=>isArr?49+(Date.parse(o.effectiveDate)-minDate)/Math.max(1,maxDate-minDate)*600:49+Math.max(0,years.indexOf(o.period))/Math.max(1,years.length-1)*600,y=v=>216-v/max*169;
  let svg='<svg viewBox="0 0 710 265" role="img" aria-label="'+(isArr?'年化收入运行率里程碑，十亿美元':'各公司资本开支实际及指引，十亿美元')+'">';
  for(let i=0;i<=3;i++){const v=max*i/3;svg+='<line x1="48" x2="660" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#e1e8ef"/><text x="39" y="'+(y(v)+4)+'" text-anchor="end" font-size="11" fill="#7c8d9e">'+fmt(v,0)+'</text>';}
  series.forEach((s,i)=>{const points=[...s.observations].filter(numeric).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate));const color=COLORS[i%COLORS.length];for(let j=1;j<points.length;j++){const a=points[j-1],b=points[j];if(!comparableSegment(s,a,b))continue;svg+='<path class="aic-data-segment" d="M'+x(a)+','+y(a.valueUsdB)+' L'+x(b)+','+y(b.valueUsdB)+'" stroke="'+color+'" stroke-width="2.5" fill="none" '+(b.type==='guidance'?'stroke-dasharray="6 4"':'')+'/>';}
   points.forEach(o=>{svg+='<circle cx="'+x(o)+'" cy="'+y(o.valueUsdB)+'" r="'+(o.type==='guidance'?4.5:3.2)+'" fill="'+(o.type==='guidance'?'#fff':color)+'" stroke="'+color+'" stroke-width="1.8"><title>'+esc(s.name+' '+o.period+' '+fmt(o.valueUsdB,2)+' USD bn · '+o.type+' · 披露 '+o.disclosedAt+(o.note?' · '+o.note:''))+'</title></circle>';if(o.lowUsdB!==null&&o.lowUsdB!==undefined&&o.highUsdB>o.lowUsdB)svg+='<path d="M'+x(o)+','+y(o.lowUsdB)+' V'+y(o.highUsdB)+'" stroke="'+color+'" stroke-width="2"/>';});
  });
  const labels=isArr?[{text:new Date(minDate).toISOString().slice(0,7),x:49},{text:new Date(maxDate).toISOString().slice(0,7),x:649}]:years.map((text,i)=>({text,x:49+i/Math.max(1,years.length-1)*600}));
  return svg+labels.map(o=>'<text x="'+o.x+'" y="244" text-anchor="middle" font-size="11" fill="#708397">'+esc(o.text)+'</text>').join('')+'</svg>';
 }
 function stageSVG(m){
  const x=m.position===null?null:72+m.position*930,curve=v=>235-150/(1+Math.exp(-9*(v-.5))),y=m.position===null?null:curve(m.position);
  return '<svg viewBox="0 0 1080 330" role="img" aria-label="佩蕾斯两大时期四阶段示意，当前启发式定位'+esc(m.label)+'"><rect x="55" y="26" width="488" height="240" rx="14" fill="#eaf2fa"/><rect x="555" y="26" width="470" height="240" rx="14" fill="#edf5ef"/><text x="292" y="54" text-anchor="middle" fill="#426e94" font-size="16" font-weight="700">安装期 · 金融资本推动建设</text><text x="790" y="54" text-anchor="middle" fill="#537b5f" font-size="16" font-weight="700">部署期 · 生产资本与广泛应用</text><path d="M72,'+curve(0)+' '+Array.from({length:101},(_,i)=>'L'+(72+i*9.3).toFixed(1)+','+curve(i/100).toFixed(1)).join(' ')+'" fill="none" stroke="#60829f" stroke-width="4"/>'+[0,1,2,3].map((k)=>'<text x="'+(185+k*233)+'" y="294" text-anchor="middle" fill="#4c657c" font-size="16" font-weight="650">'+['① 爆发','② 狂热','③ 协同','④ 成熟'][k]+'</text><text x="'+(185+k*233)+'" y="316" text-anchor="middle" fill="#8b9ba9" font-size="11">'+['Irruption','Frenzy','Synergy','Maturity'][k]+'</text>').join('')+'<path d="M550,75 V268" stroke="#b69970" stroke-width="1.5" stroke-dasharray="5 5"/><text x="550" y="91" text-anchor="middle" fill="#9a7a4d" font-size="11">转折 / 制度调整</text>'+(x===null?'':'<path d="M'+x+','+(y+11)+' V267" stroke="#b67e40" stroke-width="1.6" stroke-dasharray="4 4"/><circle class="aic-phase-halo" cx="'+x+'" cy="'+y+'" r="17" fill="#bd8c4b21"/><circle cx="'+x+'" cy="'+y+'" r="7" fill="#b78545" stroke="#fff" stroke-width="3"/><rect x="'+(x-84)+'" y="'+(y-48)+'" width="168" height="29" rx="8" fill="#294b68"/><text x="'+x+'" y="'+(y-29)+'" text-anchor="middle" fill="#fff" font-size="12" font-weight="650">当前参考位置 · '+['爆发','狂热','协同','成熟'][m.phase]+'</text>')+'</svg>';
 }
 const api={n,median,mean,annualGrowth,runRateGrowth,periodEnd,cashEvidence,model,comparableSegment,metricChart,stageSVG,valid};if(typeof module!=='undefined'&&module.exports)module.exports=api;
 if(typeof document==='undefined')return;
 const root=document.getElementById('aiCycleMonitorRoot'),tab=document.getElementById('tStage');if(!root||!tab)return;
 let data=null,lastFetch=0,inflight=null;
 function cashHTML(m){
  if(!m.cash.rows.length)return '<p class="aic-cash-empty">尚无可用的样本盈利与现金证据，不以融资额、订单储备或调整后利润替代。</p>';
  return '<div class="aic-cash-grid">'+m.cash.rows.map(row=>{const name=row.company||row.companyName||data.series.find(s=>s.companyId===row.companyId)?.name||row.companyId,label=row.evidenceType==='cash'?'经营现金 − 现金购置资产':row.metric==='gaap_operating_margin_pct'?'GAAP经营利润率':'GAAP净损益',unit=row.unit==='%'?'%':'十亿美元';return '<article><span>'+esc(name)+' · '+label+'</span><b class="'+(row.value<0?'aic-negative':'aic-positive')+'">'+(row.value>0?'+':'')+fmt(row.value,unit==='%'?1:3)+'<small>'+unit+'</small></b><p>'+esc(row.period||row.effectiveDate)+' · 披露 '+esc(row.disclosedAt||'日期待核')+(row.fresh?'':' · 过期或日期待核，不参与阶段确认')+'</p>'+(row.note?'<p>'+esc(row.note)+'</p>':'')+'<div class="aic-source">'+links(data,row.sourceIds)+'</div></article>';}).join('')+'</div>';
 }
 function groupHTML(group,title,sub){
  const series=data.series.filter(s=>s.group===group);
  return '<section class="aic-panel"><div class="aic-panel-heading"><div><h3>'+title+'</h3><p>'+sub+'</p></div><span>USD billion · 十亿美元</span></div><div class="aic-chart">'+metricChart(series)+'</div><div class="aic-legend">'+series.map((s,i)=>'<span style="--line:'+COLORS[i%COLORS.length]+'"><i></i>'+esc(s.name)+'</span>').join('')+'<small>实线● 实际 / 运行率 · 虚线○ 指引区间 · 不可比口径不连线</small></div><div class="aic-metric-grid">'+series.map(s=>{const o=recent(s.observations),age=o?(Date.parse(data.asOf)-Date.parse(o.type==='run_rate'?o.effectiveDate:o.disclosedAt))/86400000:null;return '<article><div><b>'+esc(s.name)+'</b><span>'+esc(o?.type==='guidance'?'全年指引':o?.type==='run_rate'?'运行率里程碑':'历史实际')+'</span></div><strong>'+(o?.lowUsdB!==null&&o?.highUsdB!==null&&o?.lowUsdB!==o?.highUsdB?fmt(o.lowUsdB)+'–'+fmt(o.highUsdB):fmt(o?.valueUsdB))+'<small>十亿美元</small></strong><p>'+esc(o?.period||'待核验')+(o?.type==='guidance'?' · 目标期末 ':' · 观察 ')+esc(o?.effectiveDate||'')+' · 披露 '+esc(o?.disclosedAt||'')+(age>90?' · 数据有滞后':'')+'</p><p class="aic-definition">'+esc(s.basis||s.metric||'')+'</p>'+(s.comparable===false?'<em>口径不可直接同比</em>':'')+'<div class="aic-source">'+links(data,[o?.sourceId])+'</div></article>';}).join('')+'</div></section>';
 }
 function render(){
  const m=model(data),heat=m.heat===null?'—':m.heat,weak=m.weight<100;
  root.innerHTML='<div class="aic-module"><header class="aic-hero"><div><span class="aic-eyebrow">AI CYCLE OBSERVATORY · BUILDOUT / MONETIZATION / CAPITAL DISCIPLINE</span><h2>AI行业趋势综述</h2><p>美国AI领头羊的需求与投资，是国内算力、光互连、PCB、材料和数据中心链条的重要外部驱动。预算必须经过架构选择、订单、交付、利润和现金，才能兑现为股东回报。</p><div class="aic-meta">有效证据更新 '+esc(data.updatedAt||data.asOf)+' · 最近扫描 '+esc(data.lastChecked||'')+' · 每3小时后台扫描，页面异步补读</div></div><div class="aic-heat" style="--heat:'+heat+'"><span>AI产业链热度</span><strong>'+heat+'<small>/100</small></strong><b>'+(m.heat===null?'可用证据不足':m.heat>=75?'建设与变现高热度':m.heat>=45?'扩张 / 分化':'低增速 / 分化')+'</b><small>热度 ≠ 回报 · 非泡沫概率</small></div></header><div class="aic-caution">研究观察，不构成个性化投资建议。公司总体Capex不是纯AI支出，ARR是年化运行率而非全年收入；不同公司会计口径不完全一致，不能将曲线简单相加。</div><div class="aic-flow">'+[['模型商业化','付费使用、运行率、单位经济'],['CSP / Neocloud投资','服务器、网络、电力与上电'],['国内产业链订单','供应资格、技术路径与交付'],['利润与现金兑现','毛利、回款、融资和估值']].map((x,i)=>'<div><small>0'+(i+1)+'</small><b>'+x[0]+'</b><span>'+x[1]+'</span></div>').join('')+'</div><section class="aic-stage"><div class="aic-stage-heading"><div><span class="aic-eyebrow">PEREZ FRAMEWORK · 2 PERIODS / 4 PHASES</span><h3>'+esc(m.period)+' · '+esc(m.label)+'</h3><p>'+esc(m.reason)+'</p></div><div><b>判断置信度</b><span>'+esc(m.confidence)+'</span></div></div>'+stageSVG(m)+'<p class="aic-stage-note">曲线只是技术扩散示意，标记是公开规则下的类比位置，不是历史周期完成百分比、作者对本轮AI的官方判断或泡沫破裂倒计时。新有效数据可使位置前移或后退；跨阶段需商业化与现金回报共同验证，不能仅因Capex增长就自动进入协同。转折点是调整区间，不是第五个小阶段。</p><div class="aic-factor-grid">'+m.inputs.map(x=>'<article><div><b>'+x.name+'</b><span>权重 '+x.weight+'%</span></div><strong>'+fmt(x.score,0)+'<small>/100</small></strong><i><u style="width:'+(x.score??0)+'%"></u></i><p>'+(['hyperscaler','neocloud'].includes(x.id)?'可比公司：本年指引 vs 上年实际中位变化 ':x.id==='arr'?'同公司最新里程碑 vs 上年末变化 ':'公司口径云业务最新同比 ')+pct(x.growth)+'</p></article>').join('')+'</div><div class="aic-discipline"><b>建设与资本纪律的张力</b><p>已知样本盈利正例 '+m.cash.profitPositive+'/'+m.cash.profitCount+'；简化经营现金减现金购置资产为正 '+m.cash.cashPositive+'/'+m.cash.cashCount+'。这是有限样本，不代表所有AI企业。ARR增长与预收款不能替代持续GAAP盈利、自由现金和生产率证据。'+(weak?'可用热度权重 '+m.weight+'%，只对已有指标重新归一化，缺失不计零。':'')+'</p>'+cashHTML(m)+(m.turningRisk?'<p class="aic-turning-risk">调整风险提示：可比建设指引开始收缩，样本现金回报仍弱。提示资本再配置压力，不等于确认已经跨越佩蕾斯转折点。</p>':'')+'</div><details class="aic-rules"><summary>阶段位置和热度如何随数据变化</summary><p>热度：四组指标分别按35/25/30/10权重；建设同比除以100%、Neocloud除以150%、运行率增幅除以200%、云收入增幅除以50%，各映射0–100并截断。口径不可比公司不进入增长分；这只是监测尺度，不是产业投资份额。运行率增幅以各自上年末为基准，不冒称严格同比。</p><p>爆发：热度&lt;30、商业化&lt;35且模型运行率规模仍小。协同：商业化≥65且样本盈利/现金正例综合≥65，并分别有至少两家公司证据。成熟：可比建设增速≤15%、运行率增幅≤20%，至少两年经核验的成熟证据、已形成规模的运行率与非负云业务增速，并继续满足盈利/现金证据条件。低增长本身不代表成熟。其余已有大规模建设、回报未匹配时归为狂热。缺少足够权重则暂不定位；超过210天或日期不明的财务样本不参与阶段确认。协同/成熟不凭融资额或订单储备自动确认。</p><p>本次行业判断以美国需求为主线，但不设未经证实的“美国/国产替代固定占比”。国内替代、出口规则、认证、汇率及供应份额会改变具体公司的受益程度。高行业热度也可能与A股/港股价格弱势同时存在。</p><div class="aic-source">'+links(data,['perez-book','perez-preface'])+'</div></details></section>'+groupHTML('hyperscaler','Hyperscaler资本开支趋势','四家公司各自口径；2026为最新全年指引，不当作实际支出，不计算混合总额同比')+groupHTML('neocloud','Neocloud资本开支趋势','CoreWeave与Nebius为代表样本，非全行业；现金、租赁、在建工程定义不同')+groupHTML('arr','OpenAI / Anthropic年化运行率','离散的已披露里程碑，不作月度插值；预测与季度实收不混入曲线')+'<section class="aic-panel aic-quality"><h3>变化、证据与下一步确认</h3><div class="aic-evidence-grid">'+(data.notes||[]).map(x=>'<article><b>'+esc(x.title||'口径与变化')+'</b><p>'+esc(x.text||x)+'</p><div class="aic-source">'+links(data,x.sourceIds)+'</div></article>').join('')+'</div><details class="aic-rules"><summary>全部来源、观测定义与修正记录</summary><div class="aic-source">'+links(data,data.sources.map(x=>x.id))+'</div><p>缺少新发布不等于数据为零。后台扫描无法可靠解析时保留上次已核验值；扫描时间不等于数据观察期。阶段定位在每次有效快照载入后重新计算。</p>'+(data.quality?.issues?.length?'<p>本次扫描保留意见：'+esc(data.quality.issues.join('；'))+'</p>':'')+'</details></section></div>';
 }
 async function refresh(force=false){
  if(inflight||(!force&&Date.now()-lastFetch<60000))return inflight;
  inflight=(async()=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),14000);try{const r=await fetch('data/ai_cycle.json?_='+Date.now(),{cache:'no-store',signal:c.signal});if(!r.ok)throw Error('HTTP '+r.status);const next=await r.json();if(!valid(next))throw Error('快照证据不足');if(data&&next.updatedAt<data.updatedAt)return;data=next;lastFetch=Date.now();render();}catch(e){if(!data)root.innerHTML='<div class="aic-load">AI行业趋势证据正在准备，稍后可重新进入本页。不会将缺失值当作行业降温。</div>';console.warn('[AI行业周期]',e.message);}finally{clearTimeout(t);inflight=null}})();return inflight;
 }
 new MutationObserver(()=>{if(tab.classList.contains('active'))refresh(false)}).observe(tab,{attributes:true,attributeFilter:['class']});
 setInterval(()=>{if(tab.classList.contains('active')&&!document.hidden)refresh(false)},60000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab.classList.contains('active'))refresh(false)});
 global.AICycleMonitor={refresh,getData:()=>data,getModel:()=>data?model(data):null};if(tab.classList.contains('active'))refresh(false);
})(typeof window==='undefined'?globalThis:window);
