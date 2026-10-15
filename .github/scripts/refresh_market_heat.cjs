#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const repo=path.resolve(__dirname,'../..');
let enginePath=path.join(repo,'assets/market-heat-engine.js');
if(!fs.existsSync(enginePath))enginePath='/private/tmp/market-heat-engine.js';
const engine=require(enginePath);
const inputFlag=process.argv.indexOf('--input-dir'),outputFlag=process.argv.indexOf('--output'),supportFlag=process.argv.indexOf('--support');
const inputDir=inputFlag>=0?path.resolve(process.argv[inputFlag+1]):path.join(repo,'data');
const output=outputFlag>=0?path.resolve(process.argv[outputFlag+1]):path.join(repo,'data/market_heat.json');
const files={quality:'market_quality.json',ma:'market_ma_breadth.json',breadth:'market_breadth_history.json',highLow:'market_high_low_52w.json',risk:'market_risk.json',etf:'etf_shares.json',amountHistory:'market_heat_amount_history.json',margin:'market_heat_margin_history.json'};
let input={};
for(const [key,name]of Object.entries(files)){
  const source=path.join(inputDir,name);
  if(!fs.existsSync(source)){input[key]={series:[]};continue;}
  input[key]=JSON.parse(fs.readFileSync(source,'utf8'));
}
const supportFile=supportFlag>=0?path.resolve(process.argv[supportFlag+1]):path.join(inputDir,'market_heat_support.json');
if(!fs.existsSync(supportFile))throw new Error('market heat support file is required');
const support=JSON.parse(fs.readFileSync(supportFile,'utf8'));
input=engine.combineSupport(input,support);
const previous=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):null;
const computed=engine.build(input),result=engine.retainPublished(previous,computed),latest=result.series.at(-1);
result.inputDates=Object.fromEntries(Object.entries(input).filter(([_,v])=>v&&typeof v==='object'&&!Array.isArray(v)).map(([key,value])=>[key,{updatedAt:value.updatedAt||null,latestDate:Array.isArray(value.series)?value.series.at(-1)?.date||null:value.asOf||null}]));
result.inputDates.support={updatedAt:support.updatedAt||null,latestDate:support.calendar.at(-1)||null};
fs.mkdirSync(path.dirname(output),{recursive:true});
const tmp=output+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result,null,2)+'\n');fs.renameSync(tmp,output);
console.log(JSON.stringify({output,dates:result.series.length,valid:result.series.filter(r=>r.score!==null).length,latest:{date:latest.date,score:latest.score,coveragePct:latest.coveragePct}}));
