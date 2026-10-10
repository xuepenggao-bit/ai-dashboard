/* Monthly personal A-share account openings; not unique investor counts. */
(function(global){
  'use strict';
  const SOURCE='https://www.sse.com.cn/aboutus/publication/monthly/investor/';
  const SEED={schemaVersion:1,displayYear:2026,latestReportMonth:'202609',check:{status:'seed'},records:[
    ...[156.3888,282.9867,305.6196,191.5821,154.8413,163.8022,195.4007,264.0340,292.6287,230.2196,237.1676,258.5638].map((v,i)=>({year:2025,month:i+1,personalWan:v,reportMonth:'202512',source:'用户附件'})),
    ...[490.5257,251.5893,458.8183,248.0347,275.5049,285.1894,264.1968,238.5665,189.9667].map((v,i)=>({year:2026,month:i+1,personalWan:v,reportMonth:'202609',source:'用户附件'})),
  ]};
  const CACHE='aiDashboard.accountOpenings.v1';
  const num=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
  function valid(d){return d?.schemaVersion===1&&Number.isInteger(d.displayYear)&&Array.isArray(d.records)&&d.records.some(r=>Number.isInteger(r.year)&&r.month>=1&&r.month<=12&&num(r.personalWan)>0);}
  function summarize(d,year=d.displayYear){
    const rows=new Map();
    for(const r of d.records||[]){
      const v=num(r.personalWan),month=Number(r.month),report=String(r.reportMonth||'');
      if(!Number.isInteger(r.year)||!Number.isInteger(month)||month<1||month>12||v===null||v<=0)continue;
      const term=String(r.year)+String(month).padStart(2,'0');
      if(!/^\d{6}$/.test(report)||term>report)continue;
      const key=r.year+'-'+month,old=rows.get(key);
      if(!old||report>=old.reportMonth)rows.set(key,{...r,personalWan:v,reportMonth:report});
    }
    const series=y=>Array.from({length:12},(_,i)=>rows.get(y+'-'+(i+1))?.personalWan??null);
    const current=series(year),previous=series(year-1);
    const month=current.reduce((last,v,i)=>v!==null?i+1:last,0);
    const sum=a=>a.every(v=>v!==null)?a.reduce((s,v)=>s+Math.round(v*10000),0)/10000:null;
    const currentTotal=month?sum(current.slice(0,month)):null,previousTotal=month?sum(previous.slice(0,month)):null;
    const yoy=currentTotal!==null&&previousTotal>0?(currentTotal/previousTotal-1)*100:null;
    return {year,month,current,previous,currentTotal,previousTotal,yoy};
  }
  function newer(candidate,current){
    if(!valid(candidate))return false;
    const a=String(candidate.latestReportMonth||''),b=String(current.latestReportMonth||'');
    if(a!==b)return a>b;
    return String(candidate.lastCheckedAt||'')>String(current.lastCheckedAt||'');
  }
  function mergeSnapshots(fresh,old){
    const rows=new Map();
    for(const r of [...old.records,...fresh.records]){
      const term=String(r.year)+String(r.month).padStart(2,'0'),report=String(r.reportMonth||'');
      if(!Number.isInteger(r.year)||!Number.isInteger(r.month)||r.month<1||r.month>12||num(r.personalWan)<=0||!/^\d{6}$/.test(report)||term>report)continue;
      const key=r.year+'-'+r.month,prior=rows.get(key);
      if(prior&&report===String(prior.reportMonth)){
        const official=r.source==='上交所官方月报',oldOfficial=prior.source==='上交所官方月报';
        if(oldOfficial&&!official)continue;
        if(fresh.check?.status==='error'&&official===oldOfficial)continue;
      }
      if(!prior||report>=String(prior.reportMonth))rows.set(key,r);
    }
    return {...fresh,displayYear:Math.max(fresh.displayYear,old.displayYear),records:[...rows.values()].sort((a,b)=>a.year-b.year||a.month-b.month)};
  }
  const api={SEED,summarize,valid,newer,mergeSnapshots};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(!global.document)return;
  let data=SEED,chart=null,pending=null,lastFetch=0,chartSignature='';
  const el=id=>document.getElementById(id);
  const visible=()=>el('t0')?.classList.contains('active')&&!document.hidden;
  const year=()=>Math.max(data.displayYear,Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric'}).format(new Date())));
  const fmt=v=>v===null?'—':v.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  function render(){
    if(!el('accountOpeningCard'))return;
    const s=summarize(data,year());
    const range=s.month?'1—'+s.month+'月':'待公布';
    el('aoCurrentLabel').textContent=s.year+'年累计 · '+range;
    el('aoPreviousLabel').textContent=(s.year-1)+'年同期 · '+range;
    el('aoCurrentValue').textContent=fmt(s.currentTotal);
    el('aoPreviousValue').textContent=fmt(s.previousTotal);
    el('aoYoyValue').textContent=s.yoy===null?'—':(s.yoy>=0?'+':'')+s.yoy.toFixed(2)+'%';
    el('aoYoyStat').classList.toggle('ao-negative',s.yoy!==null&&s.yoy<0);
    el('aoPeriod').textContent=s.month?'截至 '+s.year+'年'+s.month+'月 · 每日核验':'当年数据待公布 · 每日核验';
    const stamp=data.lastCheckedAt&&Number.isFinite(Date.parse(data.lastCheckedAt))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(data.lastCheckedAt)):null;
    const status=data.check?.status;
    el('aoCheck').textContent=stamp?'最近核验 '+stamp+' · '+(status==='ok'?'官方月报':status==='partial'?'部分来源未取得，保留有效数据':'网络异常，保留有效数据'):'附件初始数据 · 等待每日官方核验';
    el('aoScope').textContent='口径：上交所个人A股账户新开户数，非沪深去重新增投资者人数。未公布月份留空，累计同比只比较相同月份。';
    if(!visible()||!global.Chart)return;
    const signature=JSON.stringify([s.year,s.current,s.previous]);
    if(chart&&signature===chartSignature){chart.resize();return;}
    chartSignature=signature;
    const datasets=[
      {label:(s.year-1)+'年',data:s.previous,borderColor:'#8495ad',backgroundColor:'#8495ad',borderDash:[6,4],borderWidth:2,pointRadius:3,pointHoverRadius:6},
      {label:s.year+'年',data:s.current,borderColor:'#2563a4',backgroundColor:'#2563a4',borderWidth:2.5,pointRadius:4,pointHoverRadius:7},
    ].map(d=>({...d,tension:0,spanGaps:false,fill:false,pointBackgroundColor:'#fff',pointBorderWidth:2}));
    if(chart){chart.data.datasets=datasets;chart.update('none');return;}
    chart=new global.Chart(el('cAccountOpenings'),{type:'line',data:{labels:Array.from({length:12},(_,i)=>(i+1)+'月'),datasets},options:{responsive:true,maintainAspectRatio:false,animation:{duration:450},interaction:{mode:'index',intersect:false},scales:{x:{grid:{display:false},ticks:{color:'#52667e',font:{size:13,weight:'600'}}},y:{beginAtZero:true,title:{display:true,text:'个人开户数（万户）',color:'#62768c',font:{size:12}},ticks:{color:'#62768c',font:{size:12}},grid:{color:'#e7edf4'}}},plugins:{legend:{position:'top',align:'end',labels:{color:'#38506e',font:{size:13,weight:'600'},usePointStyle:true,boxWidth:10,padding:18}},tooltip:{backgroundColor:'#203b5a',padding:12,titleFont:{size:14},bodyFont:{size:13},callbacks:{label:c=>c.dataset.label+'：'+c.parsed.y.toFixed(4)+' 万户'}}}}});
  }
  async function get(url){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const r=await fetch(url,{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(timer);}}
  function refresh(force=false){
    if(pending)return pending;
    if(!force&&Date.now()-lastFetch<30*60000)return Promise.resolve();
    lastFetch=Date.now();
    pending=(async()=>{
      for(const base of ['data/account_openings.json','https://raw.githubusercontent.com/xuepenggao-bit/ai-dashboard/main/data/account_openings.json']){
        // Pages may lag a data-only bot commit. Inspect the raw snapshot too,
        // without delaying the immediately rendered seed/cache/same-origin data.
        try{const fresh=await get(base+'?_='+Date.now());if(!valid(fresh))throw Error('开户数据不完整');if(newer(fresh,data)){data=mergeSnapshots(fresh,data);try{localStorage.setItem(CACHE,JSON.stringify(data));}catch(_){}render();} }catch(e){console.warn('[个人开户趋势] 保留有效数据',e.message);}
      }
    })().finally(()=>{pending=null;});
    return pending;
  }
  function init(){
    if(!el('accountOpeningCard'))return;
    try{const cached=JSON.parse(localStorage.getItem(CACHE));if(newer(cached,data))data=mergeSnapshots(cached,data);}catch(_){}
    render();
    const onVisible=()=>{if(visible()){render();refresh(false);}};
    new MutationObserver(onVisible).observe(el('t0'),{attributes:true,attributeFilter:['class']});
    document.addEventListener('visibilitychange',onVisible);
    window.addEventListener('pageshow',onVisible);
    setInterval(onVisible,60000);
    setTimeout(()=>refresh(false),1200);
    global.AccountOpenings={...api,refresh,render,getData:()=>data,getChart:()=>chart};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof window==='undefined'?globalThis:window);
