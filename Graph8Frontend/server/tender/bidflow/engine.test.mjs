import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTenderDb} from '../database.mjs';
import {createEngine,defineGraph,describeGraph,END} from './engine.mjs';
import {classify} from './feeds.mjs';
import {country,ruleFit,titleRank} from './common.mjs';

const settle=async(engine,org,id,until=s=>s!=='running')=>{for(let i=0;i<200;i++){const r=engine.get(org,id);if(until(r.status))return r;await new Promise(r=>setTimeout(r,5));}throw new Error('run did not settle');};
const db=()=>openTenderDb(join(mkdtempSync(join(tmpdir(),'bidflow-')),'t.sqlite'));

// A miniature of the bid-pursuit shape: a conditional loop plus a human interrupt.
const graph=defineGraph({id:'demo',name:'Demo',description:'',start:'draft',
 nodes:{
  draft:{label:'Draft',kind:'rule',async run(s){return {patch:{version:(s.version||0)+1},summary:`v${(s.version||0)+1}`};}},
  review:{label:'Review',kind:'rule',async run(s){return {patch:{pass:s.version>=3}};}},
  approval:{label:'Approve',kind:'human',async run(){return {interrupt:{title:'Approve'},summary:'waiting'};}},
  ship:{label:'Ship',kind:'rule',async run(s){return {patch:{shipped:s.approval.note}};}},
 },
 edges:{draft:'review',review:{route:s=>s.pass?'pass':'revise',branches:{pass:'approval',revise:'draft'}},approval:{route:s=>s.approval?.decision==='approve'?'yes':'no',branches:{yes:'ship',no:END}},ship:END}});

test('Graph loops on a conditional edge, interrupts for approval and resumes to completion',async()=>{
 const d=db(),engine=createEngine(d,{demo:graph});
 const run=engine.start('org','demo',{actor:'u1',userId:'u1',tenderId:'t1',input:{}});
 const waiting=await settle(engine,'org',run.id);
 assert.equal(waiting.status,'awaiting_approval');
 assert.equal(waiting.state.version,3);
 assert.deepEqual(waiting.steps.filter(s=>s.node==='review').map(s=>s.branch),['revise','revise','pass']);
 assert.equal(engine.start('org','demo',{actor:'u1',userId:'u1',tenderId:'t1',input:{}}).id,run.id,'an active run is reused, not duplicated');
 engine.resume('org',run.id,'u1',{decision:'approve',note:'ok'});
 const done=await settle(engine,'org',run.id,s=>s==='completed');
 assert.equal(done.state.shipped,'ok');
 assert.equal(done.steps.find(s=>s.node==='approval').approvedBy,'u1');
 assert.ok(d.verifyAudit('org'),'every step is on the hash-chained audit log');
});

test('Rejection ends the run and failures are recorded on the failing node',async()=>{
 const d=db(),engine=createEngine(d,{demo:graph});
 const run=engine.start('org','demo',{actor:'u1',userId:'u1',tenderId:'t2',input:{version:5}});
 await settle(engine,'org',run.id);
 engine.resume('org',run.id,'u1',{decision:'reject'});
 const ended=await settle(engine,'org',run.id,s=>s==='completed');
 assert.equal(ended.state.shipped,undefined);
 const broken=defineGraph({id:'broken',name:'Broken',description:'',start:'a',nodes:{a:{label:'A',kind:'rule',async run(){throw new Error('boom');}}},edges:{a:END}});
 const e2=createEngine(d,{broken}),r2=e2.start('org','broken',{actor:'u1',userId:'u1',tenderId:'t3',input:{}});
 const failed=await settle(e2,'org',r2.id);
 assert.equal(failed.status,'failed');assert.match(failed.error,/A: boom/);assert.equal(failed.steps[0].status,'failed');
});

test('Loop guard stops runaway cycles',async()=>{
 const d=db(),loop=defineGraph({id:'loop',name:'Loop',description:'',start:'a',nodes:{a:{label:'A',kind:'rule',async run(){return {};}}},edges:{a:'a'}});
 const e=createEngine(d,{loop}),r=e.start('org','loop',{actor:'u',userId:'u',tenderId:'t',input:{}});
 const out=await settle(e,'org',r.id);assert.equal(out.status,'failed');assert.match(out.error,/Loop guard/);
});

test('Graph definitions validate edges and describe themselves for the UI',()=>{
 assert.throws(()=>defineGraph({id:'x',nodes:{a:{}},edges:{a:'missing'}}),/unknown node/);
 const d=describeGraph(graph);assert.equal(d.nodes.length,4);assert.ok(d.edges.some(e=>e.from==='review'&&e.label==='revise'&&e.to==='draft'));
});

test('Discovery helpers classify notices, normalise countries and rank contractors deterministically',()=>{
 assert.equal(classify('45000000',''),'Construction');assert.equal(classify('','Cloud software licences'),'Software & IT');assert.equal(classify('85100000',''),'Healthcare');
 assert.equal(country('PK'),'Pakistan');assert.equal(country('usa'),'United States');assert.equal(country('GBR'),'United Kingdom');
 const tender={budget:2e6,country:'United States'},parsed={location:{state:'Florida',country:'United States'},keywords:['hvac','chiller']},icp={industries:['Construction'],must_have:[]};
 const near=ruleFit({industry:'Construction',state:'Florida',country:'United States',employee_count:'201-500',description:'HVAC and chiller replacement'},{tender,parsed,icp});
 const far=ruleFit({industry:'Retail',state:'Ohio',country:'United States',employee_count:'10001+',description:'Groceries'},{tender,parsed,icp});
 assert.ok(near.score>far.score+40);
 assert.ok(titleRank('VP Preconstruction & Estimating')>titleRank('Director'));assert.ok(titleRank('HR Director')<0);
});
