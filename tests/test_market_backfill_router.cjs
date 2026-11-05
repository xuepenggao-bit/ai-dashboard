const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {ALLOWED,validateRequest,route}=require('../.github/scripts/route_market_backfill.cjs');
const NOW=Date.parse('2026-11-05T04:00:00Z');
const request=workflows=>({schemaVersion:1,requestId:'market-test-1234',requestedAt:new Date(NOW).toISOString(),workflows});
function harness(files,overrides={}){let now=NOW,id=10;const events=[],writes=[],runs=new Map();
  const options={now:()=>now,sleep:async ms=>{now+=ms;},writeStatus:async p=>writes.push(JSON.parse(JSON.stringify(p))),
    listRuns:async()=>[],dispatch:async file=>{events.push(file);const n=++id;runs.set(n,file);return{workflow_run_id:n};},
    getRun:async n=>({id:n,head_branch:'main',status:'completed',conclusion:'success'}),...overrides};
  return{go:()=>route(request(files),options),events,writes,options};}
test('only explicit bounded workflow names and fresh credential-free request metadata are accepted',()=>{
  assert.equal(validateRequest(request(ALLOWED),NOW).workflows.length,ALLOWED.length);
  for(const bad of [{...request(ALLOWED),workflows:['arbitrary.yml']},{...request(ALLOWED),workflows:[]},{...request(ALLOWED),requestId:'../../oops'},
    {...request(ALLOWED),requestedAt:'2030-01-01'},{...request(ALLOWED),requestedAt:'2025-01-01'},{...request(ALLOWED),schemaVersion:0}])assert.throws(()=>validateRequest(bad,NOW));
});
test('heat waits for the actual upstream completion and state complete is not set at dispatch time',async()=>{
  const h=harness(['refresh-market-heat.yml','refresh-market-breadth.yml']);await h.go();
  assert.deepEqual(h.events,['refresh-market-breadth.yml','refresh-market-heat.yml']);
  assert.equal(h.writes[0].state,'running');assert.equal(h.writes.at(-1).state,'complete');
  assert.equal(h.writes.at(-1).jobs.every(j=>j.status==='completed'&&j.conclusion==='success'),true);
});
test('an existing active main-branch collector is reused without another dispatch',async()=>{
  const h=harness(['refresh-market-risk.yml'],{listRuns:async()=>[{id:27,head_branch:'main',status:'in_progress',created_at:new Date(NOW-60000).toISOString()}]});
  await h.go();assert.equal(h.events.length,0);assert.equal(h.writes.at(-1).jobs[0].runId,27);assert.equal(h.writes.at(-1).jobs[0].reused,true);
});
test('failed upstream is recorded and does not start a stale heat recomputation',async()=>{
  const h=harness(['refresh-market-risk.yml','refresh-market-heat.yml'],{getRun:async id=>({id,head_branch:'main',status:'completed',conclusion:'failure'})});await h.go();
  assert.deepEqual(h.events,['refresh-market-risk.yml']);assert.equal(h.writes.at(-1).state,'failed');assert.equal(h.writes.at(-1).jobs[1].conclusion,'skipped');
});
test('an already-running heat job is not reused after upstream snapshots have changed',async()=>{
  const h=harness(['refresh-market-risk.yml','refresh-market-heat.yml'],{listRuns:async file=>file==='refresh-market-heat.yml'?[{id:9,head_branch:'main',status:'in_progress',created_at:new Date(NOW-60000).toISOString()}]:[]});
  await h.go();assert.deepEqual(h.events,['refresh-market-risk.yml','refresh-market-heat.yml']);assert.notEqual(h.writes.at(-1).jobs[1].runId,9);
});
test('legacy 204 finds a new matching dispatch run rather than relabeling an earlier success',async()=>{
  let calls=0;const h=harness(['refresh-etf-shares.yml'],{dispatch:async()=>null,listRuns:async()=>++calls===1?[{id:1,status:'completed'}]:[{id:1,status:'completed'},{id:2,head_branch:'main',event:'workflow_dispatch',status:'queued',created_at:new Date(NOW).toISOString()}]});
  await h.go();assert.equal(h.writes.at(-1).jobs[0].runId,2);
});
test('bounded monitoring timeout stays running, never claims a still-running collector failed',async()=>{
  const h=harness(['refresh-high-low-52w.yml'],{maxMs:20000,getRun:async id=>({id,head_branch:'main',status:'in_progress',conclusion:null})});await h.go();
  assert.equal(h.writes.at(-1).state,'running');assert.equal(h.writes.at(-1).monitoringStopped,true);
});
test('workflow has a request-only push trigger and scoped authentication, no saved PAT',()=>{
  const text=fs.readFileSync(require('node:path').join(__dirname,'../.github/workflows/refresh-market-backfill.yml'),'utf8');
  assert.match(text,/data\/market_refresh_request\.json/);assert.match(text,/actions: write/);assert.match(text,/GH_TOKEN: \$\{\{ github.token \}\}/);assert.doesNotMatch(text,/secrets\.[A-Z_]*TOKEN/);
});
test('browser and server agree on allowlisted collectors, all support manual dispatch',()=>{
  const path=require('node:path'),browser=require('../assets/market-backfill-refresh.js');
  assert.deepEqual([...ALLOWED].sort(),[...browser.WORKFLOWS].sort());
  for(const file of ALLOWED)assert.match(fs.readFileSync(path.join(__dirname,'../.github/workflows',file),'utf8'),/workflow_dispatch:/,file);
});
