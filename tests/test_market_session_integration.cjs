const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const htmlPath=process.env.TEST_HTML||
  (fs.existsSync(path.join(__dirname,'../index.html'))?path.join(__dirname,'../index.html'):'/private/tmp/market-session-index.html');
const modelPath=process.env.MARKET_SESSION_MODEL||
  (fs.existsSync(path.join(__dirname,'../assets/market-session.js'))?path.join(__dirname,'../assets/market-session.js'):'/private/tmp/market-session-model.js');
const html=fs.readFileSync(htmlPath,'utf8');
const Model=require(modelPath);
const ts=(date,time='10:30:00')=>Date.parse(date+'T'+time+'+08:00');
const clone=value=>JSON.parse(JSON.stringify(value));
function extract(name){
  const match=new RegExp('(?:async )?function '+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\(').exec(html);
  assert.ok(match,'Missing actual inline function '+name);
  const end=html.indexOf('\n}',match.index);
  assert.ok(end>match.index,'Missing function end '+name);
  return html.slice(match.index,end+2);
}
const fnNames=['_portMarketState','_portStockState','_portEffectivePrices','_portSessionBadge','_portIndexMarketState',
  '_portReconcileSessions','_buildPortfolioAllocationModel','renderPortfolio','_beijingMarketClock','_isWeekdayMarketClock',
  '_isAPreOpenZeroWindow','_isAStockMarket','_isPortfolioAStockPreOpen','_portfolioStockDisplayPct','_portTopDisplayPct',
  '_isPortfolioHKStock','_portTopMarketIcon','_renderPortTopWeightedSummary','renderPortTop3','_renderPortBreadth',
  '_renderPortTopW','_portTurnoverRate','_portTurnoverCell','_portTurnoverCompare','_port5dKey','_escH',
  '_histBeijingDate','_histReturnEligible','_histStatusLabel','_histCsiValue','_computePortPct','_touchHistoryRecord','addHistRecord',
  '_fetchPortfolioPricesRound','_portRenderQuoteProgress'];
const source=fnNames.map(extract).join('\n');
const A={code:'600000',mkt:'SH',name:'A股测试',industry:'科技',w:30};
const HK={code:'00700',mkt:'HK',name:'港股测试',industry:'科技',w:70};
const quote=(stock,date,pct,price=100,extra={})=>({mkt:stock.mkt,name:stock.name,w:stock.w,price,pct,
  quoteTs:ts(date),volume:100,amount:10000,turnoverRate:4.56,volRatio:2.34,speedPct:1.23,...extra});
function harness(date='2026-10-19',time='10:30:00',stocks=[A,HK]){
  Model.setCalendar(Model.EMBEDDED_CALENDAR);
  const state={now:ts(date,time),saved:0,remoteSaved:0,historyRendered:0,tab:null};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id)){
      const classes=new Set();
      elements.set(id,{textContent:'',innerHTML:'',title:'',style:{},classList:{
        add(...names){names.forEach(name=>classes.add(name));},remove(...names){names.forEach(name=>classes.delete(name));},
        contains(name){return classes.has(name);},toggle(name,force){if(force===true||force==null&&!classes.has(name))classes.add(name);else classes.delete(name);}
      }});
    }
    return elements.get(id);
  };
  const ctx=vm.createContext({Date:Clock,Number,Math,Map,Set,Array,String,JSON,Promise,URL,console,
    PortfolioMarketSession:{...Model,clock:(value=state.now)=>Model.clock(value)},
    document:{hidden:false,getElementById:element},
    PORT:{sectors:[{name:'混合持仓',color:'#2563eb',stocks:clone(stocks)}],history:[]},
    _PORT_PRICES:{},_PORT_5D_CLOSE:{},_portSort:{col:'w',dir:1},CH:{},_IDX_CACHE:{},_TAB_TS:{},_arCur:0,
    portLoad(){},_portLiveMoveClass:()=>'',_capturePortfolioRenderSnapshot(){},
    _idxListHtml:()=>'<div>index re-rendered</div>',
    fetchPortPrices:async()=>{},fetchIndexPrices:async()=>{},
    fetchPortFiveDayRanges:async()=>{},fetch(){throw new Error('Unexpected network request in all-closed test');},
    portSave(){state.saved++;},portSaveRemote:async()=>{state.remoteSaved++;},
    renderHistTable(){state.historyRendered++;},confirm:()=>true,
    TAB_ORDER:['t0','tHist'],switchTab(index){state.tab=index;}
  });
  vm.runInContext(source,ctx,{filename:'actual-portfolio-session-functions.js'});
  return {ctx,state,elements,element};
}
function rowFor(h,name){
  return [...h.element('portSectors').innerHTML.matchAll(/<tr class="port-holding-row">([\s\S]*?)<\/tr>/g)]
    .map(match=>match[1]).find(row=>row.includes(name));
}
function assertEmptyMarketFields(row,label){
  assert.ok(row,'Holding row exists');assert.match(row,new RegExp('data-quote-status="[^"]+">'+label));
  for(const className of ['col-pct','col-range5','col-turnover','col-vr','col-sp']){
    const cells=[...row.matchAll(new RegExp('<td class="'+className+'[^>]*>([\\s\\S]*?)<\\/td>','g'))];
    assert.ok(cells.length,'Cell '+className+' exists');
    cells.forEach(cell=>assert.doesNotMatch(cell[1],/port-change-pill|port-range-pill|port-metric-number/,'No stale '+className));
  }
}

test('candidate inline scripts parse and session module is referenced before DOM startup',()=>{
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\bsrc\s*=|application\/(?:ld\+)?json/i.test(match[1])||!match[2].trim())continue;
    new vm.Script(match[2]);
  }
  assert.match(html,/<script defer src="assets\/market-session\.js\?v=/);
  assert.ok(html.indexOf('assets/market-session.js')<html.indexOf('function _portMarketState'));
  assert.match(html,/setInterval\(\(\)=>_portReconcileSessions\(false\),60000\)/);
  assert.match(html,/visibilitychange/);assert.match(html,/pageshow/);
});
test('HK holiday is excluded from category and industry without shrinking holding weights',()=>{
  const h=harness();h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-10-19',4,73.45),[HK.code]:quote(HK,'2026-10-16',-19.87,370.123)};
  const m=h.ctx._buildPortfolioAllocationModel(h.ctx.PORT,h.ctx._PORT_PRICES,h.state.now);
  for(const group of [m.categories[0],m.industries[0]]){
    assert.equal(group.weight,100);assert.equal(group.pct,4);assert.equal(group.pricedWeight,30);
    assert.equal(group.excludedWeight,70);assert.equal(group.pricedCount,1);assert.equal(group.excludedCount,1);
  }
  h.ctx.renderPortfolio();
  assert.equal(h.element('pKpiChange').textContent,'+4.00%');
  assert.equal(h.element('pKpiWeight').textContent,'100.0%');
  assert.match(h.element('portAllocLegend').innerHTML,/\+4\.00%/);
  assert.match(h.element('portIndustryLegend').innerHTML,/\+4\.00%/);
});
test('closed table replaces price with 休市 and removes all derived stale market metrics',()=>{
  const h=harness();h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-10-19',4,73.45),[HK.code]:quote(HK,'2026-10-16',-19.87,370.123)};
  h.ctx._PORT_5D_CLOSE['HK:'+HK.code]={high:400,low:300,highFrom:'2026-09-01',lowFrom:'2026-09-20',to:'2026-10-16'};
  h.ctx.renderPortfolio();const row=rowFor(h,HK.name);assertEmptyMarketFields(row,'休市');
  assert.doesNotMatch(row,/370\.123|19\.87|4\.56|2\.34|1\.23/);
  assert.match(rowFor(h,A.name),/73\.45/);
});
test('all Top7 ranks and weighted summaries exclude closed returns while heavy list keeps positions',()=>{
  const h=harness();h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-10-19',4,73.45),[HK.code]:quote(HK,'2026-10-16',-19.87,370.123)};
  h.ctx.renderPortTop3();
  for(const id of ['portTop3Up','portTop3Down']){
    assert.match(h.element(id).innerHTML,new RegExp(A.name));assert.doesNotMatch(h.element(id).innerHTML,new RegExp(HK.name));
    assert.match(h.element(id).innerHTML,/\+4\.00%/);assert.doesNotMatch(h.element(id).innerHTML,/19\.87|370\.123/);
  }
  const heavy=h.element('portTop5W').innerHTML;
  assert.match(heavy,new RegExp(HK.name));assert.match(heavy,/休市/);assert.match(heavy,/70\.0%/);
  assert.match(heavy,/port-top-weighted-value">\+4\.00%/);assert.doesNotMatch(heavy,/19\.87|370\.123/);
});
test('distribution and market averages reject closed HK quotes, not merely the table',()=>{
  const h=harness();h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-10-19',4),[HK.code]:quote(HK,'2026-10-16',-19.87)};
  h.ctx._renderPortBreadth();
  assert.equal(h.element('pUpCount').textContent,1);assert.equal(h.element('pDownCount').textContent,0);
  assert.equal(h.element('pABreadthAvg').textContent,'+4.00%');assert.equal(h.element('pHKBreadthAvg').textContent,'休市');
  assert.doesNotMatch(h.element('portBreadthDots').innerHTML,new RegExp(HK.name));
});
test('weekend all-closed keeps positions but never manufactures 0% returns',()=>{
  const h=harness('2026-10-18');h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-10-16',4),[HK.code]:quote(HK,'2026-10-16',-19.87)};
  const m=h.ctx._buildPortfolioAllocationModel(h.ctx.PORT,h.ctx._PORT_PRICES,h.state.now);
  assert.equal(m.categories[0].pct,null);assert.equal(m.categories[0].pricedWeight,0);assert.equal(m.categories[0].weight,100);
  h.ctx.renderPortfolio();h.ctx.renderPortTop3();
  assert.equal(h.element('pKpiChange').textContent,'休市 / 停牌');
  assert.match(h.element('portTop5W').innerHTML,/port-top-weighted-value">—/);
  assert.doesNotMatch(h.element('portTop5W').innerHTML,/port-top-weighted-value">0\.00%/);
  assert.match(h.element('portTop5W').innerHTML,new RegExp(A.name));assert.match(h.element('portTop5W').innerHTML,new RegExp(HK.name));
});
test('all-closed refresh button says 休市 rather than falsely claiming no holdings',async()=>{
  const h=harness('2026-10-18');h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-10-16',4),[HK.code]:quote(HK,'2026-10-16',-19.87)};
  await h.ctx._fetchPortfolioPricesRound();
  assert.match(h.element('portPriceTs').textContent,/休市/);assert.doesNotMatch(h.element('portPriceTs').textContent,/无持仓/);
  assert.equal(h.ctx.PORT.sectors[0].stocks.length,2);
});
test('explicit suspension at A 9:05 takes label priority over 未开盘 in table and heavy Top7',()=>{
  const h=harness('2026-10-20','09:05:00',[A]);
  h.ctx._PORT_PRICES={[A.code]:quote(A,'2026-10-19',9,88,{suspended:true})};
  h.ctx.renderPortfolio();const row=rowFor(h,A.name);
  assert.match(row,/data-quote-status="suspended">停牌/);assert.doesNotMatch(row,/未开盘/);
  assert.doesNotMatch(row,/88\.00|9\.00%/);
  assert.match(h.element('portTop5W').innerHTML,/现价 停牌/);assert.doesNotMatch(h.element('portTop5W').innerHTML,/未开盘/);
  assert.match(h.element('portTop5W').innerHTML,/port-top-weighted-value">—/);
});
test('inverse holiday A closed / HK open on 2026-10-02 uses HK only',()=>{
  const h=harness('2026-10-02');h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-09-30',18.5),[HK.code]:quote(HK,'2026-10-02',-2)};
  const m=h.ctx._buildPortfolioAllocationModel(h.ctx.PORT,h.ctx._PORT_PRICES,h.state.now);
  assert.equal(m.categories[0].pct,-2);assert.equal(m.categories[0].pricedWeight,70);assert.equal(m.categories[0].excludedWeight,30);
  h.ctx.renderPortfolio();h.ctx.renderPortTop3();
  assert.equal(h.element('pKpiChange').textContent,'-2.00%');assertEmptyMarketFields(rowFor(h,A.name),'休市');
  assert.doesNotMatch(h.element('portTop3Up').innerHTML,new RegExp(A.name));assert.match(h.element('portTop3Up').innerHTML,new RegExp(HK.name));
});
test('explicit suspension, no_trade, stale and undated quotes are excluded from live model',()=>{
  const h=harness();
  for(const [extra,expected] of [[{suspended:true},'suspended'],[{volume:0,amount:0},'no_trade'],[{quoteTs:ts('2026-10-16')},'stale'],[{quoteTs:null},'stale']]){
    h.ctx._PORT_PRICES={[A.code]:quote(A,'2026-10-19',9,88,extra)};
    const state=h.ctx._portStockState(A,h.ctx._PORT_PRICES[A.code],h.state.now);assert.equal(state.status,expected);
    assert.equal(Object.keys(h.ctx._portEffectivePrices(h.ctx._PORT_PRICES,h.state.now)).length,0);
    h.ctx.renderPortfolio();assert.equal(h.element('pKpiChange').textContent.includes('%'),false);
  }
});
test('record today never saves HK holiday price and normalizes historical return to eligible previous weight',async()=>{
  const h=harness();h.ctx.PORT.history=[{date:'2026-10-16',stocks:[{...A,w:20},{...HK,w:80}]}];
  h.ctx._PORT_PRICES={[A.code]:quote(A,'2026-10-19',4,73.45),[HK.code]:quote(HK,'2026-10-16',-19.87,370.123)};
  h.ctx._IDX_CACHE['中证全指']=quote(A,'2026-10-19',1.2,1200);
  await h.ctx.addHistRecord();
  const record=h.ctx.PORT.history[0],a=record.stocks.find(row=>row.code===A.code),hk=record.stocks.find(row=>row.code===HK.code);
  assert.equal(record.date,'2026-10-19');assert.equal(record.weight,100);assert.equal(record.portPct,4);assert.equal(record.csiPct,1.2);
  assert.equal(a.price,73.45);assert.equal(a.pct,4);assert.equal(a.returnEligible,true);
  assert.equal(hk.price,null);assert.equal(hk.pct,null);assert.equal(hk.returnEligible,false);assert.equal(hk.status,'market_closed');assert.equal(hk.w,70);
  assert.equal(h.state.tab,1);assert.equal(h.state.saved,1);assert.equal(h.state.remoteSaved,1);
});
test('history excludes suspended/no-trade/old/undated prices and returns, retaining holding metadata',async()=>{
  const h=harness('2026-10-20');
  const stocks=[A,{...A,code:'600001',name:'停牌测试',w:10},{...A,code:'600002',name:'无成交测试',w:10},
    {...A,code:'600003',name:'旧报价测试',w:10},{...A,code:'600004',name:'无时间测试',w:10}];
  h.ctx.PORT.sectors[0].stocks=clone(stocks);
  const extras=[{},{suspended:true},{volume:0,amount:0},{quoteTs:ts('2026-10-19')},{quoteTs:null}];
  stocks.forEach((stock,i)=>h.ctx._PORT_PRICES[stock.code]=quote(stock,'2026-10-20',i?30:2,100+i,extras[i]));
  await h.ctx.addHistRecord();const record=h.ctx.PORT.history[0];
  assert.equal(record.stocks.length,5);assert.equal(record.portPct,2);
  for(const stock of record.stocks.filter(row=>row.code!==A.code)){
    assert.equal(stock.price,null);assert.equal(stock.pct,null);assert.equal(stock.returnEligible,false);assert.ok(stock.name);assert.ok(stock.w>0);
  }
});
test('old zero-trade auction value is absent from post-open table, weighted return and history',async()=>{
  const h=harness('2026-10-20','10:30:00',[A]);
  h.ctx._PORT_PRICES={[A.code]:quote(A,'2026-10-20',3,88,{quoteTs:ts('2026-10-20','09:25:00'),volume:0,amount:0})};
  h.ctx.renderPortfolio();assertEmptyMarketFields(rowFor(h,A.name),'待更新');
  assert.equal(h.ctx._buildPortfolioAllocationModel(h.ctx.PORT,h.ctx._PORT_PRICES,h.state.now).categories[0].pct,null);
  await h.ctx.addHistRecord();const record=h.ctx.PORT.history[0];
  assert.equal(record.portPct,null);assert.equal(record.stocks[0].price,null);assert.equal(record.stocks[0].pct,null);
  assert.equal(record.stocks[0].status,'stale');assert.equal(record.stocks[0].returnEligible,false);
});
test('fully closed history records holdings only and no benchmark/return',async()=>{
  const h=harness('2026-10-18');h.ctx._PORT_PRICES={
    [A.code]:quote(A,'2026-10-16',4),[HK.code]:quote(HK,'2026-10-16',-19.87)};
  h.ctx._IDX_CACHE['中证全指']=quote(A,'2026-10-16',2,1000);
  await h.ctx.addHistRecord();const record=h.ctx.PORT.history[0];
  assert.equal(record.stocks.length,2);assert.equal(record.portPct,null);assert.equal(record.csiPct,null);
  record.stocks.forEach(stock=>{assert.equal(stock.price,null);assert.equal(stock.pct,null);assert.equal(stock.returnEligible,false);});
});
test('A preopen remains 0% while raw quote is untouched and history does not save previous price',async()=>{
  const h=harness('2026-10-20','09:05:00');
  h.ctx._PORT_PRICES={[A.code]:quote(A,'2026-10-19',8),[HK.code]:quote(HK,'2026-10-20',3,200,{quoteTs:ts('2026-10-20','09:05:00')})};
  const m=h.ctx._buildPortfolioAllocationModel(h.ctx.PORT,h.ctx._PORT_PRICES,h.state.now);
  assert.equal(m.categories[0].pct,2.1);assert.equal(h.ctx._PORT_PRICES[A.code].pct,8);
  h.ctx.renderPortfolio();assert.match(rowFor(h,A.name),/未开盘/);assert.match(rowFor(h,A.name),/0\.00%/);
  await h.ctx.addHistRecord();const record=h.ctx.PORT.history[0];
  assert.equal(record.portPct,null);assert.equal(record.stocks.find(row=>row.code===A.code).price,null);
  assert.equal(record.stocks.find(row=>row.code===HK.code).price,null);
});
test('date/session reconciliation clears previous-date returns without waiting for quote fetch',()=>{
  const h=harness('2026-10-19');h.ctx._PORT_PRICES={[A.code]:quote(A,'2026-10-19',4),[HK.code]:quote(HK,'2026-10-16',-19.87)};
  h.ctx._portReconcileSessions(true);assert.equal(h.element('pKpiChange').textContent,'+4.00%');
  h.state.now=ts('2026-10-20');h.ctx._portReconcileSessions(false);
  assert.equal(h.element('pKpiChange').textContent,'待当日行情');
  assert.match(rowFor(h,A.name),/待更新/);assert.match(rowFor(h,HK.name),/待更新/);
  assert.match(h.element('portTop5W').innerHTML,/port-top-weighted-value">—/);
  h.ctx._PORT_PRICES[HK.code]=quote(HK,'2026-10-20',-2);h.ctx.renderPortfolio();
  assert.equal(h.element('pKpiChange').textContent,'≈-2.00%');
});
test('market identity mismatches cannot turn another market quote into an eligible return',()=>{
  const h=harness();h.ctx._PORT_PRICES[A.code]=quote({...A,mkt:'HK'},'2026-10-19',20);
  assert.equal(h.ctx._portStockState(A,h.ctx._PORT_PRICES[A.code],h.state.now).canUseReturn,false);
  assert.equal(Object.keys(h.ctx._portEffectivePrices(h.ctx._PORT_PRICES,h.state.now)).length,0);
});
