/* Validated, asynchronous presentation of the composite A-share temperature. */
(function(global){
  'use strict';
  const CACHE_KEY='aiDashboard.marketHeat.v1';
  const URLS=['./data/market_heat.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/market_heat.json'];
  const ZONES=[{limit:20,label:'低温',color:'#58799e',soft:'#eaf0f7'},{limit:40,label:'偏冷',color:'#527f89',soft:'#eaf3f3'},{limit:60,label:'适中',color:'#8d7c46',soft:'#f5f1e5'},{limit:80,label:'偏热',color:'#b06d35',soft:'#fbefe1'},{limit:100,label:'高温',color:'#b95545',soft:'#faeae6'}];
  const WEIGHTS={ma20:8,ma60:4,ma120:3,advanceRatio:8,newHighLowBalance:6,limitBalance:6,medianReturn:20,amountRatio20:20,concentration:5,drawdown:10,margin5d:5,etf5d:5};
  const COMPONENT_LABELS={ma20:'20日均线广度',ma60:'60日均线广度',ma120:'120日均线广度',advanceRatio:'上涨股票占比',newHighLowBalance:'52周新高新低',limitBalance:'涨跌停家数',medianReturn:'个股收益中位数',amountRatio20:'成交活跃度',concentration:'成交额集中度',drawdown:'60日高点位置',margin5d:'融资余额',etf5d:'ETF份额'};
  const GROUPS=[{label:'趋势与广度',ids:['ma20','ma60','ma120','advanceRatio','newHighLowBalance','limitBalance']},{label:'赚钱效应',ids:['medianReturn']},{label:'交易热度',ids:['amountRatio20','concentration']},{label:'趋势位置',ids:['drawdown']},{label:'资金与杠杆',ids:['margin5d','etf5d']}];
  let rows=new Map(),meta=null,restored=false,pending=null,attempt=0,failed=false,chart=null,resizePending=false;
  function finite(value){return typeof value==='number'&&Number.isFinite(value);}
  function clock(now=Date.now()){const date=new Date(now+8*3600000);return{date:date.toISOString().slice(0,10),minute:date.getUTCHours()*60+date.getUTCMinutes()};}
  function dateValid(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const n=Date.parse(value+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===value;}
  function minute(value){return typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):NaN;}
  function revision(value,now=Date.now()){if(typeof value!=='string'||!/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;const n=Date.parse(value);return finite(n)&&n<=now+300000?n:NaN;}
  function zone(value){return ZONES.find(item=>value<item.limit)||ZONES[ZONES.length-1];}
  function normalizeRow(raw,now=Date.now()){
    const current=clock(now),time=minute(raw?.asOf),weekday=dateValid(raw?.date)?new Date(raw.date+'T00:00:00Z').getUTCDay():-1;
    if(!raw||!dateValid(raw.date)||raw.date>current.date||weekday===0||weekday===6||raw.status!=='close'||time!==900||(raw.date===current.date&&time>current.minute)||!Array.isArray(raw.components)||!raw.components.length)return null;
    const ids=new Set(),components=[];let weight=0,coverage=0,contribution=0;
    for(const item of raw.components){
      if(!item||typeof item.id!=='string'||!Object.prototype.hasOwnProperty.call(WEIGHTS,item.id)||ids.has(item.id)||typeof item.label!=='string'||!item.label.trim()||item.label.length>60||item.weight!==WEIGHTS[item.id]||typeof item.available!=='boolean')return null;
      ids.add(item.id);weight+=item.weight;
      if(item.sourceDate!=null&&(!dateValid(item.sourceDate)||item.sourceDate>raw.date))return null;
      if(item.availableOn!=null&&(!dateValid(item.availableOn)||item.availableOn>raw.date))return null;
      const value=item.value??item.rawValue??null;if(value!==null&&!finite(value))return null;
      if(item.available){if(!finite(item.score)||item.score<0||item.score>100||!finite(item.contribution)||Math.abs(item.contribution-item.weight*item.score/100)>.011||!dateValid(item.sourceDate)||!dateValid(item.availableOn)||item.availableOn<item.sourceDate||(['margin5d','etf5d'].includes(item.id)?item.sourceDate>=raw.date:item.sourceDate!==raw.date))return null;coverage+=item.weight;contribution+=item.contribution;}
      else if(item.score!==null||item.contribution!==null)return null;
      components.push({id:item.id,label:item.label.trim(),weight:item.weight,score:item.score,contribution:item.contribution,available:item.available,sourceDate:item.sourceDate||null,availableOn:item.availableOn||null,value,unit:typeof item.unit==='string'?item.unit:'',reason:typeof item.reason==='string'?item.reason:'',formula:typeof item.formula==='string'?item.formula:''});
    }
    if(Math.abs(weight-100)>.001||!finite(raw.coveragePct)||Math.abs(raw.coveragePct-coverage)>.011)return null;
    const byId=new Map(components.map(item=>[item.id,item])),coreReady=['ma20','ma60','medianReturn','amountRatio20','drawdown'].every(id=>byId.get(id)?.available);
    if(raw.score!==null&&(!finite(raw.score)||raw.score<0||raw.score>100||coverage<85||!coreReady||Math.abs(raw.score-contribution/coverage*100)>.035))return null;
    if(raw.score!==null&&typeof global.MarketHeatModel?.validatePublishedRow==='function'&&!global.MarketHeatModel.validatePublishedRow({...raw,coreReady},{nowMs:now}))return null;
    if(raw.contexts?.rv20!=null&&(!finite(raw.contexts.rv20)||raw.contexts.rv20<0))return null;
    const rv20=finite(raw.contexts?.rv20)?raw.contexts.rv20:null;return{date:raw.date,asOf:raw.asOf,status:raw.status,score:raw.score,coveragePct:coverage,coreReady,components,contexts:{rv20,volatilityStress:rv20===null?'未取得':rv20>=30?'高波动':rv20>=20?'波动偏高':'波动平稳'}};
  }
  function canReplace(previous,next,rev){if(!previous)return true;if(previous.status==='close'&&next.status==='live')return false;if(previous.status==='live'&&next.status==='close')return true;return next.asOf>previous.asOf||(next.asOf===previous.asOf&&rev>previous._revision);}
  function orderedRows(){return[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);}
  function normalizeRefreshStatus(raw,lastDate,published,now=Date.now()){
    // Older snapshots have no target date. Keep their valid scores without
    // inventing a freshness claim, and ignore malformed optional metadata.
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.targetDate==null)return null;
    const current=clock(now),date=raw.targetDate,weekday=dateValid(date)?new Date(date+'T00:00:00Z').getUTCDay():-1;
    if(!dateValid(date)||weekday===0||weekday===6||raw.mode!=='close_only'||raw.latestClosedDate!==lastDate||date<lastDate||date>current.date||date>published.date||(date===current.date&&current.minute<900)||(date===published.date&&published.minute<900)||!Array.isArray(raw.blockedBy)||raw.blockedBy.length>12)return null;
    const ids=new Set(raw.blockedBy);
    if(ids.size!==raw.blockedBy.length||raw.blockedBy.some(id=>typeof id!=='string'||!Object.prototype.hasOwnProperty.call(COMPONENT_LABELS,id)))return null;
    const pending=date>lastDate;
    if((raw.pending!=null&&raw.pending!==pending)||(!pending&&ids.size))return null;
    if(raw.rejectedIncompleteDates!=null&&(!Number.isSafeInteger(raw.rejectedIncompleteDates)||raw.rejectedIncompleteDates<0))return null;
    return{mode:'close_only',latestClosedDate:lastDate,targetDate:date,pending,blockedBy:[...ids],rejectedIncompleteDates:raw.rejectedIncompleteDates??0};
  }
  function refreshMessage(status,lastDate){
    if(!status?.pending||status.latestClosedDate!==lastDate||status.targetDate<=lastDate)return'';
    const labels=status.blockedBy.map(id=>COMPONENT_LABELS[id]).filter(Boolean);
    return'等待 '+status.targetDate+' 的'+(labels.length?labels.join('、')+'更新':'指标校验完成')+'；保留最近有效收盘评分。';
  }
  function normalizePayload(payload,now=Date.now()){
    const rev=revision(payload?.updatedAt,now),published=finite(rev)?clock(rev):null;
    if(!payload||payload.schemaVersion!==1||payload.scope!=='沪深A股'||!finite(rev)||typeof payload.source!=='string'||!payload.source.trim()||typeof payload.methodology!=='string'||!payload.methodology.trim()||!Array.isArray(payload.series)||!payload.series.length)return null;
    if(global.MarketHeatModel?.VERSION&&payload.modelVersion!==global.MarketHeatModel.VERSION)return null;
    let last='',weights=null;const staged=[];
    for(const raw of payload.series){const row=normalizeRow(raw,now);if(!row||row.date<=last||row.date>published.date||(row.date===published.date&&minute(row.asOf)>published.minute))return null;last=row.date;
      const keys=row.components.map(item=>item.id+':'+item.weight).sort().join('|');if(weights!==null&&keys!==weights)return null;weights=keys;staged.push(row);}
    const refreshStatus=normalizeRefreshStatus(payload.refreshStatus,last,published,now);
    return{rev,staged,meta:{updatedAt:payload.updatedAt,source:payload.source,methodology:payload.methodology,refreshStatus,notes:Array.isArray(payload.notes)?payload.notes.filter(item=>typeof item==='string'):[],modelVersion:typeof payload.modelVersion==='string'?payload.modelVersion:'',componentDefinitions:Array.isArray(payload.componentDefinitions)?payload.componentDefinitions.filter(item=>item&&typeof item.id==='string'&&typeof item.formula==='string').map(item=>({id:item.id,formula:item.formula})):[],contextOnly:Array.isArray(payload.contextOnly)?payload.contextOnly.filter(item=>item&&typeof item.label==='string'&&typeof item.reason==='string').map(item=>({label:item.label,reason:item.reason})):[]}};
  }
  function save(){try{localStorage.setItem(CACHE_KEY,JSON.stringify({schemaVersion:1,scope:'沪深A股',...meta,series:orderedRows().map(({_revision,...row})=>({...row,_cachedRevision:_revision}))}));}catch(error){}}
  function acceptPayload(payload,options={}){
    const parsed=normalizePayload(payload,options.now);if(!parsed)return false;
    const originals=new Map(payload.series.map(item=>[item.date,item]));let changed=false;for(const raw of parsed.staged){const cached=originals.get(raw.date)?._cachedRevision,rev=options.fromCache&&finite(cached)&&cached<=parsed.rev?cached:parsed.rev,row={...raw,_revision:rev};if(canReplace(rows.get(row.date),row,rev)){rows.set(row.date,row);changed=true;}}
    rows=new Map(orderedRows().map(row=>[row.date,row]));let metaChanged=false;if(!meta||parsed.rev>=revision(meta.updatedAt)){metaChanged=JSON.stringify(meta)!==JSON.stringify(parsed.meta);meta=parsed.meta;}
    if((changed||metaChanged)&&options.persist!==false)save();failed=false;render();return true;
  }
  function active(){return typeof document!=='undefined'&&!document.hidden&&document.getElementById('t0')?.classList.contains('active');}
  function restore(){if(restored)return;restored=true;try{acceptPayload(JSON.parse(localStorage.getItem(CACHE_KEY)||'null'),{fromCache:true,persist:false});}catch(error){}}
  async function fetchData(url){const target=url+(url.includes('?')?'&':'?')+'_='+Date.now();if(typeof _idxFetch==='function')return _idxFetch(target,{timeout:8000,retries:0});const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const response=await fetch(target,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('市场热度 HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}}
  async function refresh(force=false){restore();render();if(!active())return false;if(pending)return pending;if(!force&&attempt&&Date.now()-attempt<300000)return!!rows.size;attempt=Date.now();pending=(async()=>{const results=await Promise.allSettled(URLS.map(async url=>{if(!acceptPayload(await fetchData(url)))throw Error('市场热度数据未通过校验');}));failed=results.every(result=>result.status==='rejected');render();return!failed;})();try{return await pending;}finally{pending=null;}}
  function put(id,value){const element=typeof document!=='undefined'?document.getElementById(id):null;if(element)element.textContent=value;}
  function escaped(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function signed(value,digits=1){return finite(value)?(value>0?'+':'')+value.toFixed(digits):'—';}
  function componentNote(item,row){if(!item.available)return item.reason||'当日有效数据不足';const lag=item.sourceDate!==row.date?'披露数据 '+item.sourceDate:'当日数据';if(finite(item.value)){const unit=item.unit||'',precision=Math.abs(item.value)>=100?1:2;return item.value.toLocaleString('zh-CN',{maximumFractionDigits:precision})+unit+' · '+lag;}return lag;}
  function grouped(row){const map=new Map(row.components.map(item=>[item.id,item]));return GROUPS.map(group=>{const items=group.ids.map(id=>map.get(id)),weight=items.reduce((sum,item)=>sum+item.weight,0),covered=items.filter(item=>item.available),availableWeight=covered.reduce((sum,item)=>sum+item.weight,0),contribution=covered.reduce((sum,item)=>sum+item.contribution,0);return{label:group.label,weight,availableWeight,available:covered.length,total:items.length,score:availableWeight?contribution/availableWeight*100:null,contribution:row.score!==null?contribution/row.coveragePct*100:null};});}
  const zonePlugin={id:'marketHeatZones',beforeDatasetsDraw(instance){const{ctx,chartArea,scales}=instance;if(!chartArea||!scales.y)return;ctx.save();for(let i=0;i<ZONES.length;i++){const top=scales.y.getPixelForValue((i+1)*20),bottom=scales.y.getPixelForValue(i*20);ctx.fillStyle=['rgba(105,135,172,.048)','rgba(146,185,189,.045)','rgba(199,187,143,.05)','rgba(217,149,87,.048)','rgba(198,92,73,.045)'][i];ctx.fillRect(chartArea.left,top,chartArea.right-chartArea.left,bottom-top);}ctx.restore();}};
  function createChart(){if(chart||typeof Chart!=='function'||typeof document==='undefined')return;const canvas=document.getElementById('cMarketHeat');if(!canvas)return;chart=new Chart(canvas.getContext('2d'),{type:'line',plugins:[zonePlugin],data:{labels:[],datasets:[{label:'市场热度',data:[],borderColor:'#ad7044',borderWidth:2.5,backgroundColor:'rgba(182,128,72,.07)',fill:true,tension:.18,pointRadius:0,pointHoverRadius:5,pointBorderWidth:2,pointBorderColor:'#fff',pointBackgroundColor:'#ad7044',spanGaps:false}]},options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{displayColors:false,backgroundColor:'rgba(39,49,65,.95)',padding:12,titleFont:{size:13,weight:'600'},bodyFont:{size:13},callbacks:{title:items=>orderedRows()[items[0]?.dataIndex]?.date||'',label:context=>'市场热度 '+context.parsed.y.toFixed(1)+' / 100 · '+zone(context.parsed.y).label,afterBody:items=>{const row=orderedRows()[items[0]?.dataIndex];return row?[(row.status==='close'?'收盘':'盘中快照')+' '+row.asOf,'指标权重覆盖 '+row.coveragePct.toFixed(0)+'%']:[];}}}},scales:{x:{grid:{display:false},border:{display:false},ticks:{color:'#87909d',font:{size:12},maxTicksLimit:9,maxRotation:0}},y:{min:0,max:100,border:{display:false},grid:{color:'rgba(130,138,149,.13)',tickLength:0},ticks:{stepSize:20,color:'#85909d',font:{size:12},padding:10}}}}});}
  function render(){if(typeof document==='undefined')return!!rows.size;createChart();const values=orderedRows();if(!values.length){put('marketHeatDate',failed?'本次读取未成功，将自动重试':'正在读取最近有效数据');return false;}
    const last=values[values.length-1],waiting=refreshMessage(meta?.refreshStatus,last.date),valid=finite(last.score),state=valid?zone(last.score):null,card=document.getElementById('marketHeatCard'),pointer=document.getElementById('marketHeatPointer');
    put('marketHeatDate',last.date+' · '+(last.status==='close'?'收盘':'盘中快照')+' '+last.asOf+(waiting?' · 待更新至 '+meta.refreshStatus.targetDate.slice(5):''));put('marketHeatScore',valid?last.score.toFixed(1):'—');put('marketHeatZone',state?.label||'覆盖不足');
    put('marketHeatRiskContext',finite(last.contexts?.rv20)?'中证全指年化波动率 '+last.contexts.rv20.toFixed(1)+'% · '+last.contexts.volatilityStress:'');
    if(card&&state){card.style.setProperty('--heat-color',state.color);card.style.setProperty('--heat-soft',state.soft);}if(pointer){pointer.style.display=valid?'block':'none';if(valid)pointer.style.left=Math.max(1,Math.min(99,last.score))+'%';}
    const previous=values[values.length-6];put('marketHeatChange','近 5 日 '+(valid&&finite(previous?.score)?signed(last.score-previous.score)+' 分':'变化 —'));
    const available=last.components.filter(item=>item.available).length;put('marketHeatCoverage','有效指标 '+available+'/'+last.components.length+' · 权重覆盖 '+last.coveragePct.toFixed(0)+'%。'+(waiting||'分数越高，市场交易与趋势越热。'));
    put('marketHeatRange',values.length+' 个交易日 · '+values[0].date+' 至 '+last.date+(values.some(row=>row.score===null)?' · 数据不足的日期留空':''));
    const target=document.getElementById('marketHeatComponents');if(target)target.innerHTML=grouped(last).map(item=>{const shade=finite(item.score)?zone(item.score).color:'#a4acb7';return'<div class="market-heat-component"><div class="market-heat-component-top"><span>'+escaped(item.label)+'</span><span class="market-heat-component-weight">'+item.weight+'%</span></div><div class="market-heat-component-value"><strong>'+(finite(item.score)?item.score.toFixed(1):'—')+'<small> 分</small></strong><small>'+(item.contribution!==null?'贡献 '+item.contribution.toFixed(1)+' 分':'暂未计入')+'</small></div><div class="market-heat-component-track"><i style="width:'+(item.score??0)+'%;background:'+shade+'"></i></div><div class="market-heat-component-note">'+(item.available===item.total?'已覆盖全部 '+item.total+' 项':'有效 '+item.available+'/'+item.total+' 项 · 权重 '+item.availableWeight+'/'+item.weight)+'</div></div>';}).join('');
    const method=document.getElementById('marketHeatMethod');if(method){const definitions=new Map((meta?.componentDefinitions||[]).map(item=>[item.id,item.formula]));method.innerHTML='<div class="market-heat-method-body">'+escaped(meta?.methodology||'各指标先映射至0—100分，再按固定权重加权。')+'<div class="market-heat-method-scroll"><table class="market-heat-method-table"><thead><tr><th>指标</th><th>权重</th><th>当前分值 / 数据</th><th>计算说明</th></tr></thead><tbody>'+last.components.map(item=>'<tr><td>'+escaped(item.label)+'</td><td>'+item.weight+'%</td><td>'+(item.available?item.score.toFixed(1)+' 分':'暂未计入')+'<br><span>'+escaped(componentNote(item,last))+'</span></td><td>'+escaped(definitions.get(item.id)||item.formula||'按统一历史口径转换为热度分值')+'</td></tr>').join('')+'</tbody></table></div>'+(meta?.contextOnly?.length?'<div style="margin-top:11px"><strong>背景观察指标 · 不计入每日得分</strong><br>'+meta.contextOnly.map(item=>escaped(item.label)+'：'+escaped(item.reason)).join('<br>')+'</div>':'')+(meta?.notes?.length?'<div style="margin-top:9px">'+meta.notes.map(escaped).join('<br>')+'</div>':'')+'</div>';}
    put('marketHeatFooter','来源：'+(meta?.source||'市场环境各项有效数据')+'。'+(last.coveragePct<100?'缺失指标按可用权重重新归一，覆盖低于85%或核心指标不足时不生成分数。':'')+waiting+(failed?'本次读取未成功，保留最近有效数据。':'')+'热度衡量市场活跃度与风险偏好，不代表未来收益。');
    if(chart){chart.data.labels=values.map(row=>row.date.slice(5));chart.data.datasets[0].data=values.map(row=>row.score);chart.data.datasets[0].pointRadius=values.map((row,index)=>finite(row.score)&&(index===values.length-1||row.status==='live')?4:0);chart.update('none');}return true;
  }
  function resize(){if(resizePending||typeof requestAnimationFrame!=='function')return;resizePending=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{resizePending=false;if(active())chart?.resize();}));}
  function visible(){if(!active())return;restore();render();resize();refresh(false).catch(error=>console.warn('[市场热度]',error.message));}
  global.refreshMarketHeat=refresh;global.renderMarketHeat=render;global.applyMarketHeatSnapshot=acceptPayload;
  if(typeof module==='object'&&module.exports)module.exports={clock,dateValid,revision,normalizeRow,normalizePayload,normalizeRefreshStatus,refreshMessage,canReplace,acceptPayload,orderedRows,zone,signed,grouped};
  if(typeof document!=='undefined'){const start=()=>{restore();render();visible();const tab=document.getElementById('t0');if(tab&&typeof MutationObserver==='function')new MutationObserver(visible).observe(tab,{attributes:true,attributeFilter:['class']});setInterval(visible,60000);document.addEventListener('visibilitychange',visible);global.addEventListener('pageshow',visible);global.addEventListener('resize',resize);global.addEventListener('market-heat-update',event=>{if(event.detail)acceptPayload(event.detail);});};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();}
})(typeof window!=='undefined'?window:globalThis);
