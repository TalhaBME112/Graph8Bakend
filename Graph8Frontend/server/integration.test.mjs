import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('all three user journeys persist, isolate buyer access, and enforce execution boundaries', async t => {
  const folder = await mkdtemp(join(tmpdir(),'graph8-tests-'));
  const port = 4397, base = `http://127.0.0.1:${port}`;
  const env = {...process.env,PORT:String(port),G8_WORKSPACE_FILE:join(folder,'workspace.json'),G8_API_KEY:'',ADMIN_TOKEN:'test-admin'};
  let child;
  async function start() { child = spawn(process.execPath,['server/index.mjs'],{env,stdio:['ignore','pipe','pipe']}); await new Promise((resolve,reject)=>{child.stdout.once('data',resolve); child.once('error',reject); child.once('exit',code=>reject(new Error(`Server exited ${code}`)));}); }
  async function stop() { if(child && child.exitCode === null) { const p = new Promise(r=>child.once('exit',r)); child.kill(); await p; } }
  t.after(async()=>{await stop();await rm(folder,{recursive:true,force:true});}); await start();
  async function request(path,method='GET',body,publicAccess=false) { const r = await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json','X-Workspace-Client':'test',...(publicAccess?{}:{Authorization:'Bearer test-admin'})},body:body===undefined?undefined:JSON.stringify(body)}); return {status:r.status,data:await r.json()}; }
  assert.equal((await request('workspace','GET',undefined,true)).status,401);
  assert.equal((await request('status')).data.configured,false);
  const room=(await request('rooms','POST',{name:'Acme evaluation',company:'Acme',summary:'An agreed path to launch.',dealId:'private-deal'})).data;
  assert.ok(room.id);
  await request(`rooms/${room.id}/milestones`,'POST',{title:'Review scope',owner:'Buyer',due:'2026-10-15'});
  assert.equal((await request(`rooms/${room.id}/documents`,'POST',{title:'Bad',url:'javascript:alert(1)'})).status,400);
  await request(`rooms/${room.id}/documents`,'POST',{title:'Overview',url:'https://example.com/overview'});
  await request(`rooms/${room.id}/share`,'POST',{enabled:true});
  const shared=(await request('workspace')).data.rooms[0];
  const buyer=(await request('public/'+shared.shareToken,'GET',undefined,true)).data;
  assert.equal(buyer.dealId,undefined); assert.equal(buyer.shareToken,undefined); assert.equal(buyer.milestones.length,1);
  assert.equal((await request(`public/${shared.shareToken}/questions`,'POST',{author:'Buyer',question:'Can we start in October?'},true)).status,201);
  let state=(await request('workspace')).data;
  await request(`rooms/${room.id}/questions/${state.rooms[0].questions[0].id}`,'PATCH',{answer:'Yes, pending scope approval.'});
  assert.equal((await request('public/'+shared.shareToken,'GET',undefined,true)).data.questions[0].answer,'Yes, pending scope approval.');
  await request(`rooms/${room.id}/share`,'POST',{enabled:false}); assert.equal((await request('public/'+shared.shareToken,'GET',undefined,true)).status,404);
  const e=(await request('experiments','POST',{name:'Messaging',hypothesis:'Outcomes improve replies',metric:'Reply',variantA:'Problem',variantB:'Outcome',minimum:30})).data;
  await request(`experiments/${e.id}/participants`,'POST',{contacts:['c1','c2','c1']});
  await request(`experiments/${e.id}`,'PATCH',{status:'running'});
  assert.equal((await request(`experiments/${e.id}`,'PATCH',{status:'completed'})).status,400);
  await request(`experiments/${e.id}/outcomes`,'PATCH',{contactId:'c1',converted:true});
  await request(`experiments/${e.id}/outcomes`,'PATCH',{contactId:'c2',converted:false});
  await request(`experiments/${e.id}`,'PATCH',{status:'completed'});
  state=(await request('workspace')).data; assert.equal(state.experiments[0].participants.length,2); assert.match(state.experiments[0].result.verdict,/Inconclusive/);
  assert.equal((await request(`experiments/${e.id}/outcomes`,'PATCH',{contactId:'c1',converted:false})).status,400);
  const goal=(await request('goals','POST',{name:'Win new opportunities',audience:'SaaS leaders',target:10,metric:'Meetings',budget:500,deadline:'2026-10-30'})).data;
  assert.equal((await request(`goals/${goal.id}/execute`,'POST',{stepId:goal.steps[0].id,approved:true})).status,400);
  await request(`goals/${goal.id}`,'PATCH',{status:'active'});
  assert.equal((await request(`goals/${goal.id}/execute`,'POST',{stepId:goal.steps[0].id,approved:false})).status,400);
  await request(`goals/${goal.id}/execute`,'POST',{stepId:goal.steps[0].id,approved:true});
  await request(`goals/${goal.id}/execute`,'POST',{stepId:goal.steps[0].id,approved:true});
  state=(await request('workspace')).data; assert.equal(state.experiments.length,2); assert.equal(state.goals[0].receipts.length,1);
  await request(`goals/${goal.id}/execute`,'POST',{stepId:goal.steps[1].id,approved:true});
  assert.equal((await request(`goals/${goal.id}/execute`,'POST',{stepId:goal.steps[2].id,approved:true})).status,503);
  await request(`goals/${goal.id}`,'PATCH',{status:'paused'});
  assert.equal((await request(`goals/${goal.id}/execute`,'POST',{stepId:goal.steps[2].id,approved:true})).status,400);
  await stop(); await start(); state=(await request('workspace')).data; assert.equal(state.rooms.length,2); assert.equal(state.goals[0].status,'paused');
  const denied=await fetch(base+'/api/rooms',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{}'}); assert.equal(denied.status,403);
});
