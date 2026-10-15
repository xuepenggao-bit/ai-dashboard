/* Market-environment chart typography only. Dataset values and scale semantics stay owned by each chart. */
(function(global){
  'use strict';
  const ID='marketEnvironmentReadability';
  const AXIS_COLOR='#526174',LEGEND_COLOR='#3f4e62';
  const NEUTRALS=new Set(['#64748b','#94a3b8','#475569','#52667e','#62768c','#38506e','#87909d','#85909d','#8491a4','#64748B','#94A3B8']);
  const installed=new WeakSet();
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  function marketChart(chart){
    const canvas=chart?.canvas;
    return !!(canvas&&typeof canvas.closest==='function'&&canvas.closest('#t0'));
  }
  function fontAtLeast(value,size,weight){
    if(typeof value==='function'||Array.isArray(value)||value!=null&&!object(value))return value;
    const next={...(value||{})};
    if(next.size===undefined||typeof next.size==='number'&&Number.isFinite(next.size))next.size=Math.max(size,next.size||0);
    if(next.weight===undefined&&weight)next.weight=weight;
    return next;
  }
  function neutralColor(value,replacement){return value===undefined||typeof value==='string'&&NEUTRALS.has(value)?replacement:value;}
  function enabledObject(parent,key){
    if(parent[key]===false||parent[key]!==undefined&&!object(parent[key]))return null;
    if(parent[key]===undefined)parent[key]={};
    return parent[key];
  }
  function styleOptions(chart){
    if(!marketChart(chart))return false;
    const config=chart.config,options=config?.options;
    if(!object(options))return false;
    const scales=options.scales;
    if(object(scales))for(const scale of Object.values(scales)){
      if(!object(scale))continue;
      const ticks=enabledObject(scale,'ticks');
      if(ticks){ticks.font=fontAtLeast(ticks.font,13,'500');ticks.color=neutralColor(ticks.color,AXIS_COLOR);}
      const title=object(scale.title)?scale.title:null;
      if(title){title.font=fontAtLeast(title.font,13,'500');title.color=neutralColor(title.color,AXIS_COLOR);}
      const pointLabels=object(scale.pointLabels)?scale.pointLabels:null;
      if(pointLabels){pointLabels.font=fontAtLeast(pointLabels.font,13,'500');pointLabels.color=neutralColor(pointLabels.color,AXIS_COLOR);}
    }
    const plugins=enabledObject(options,'plugins');
    if(plugins){
      const legend=enabledObject(plugins,'legend');
      if(legend){const labels=enabledObject(legend,'labels');if(labels){labels.font=fontAtLeast(labels.font,13,'600');labels.color=neutralColor(labels.color,LEGEND_COLOR);}}
      const tooltip=enabledObject(plugins,'tooltip');
      if(tooltip){tooltip.titleFont=fontAtLeast(tooltip.titleFont,14,'600');tooltip.bodyFont=fontAtLeast(tooltip.bodyFont,14);tooltip.footerFont=fontAtLeast(tooltip.footerFont,13);}
    }
    const datasets=config?.data?.datasets;
    if(Array.isArray(datasets))for(const dataset of datasets){
      if(!object(dataset)||(dataset.type||config.type)!=='line')continue;
      // Border dash can be scriptable/indexable; only an explicitly solid line
      // is eligible. Reference lines and invisible confidence bands keep width.
      if(dataset.borderDash!==undefined&&(!Array.isArray(dataset.borderDash)||dataset.borderDash.length))continue;
      const width=dataset.borderWidth;
      if(typeof width==='number'&&Number.isFinite(width)&&width>0&&width<2.3)dataset.borderWidth=2.3;
    }
    return true;
  }
  const plugin={id:ID,beforeInit(chart){styleOptions(chart);}};
  function install(Chart=global.Chart){
    if(typeof Chart!=='function'||typeof Chart.register!=='function')return false;
    if(installed.has(Chart))return true;
    Chart.register(plugin);installed.add(Chart);return true;
  }
  const api={ID,AXIS_COLOR,LEGEND_COLOR,marketChart,fontAtLeast,neutralColor,styleOptions,plugin,install};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else global.MarketEnvironmentChartDesign=api;
  install();
  if(global.document?.readyState==='loading')global.document.addEventListener('DOMContentLoaded',()=>install(),{once:true});
})(typeof globalThis!=='undefined'?globalThis:this);
