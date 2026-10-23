'use strict';
const fs=require('node:fs'),path=require('node:path');
const api=require('../../assets/intraday-indices.js');
async function main(){
  const output=path.resolve(process.argv[2]||'data/intraday_indices.json'),client=api.createClient({snapshots:false});
  if(fs.existsSync(output))client.ingest(JSON.parse(fs.readFileSync(output,'utf8')));
  const before=JSON.stringify(client.payload().series);
  await Promise.all(['style','rotation'].map(group=>client.refresh(group)));
  const data=client.payload();
  if(!data.series.length)throw Error('No validated curves; existing snapshot retained');
  if(JSON.stringify(data.series)!==before){fs.mkdirSync(path.dirname(output),{recursive:true});const temporary=output+'.tmp';fs.writeFileSync(temporary,JSON.stringify(data)+'\n');fs.renameSync(temporary,output);}
  console.log(JSON.stringify({series:data.series.map(r=>({key:r.key,date:r.date,asOf:r.points.at(-1).time,points:r.points.length,source:r.source}))}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
