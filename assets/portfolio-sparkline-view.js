/* Tiny, resolution-independent price curves. No canvas or chart instances per row. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.PortfolioSparklineView=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const WIDTH=144,HEIGHT=38,LEFT=5,RIGHT=139,TOP=5,BOTTOM=33,BASELINE=19;
  const COLORS={up:'#b82e4a',down:'#13795d',flat:'#65778b'};
  const LABELS={loading:'加载分时',preopen:'未开盘',market_closed:'休市',suspended:'停牌',missing:'分时待更新'};
  const esc=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=n=>Number(n.toFixed(3));
  const point=p=>number(p.x)+' '+number(p.y);
  function minute(time){
    const s=String(time||'');
    if(!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(s)) return null;
    return +s.slice(0,2)*60+(+s.slice(2));
  }
  function elapsed(time,mkt){
    const m=minute(time),hk=mkt==='HK',morningEnd=hk?720:690,dayEnd=hk?970:900;
    if(m==null||m<570||m>dayEnd||m>morningEnd&&m<780) return null;
    const morning=morningEnd-570,total=hk?330:240;
    return Math.min(total,m<=morningEnd?m-570:morning+m-780);
  }
  function minuteX(time,mkt){
    const n=elapsed(time,mkt);
    return n==null?null:LEFT+(RIGHT-LEFT)*n/(mkt==='HK'?330:240);
  }
  function validDate(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))) return false;
    const d=new Date(value+'T00:00:00Z');
    return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
  }
  function side(delta){return delta>0?'up':delta<0?'down':'flat';}
  function segments(points){
    const result=[];
    function add(kind,a,b){
      const last=result[result.length-1],end=last&&last.points[last.points.length-1];
      if(last&&last.kind===kind&&end.x===a.x&&end.y===a.y) last.points.push(b);
      else result.push({kind,points:[a,b]});
    }
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i];
      if(a.delta*b.delta<0){
        const fraction=Math.abs(a.delta)/(Math.abs(a.delta)+Math.abs(b.delta));
        const cross={x:a.x+(b.x-a.x)*fraction,y:BASELINE,delta:0};
        add(side(a.delta),a,cross);add(side(b.delta),cross,b);
      }else add(side(a.delta||b.delta),a,b);
    }
    return result;
  }
  function geometry(series,mkt){
    const previousClose=Number(series&&series.previousClose),raw=series&&series.points;
    if(!(previousClose>0&&Number.isFinite(previousClose))||!Array.isArray(raw)||!raw.length||raw.length>500) return null;
    const points=[];let last=-1;
    for(const p of raw){
      const t=minute(p&&p.time),x=minuteX(p&&p.time,mkt),price=Number(p&&p.price);
      if(t==null||t<=last||x==null||!(price>0&&Number.isFinite(price))) return null;
      last=t;points.push({x,price,delta:price-previousClose,time:String(p.time)});
    }
    // A symmetric scale keeps yesterday's close at the same clear reference level.
    const range=Math.max(previousClose*.002,...points.map(p=>Math.abs(p.delta)))*1.07;
    for(const p of points) p.y=BASELINE-p.delta/range*(BOTTOM-TOP)/2;
    return{width:WIDTH,height:HEIGHT,baseline:BASELINE,points,segments:segments(points),
      lastPct:(points[points.length-1].price-previousClose)/previousClose*100};
  }
  function clockDate(now){
    const d=new Date((Number.isFinite(now)?now:Date.now())+28800000);
    return d.toISOString().slice(0,10);
  }
  function placeholder(status,options){
    const label=options.label||LABELS[status]||LABELS.missing;
    const name=options.name?options.name+' · ':'';
    return '<span class="port-spark port-spark-empty is-'+esc(status)+'" role="img" aria-label="'+esc(name+label)+'" title="'+esc(name+label)+'"><span class="port-spark-state">'+(status==='loading'?'<i class="port-spark-loader" aria-hidden="true"></i>':'')+esc(label)+'</span></span>';
  }
  function render(series,options={}){
    let status=options.status||'ready';
    if(['preopen','market_closed','suspended','loading','missing'].includes(status)) return placeholder(status,options);
    const mkt=options.mkt||(/^hk/i.test(String(series&&series.key))?'HK':'SH');
    const g=geometry(series,mkt);
    if(!g||!validDate(series&&series.date)) return placeholder('missing',options);
    const last=g.points[g.points.length-1],lastTime=last.time.slice(0,2)+':'+last.time.slice(2),lastKind=side(last.delta);
    const today=clockDate(options.now),stale=status==='stale'||series.date<today;
    const staleText=series.date===today?(options.label||'截至 '+lastTime):series.date.slice(5);
    const precision=mkt==='HK'?3:2;
    const description=(options.name?options.name+' · ':'')+series.date+' '+lastTime+' · '+
      '现价 '+last.price.toFixed(precision)+' · 较昨收 '+(g.lastPct>0?'+':'')+g.lastPct.toFixed(2)+'% · '+
      String(series.source||'行情源')+(stale?' · '+staleText+' · 缓存行情，非当前实时':'')+' · 横轴为完整交易日，午休已压缩；纵轴按本股缩放';
    const title=esc(description),baseline='<path class="port-spark-baseline" d="M'+LEFT+' '+BASELINE+' H'+RIGHT+'"/>';
    let areas='',lines='';
    for(const segment of g.segments){
      const ps=segment.points,first=ps[0],end=ps[ps.length-1];
      const d='M'+ps.map(point).join(' L');
      if(segment.kind!=='flat') areas+='<path class="port-spark-area is-'+segment.kind+'" fill="'+COLORS[segment.kind]+'" d="M'+number(first.x)+' '+BASELINE+' L'+ps.map(point).join(' L')+' L'+number(end.x)+' '+BASELINE+' Z"/>';
      lines+='<path class="port-spark-line is-'+segment.kind+'" stroke="'+COLORS[segment.kind]+'" d="'+d+'"/>';
    }
    const dot='<circle class="port-spark-dot-halo" cx="'+number(last.x)+'" cy="'+number(last.y)+'" r="3.1" fill="'+COLORS[lastKind]+'"/><circle class="port-spark-dot" cx="'+number(last.x)+'" cy="'+number(last.y)+'" r="1.6" fill="'+COLORS[lastKind]+'"/>';
    const staleLabel=stale?'<span class="port-spark-cache" aria-hidden="true">'+esc(staleText)+'</span>':'';
    return '<span class="port-spark'+(stale?' is-stale':'')+'" title="'+title+'"><svg class="port-spark-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+WIDTH+' '+HEIGHT+'" width="'+WIDTH+'" height="'+HEIGHT+'" role="img" aria-label="'+title+'"><title>'+title+'</title>'+areas+baseline+lines+dot+'</svg>'+staleLabel+'</span>';
  }
  return{render,geometry,minuteX,WIDTH,HEIGHT};
});
