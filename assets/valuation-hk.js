/* HK valuation definitions: original-currency parent profit, verified A/H links, dated FX. */
(function(global){
  'use strict';
  const n=v=>v!==null&&v!==undefined&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?Number(v):null;
  const DAY=86400000;
  function isoDay(v){
    const s=String(v||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
    const t=Date.parse(s+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===s?s:null;
  }
  const beijingDay=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const currency=v=>({人民币:'CNY',RMB:'CNY',CNY:'CNY',港元:'HKD',港币:'HKD',HKD:'HKD',美元:'USD',USD:'USD'})[String(v||'').trim().toUpperCase()]||null;
  const growth=(a,b)=>n(a)!==null&&n(b)!==null&&b>0?(a/b-1)*100:null;
  const before=s=>new Date(Date.parse(s+'T00:00:00Z')-DAY).toISOString().slice(0,10);
  function shiftMonths(s,months){const d=new Date(s+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+months);return d.toISOString().slice(0,10);}
  function shiftYear(s,years){
    const y=Number(s.slice(0,4))+years,m=Number(s.slice(5,7)),day=Number(s.slice(8,10));
    return new Date(Date.UTC(y,m-1,Math.min(day,new Date(Date.UTC(y,m,0)).getUTCDate()))).toISOString().slice(0,10);
  }
  function monthsIn(start,end){
    if(!start||!end||start>end||!start.endsWith('-01'))return null;
    const y=Number(end.slice(0,4)),m=Number(end.slice(5,7));
    if(Number(end.slice(8,10))!==new Date(Date.UTC(y,m,0)).getUTCDate())return null;
    return (y-Number(start.slice(0,4)))*12+m-Number(start.slice(5,7))+1;
  }
  function fromHK(rows,asOf=beijingDay()){
    const accepted=new Map(),conflicts=new Set(),issuers=new Set();
    for(const raw of rows||[]){
      if(String(raw?.STD_ITEM_CODE)!=='004025002')continue;
      const start=isoDay(raw.START_DATE),end=isoDay(raw.REPORT_DATE),value=n(raw.AMOUNT);
      if(!start||!end||end>asOf||start>end)continue;
      if(raw.SECUCODE)issuers.add(String(raw.SECUCODE));
      const c=currency(raw.CURRENCY_CODE)||currency(raw.CURRENCY),months=monthsIn(start,end);
      if(!months||![3,6,9,12].includes(months))continue;
      const r={start,end,value,currency:c,months,annual:String(raw.DATE_TYPE_CODE)==='001',revision:String(raw.UPDATE_DATE||raw.NOTICE_DATE||''),raw};
      const previous=accepted.get(end);
      if(previous&&previous.revision===r.revision&&(previous.value!==value||previous.currency!==c||previous.start!==start))conflicts.add(end);
      else if(!previous||r.revision>previous.revision){accepted.set(end,r);conflicts.delete(end);}
    }
    // Never cross issuer identities or silently pick one conflicting same-period value.
    if(issuers.size>1)return null;
    for(const end of conflicts)accepted.delete(end);
    const recs=[...accepted.values()].sort((a,b)=>b.end.localeCompare(a.end)),latest=recs[0];if(!latest)return null;
    const unit=latest.currency,annual=recs.find(r=>r.annual&&r.months===12);
    function interval(start,end){
      const r=accepted.get(end);if(!r||r.value===null||!unit||r.currency!==unit||start<r.start)return null;
      if(r.start===start)return r.value;
      const p=accepted.get(before(start));
      return p&&p.value!==null&&p.start===r.start&&p.currency===unit?r.value-p.value:null;
    }
    let segment=null;
    const threeStart=shiftMonths(latest.end.slice(0,7)+'-01',-2);
    const quarter=interval(threeStart,latest.end);
    if(quarter!==null&&threeStart>=latest.start)segment={start:threeStart,end:latest.end,value:quarter,months:3};
    else if(latest.months===6||latest.months===12){
      const start=shiftMonths(latest.end.slice(0,7)+'-01',-5),value=interval(start,latest.end);
      if(value!==null)segment={start,end:latest.end,value,months:6};
    }
    const annualValue=annual&&unit&&annual.currency===unit?annual.value:null;
    const priorAnnual=annual?interval(shiftYear(annual.start,-1),shiftYear(annual.end,-1)):null;
    let yoy=null,qoq=null;
    if(segment){
      yoy=growth(segment.value,interval(shiftYear(segment.start,-1),shiftYear(segment.end,-1)));
      qoq=growth(segment.value,interval(shiftMonths(segment.start,-segment.months),before(segment.start)));
    }
    const notes=['港股原始报表股东应占净利润，非扣非或管理层经调整利润；单季由同财年累计差分'];
    if(segment?.months===6)notes.push('仅有半年披露，按半年同比/环比比较，不冒称单季度');
    if(!segment)notes.push('缺少连续分期，不能把累计金额当单季度');
    if(!unit)notes.push('报告币种未核验，增速及跨币种PE不计算');
    if(annual&&annual.currency!==unit)notes.push('年报与最新报告币种不同，暂不混合年度利润');
    if(conflicts.size)notes.push('有同期间冲突数据已排除');
    return {
      annualProfit:annualValue===null?null:annualValue/1e8,
      annualYoY:growth(annualValue,priorAnnual),
      annualPeriod:annual?'截至'+annual.end+'年度':null,
      qtrProfit:segment?segment.value/1e8:null,qtrYoY:yoy,qtrQoQ:qoq,
      qtrPeriod:segment?segment.start+'—'+segment.end+'（'+(segment.months===3?'单季':'半年')+'）':latest.end+'（分期不足）',
      currency:unit,source:'HK',profitBasis:'parent_net_profit',basisLabel:'归母净利 · 港股',basisNote:notes.join('；'),
      reportDate:latest.end,periodMonths:segment?.months||null,
      periodStart:segment?.start||null,annualStart:annual?.start||null,annualEnd:annual?.end||null
    };
  }
  function fromAH(aData,aCode){
    const code=String(aCode||'');if(!/^\d{6}$/.test(code))throw Error('A/H对应A股代码无效');
    const valid=aData?.profitBasis==='recurring_parent_net_profit'&&currency(aData.currency)==='CNY';
    const missing={annualProfit:null,annualYoY:null,annualPeriod:null,qtrProfit:null,qtrYoY:null,qtrQoQ:null,qtrPeriod:null,reportDate:null};
    return {...(valid?aData:missing),currency:'CNY',source:'AH',aShareCode:code,profitBasis:'recurring_parent_net_profit',basisLabel:'扣非 · A股 '+code,
      basisNote:valid?'A/H同一发行人，采用对应A股扣非归母净利润；港股市值须换为人民币后计算PE':'对应A股扣非数据尚未取得；不得回退港股普通净利润'};
  }
  function parseAH(rows,total){
    const count=n(total);if(!Array.isArray(rows)||!Number.isInteger(count)||count<=0||rows.length!==count)throw Error('A/H对应表分页不完整');
    const out={};
    for(const r of rows){
      const hk=String(r?.f12??''),a=String(r?.f191??''),market=n(r?.f192);
      if(!/^\d{5}$/.test(hk)||Number(r?.f13)!==116||!/^\d{6}$/.test(a)||![0,1].includes(market)||out[hk])throw Error('A/H对应表含无效或重复代码');
      if(market===1&&!a.startsWith('6')||market===0&&!/^[03]/.test(a))throw Error('A股代码与上市市场不匹配');
      out[hk]={hkCode:hk,aCode:a,aMarket:market===1?'SH':'SZ',hkName:String(r.f14||''),aName:String(r.f193||'')};
    }
    return out;
  }
  function quoteTime(raw){
    const s=String(raw||'').trim(),m=/^(\d{4})-?(\d{2})-?(\d{2})(?:[ T]?(\d{2}):?(\d{2}):?(\d{2}))$/.exec(s);
    if(!m)return null;const [y,month,day,h,min,sec]=m.slice(1).map(Number);
    if(month<1||month>12||day<1||day>31||h>23||min>59||sec>59)return null;
    const stamp=Date.UTC(y,month-1,day,h-8,min,sec),bjt=new Date(stamp+8*3600000);
    if(bjt.getUTCFullYear()!==y||bjt.getUTCMonth()+1!==month||bjt.getUTCDate()!==day)return null;
    return {stamp,dateTime:`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`};
  }
  function parseFX(text,nowMs=Date.now()){
    const rates={HKD:1},rateDateTimes={},accepted={},now=n(nowMs);
    for(const match of String(text||'').matchAll(/\bv_wh(HKDCNY|USDHKD)\s*=\s*["']([^"']*)["']/g)){
      const pair=match[1],fields=match[2].split(match[2].includes('~')?'~':','),value=n(fields[3]),time=quoteTime(fields[5]);
      if(fields[2]!==pair||!(value>0)||!time||now===null||time.stamp>now+5*60000||now-time.stamp>7*DAY)continue;
      if(accepted[pair]&&accepted[pair].stamp>time.stamp)continue;
      accepted[pair]={...time,value};
    }
    if(accepted.HKDCNY){rates.CNY=accepted.HKDCNY.value;rateDateTimes.CNY=accepted.HKDCNY.dateTime;}
    if(accepted.USDHKD){rates.USD=1/accepted.USDHKD.value;rateDateTimes.USD=accepted.USDHKD.dateTime;}
    const latest=Object.values(accepted).sort((a,b)=>b.stamp-a.stamp)[0];
    return {rates,rateDateTimes,dateTime:latest?.dateTime||null,source:'Tencent FX',validatedAt:now,quotes:accepted};
  }
  function pe(mktCap,profit,marketCurrency,profitCurrency,fx,nowMs=Date.now()){
    const cap=n(mktCap),earnings=n(profit),m=currency(marketCurrency),p=currency(profitCurrency);
    if(!(cap>0)||!(earnings>0)||!m||!p)return null;
    let converted=cap;
    if(m!==p){
      const from=n(fx?.rates?.[m]),to=n(fx?.rates?.[p]);if(!(from>0)||!(to>0)||fx?.rates?.HKD!==1)return null;
      // Recheck parsed quote dates when a tab has kept its in-memory FX snapshot
      // through prolonged network failures or a browser background suspension.
      if(fx.quotes){
        const now=n(nowMs);if(now===null)return null;
        for(const c of new Set([m,p])){
          if(c==='HKD')continue;
          const quote=fx.quotes[c==='CNY'?'HKDCNY':c==='USD'?'USDHKD':''];
          if(!quote||n(quote.stamp)===null||quote.stamp>now+5*60000||now-quote.stamp>7*DAY)return null;
        }
      }
      converted=cap*to/from;
    }
    const ratio=converted/earnings;return Number.isFinite(ratio)&&ratio>0?Math.round(ratio):null;
  }
  const api={fromHK,fromAH,parseAH,parseFX,pe};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.ValuationHK=api;
})(typeof window==='undefined'?globalThis:window);
