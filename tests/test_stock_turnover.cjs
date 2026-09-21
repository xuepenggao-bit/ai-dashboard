const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(process.env.TEST_HTML||path.join(__dirname,'../index.html'),'utf8');
const helpers=html.slice(html.indexOf('function _portTurnoverRate('),html.indexOf('function togglePortSort('));
const fetching=html.slice(html.indexOf('async function fetchPortPrices(){'),html.indexOf('function renderPortTop3(){'));
const fields=(hk,rate)=>{const p=Array(81).fill('');p[3]='426.8';p[32]='1.86';p[38]=hk?'0':rate;p[59]=hk?rate:'0';p[49]='5.12';p[50]='8.17';p[45]='1000';return p.join('~');};
let emRate=null,aRate='0.16',hkRate='0.03';
const dom={textContent:'',title:'',classList:{add(){},remove(){},contains(){return false;}}};
const ctx=vm.createContext({console,Date,Number,AbortController,TextDecoder,setTimeout,clearTimeout,
  _pfInflight:false,_PORT_PRICES:{},_portSort:{},_TAB_TS:{},
  PORT:{sectors:[{stocks:[{code:'300750',name:'宁德时代',mkt:'SZ',w:5},{code:'00700',name:'腾讯控股',mkt:'HK',w:3}]}]},
  _escH:String,portLoad(){},_isTradingNow:()=>false,
  document:{getElementById:()=>dom},
  renderPortfolio(){},renderPortTop3(){},_renderPortTopW(){},fetchPortFiveDayRanges:async()=>{},
  _fetchSinaRT:async()=>({rt_hk00700:{price:426.8,pct:1.86,quoteTs:Date.now()}}),
  fetch:async url=>({ok:true,
    arrayBuffer:async()=>Buffer.from(url.includes('r_hk')?'v_r_hk00700="'+fields(true,hkRate)+'";':'v_sz300750="'+fields(false,aRate)+'";'),
    json:async()=>url.includes('116.')?{data:{diff:emRate==null?[]:[{f12:'00700',f2:426.8,f3:1.86,f8:emRate,f124:Date.now()/1000}]}}:{data:{diff:[]}}
  })
});
vm.runInContext(helpers+fetching,ctx);
module.exports=(async()=>{
  for(const value of [null,undefined,'',' ','-','abc',-1,NaN]) assert.equal(ctx._portTurnoverRate(value),null);
  assert.equal(ctx._portTurnoverRate('0'),0);
  assert.equal(ctx._portTurnoverRate('123.45'),123.45,'Turnover can exceed 100%');
  assert.ok(ctx._portTurnoverCell({turnoverRate:0},false).includes('0.00%'));
  assert.ok(ctx._portTurnoverCell({turnoverRate:null},false).includes('—'));
  assert.ok(ctx._portTurnoverCell({turnoverRate:1},true).includes('—'),'Pre-open must not show yesterday rate');
  assert.ok(ctx._portTurnoverCompare(null,1,1)>0&&ctx._portTurnoverCompare(null,1,-1)>0,'Missing rates sort last');
  await ctx.fetchPortPrices();
  assert.equal(ctx._PORT_PRICES['300750'].turnoverRate,.16);
  assert.equal(ctx._PORT_PRICES['00700'].turnoverRate,.03,'HK must use field 59, not placeholder field 38');
  assert.equal(ctx._PORT_PRICES['00700'].turnoverSource,'腾讯实时');
  emRate=.08;
  await ctx.fetchPortPrices();
  assert.equal(ctx._PORT_PRICES['00700'].turnoverRate,.08,'EM metric stays with its primary quote');
  emRate=null;aRate='0';hkRate='-';
  await ctx.fetchPortPrices();
  assert.equal(ctx._PORT_PRICES['300750'].turnoverRate,0);
  assert.equal(ctx._PORT_PRICES['00700'].turnoverRate,undefined,'Missing HK metric must not become 0 or stale prior value');
  assert.match(html,/个股仓位 \$\{wArrow\}<\/th>\s*<th[^\n]*换手率/);
  assert.match(html,/col-weight port-cell-momentum[^\n]*\n\s*<td class="col-turnover/);
  assert.ok(html.includes('colspan="13"'));
  return 'PASS: A/HK field mapping, realtime HK supplement, EM priority, zero/missing values, pre-open, sorting and 13-column layout';
})();
