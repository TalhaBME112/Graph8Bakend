import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { createExperiment,createGoal,createRoom } from './domain.mjs';
import { featureRoute,ingestOutcome } from './features.mjs';

test('event ingestion authenticates, deduplicates, rejects stale data and updates goal progress',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'graph8-events-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=await openStore(join(dir,'state.json'));
 const e=createExperiment({name:'Test',hypothesis:'Testing outcomes',metric:'Replies',variantA:'A',variantB:'B'});e.status='running';e.eventKey='secret';e.participants=[{contactId:'c1',variant:'A',converted:null},{contactId:'c2',variant:'B',converted:null}];
 const g=createGoal({name:'Goal',audience:'Audience',target:5,metric:'Replies',budget:0,deadline:'2026-12-31'});g.progressExperimentId=e.id;
 await store.update(s=>{s.experiments.push(e);s.goals.push(g);});const body={eventId:'first',contactId:'c1',converted:true,occurredAt:new Date().toISOString()};
 await assert.rejects(ingestOutcome(store,e.id,'wrong',body),{status:401});
 assert.equal((await ingestOutcome(store,e.id,'secret',body)).accepted,true);assert.equal(store.read().goals[0].achieved,1);
 assert.equal((await ingestOutcome(store,e.id,'secret',body)).duplicate,true);assert.equal(store.read().experiments[0].events.length,1);
 await assert.rejects(ingestOutcome(store,e.id,'secret',{...body,eventId:'stale',occurredAt:'2020-01-01T00:00:00Z'}),{status:409});
 await assert.rejects(ingestOutcome(store,e.id,'secret',{...body,eventId:'missing',contactId:'absent'}),{status:404});
 const route=(action,b,method='POST')=>featureRoute({store,p:['api','experiments',e.id,action],method,b,busy:new Set()});
 await assert.rejects(route('import-outcomes',{rows:[{contactId:'c1',converted:false},{contactId:'absent',converted:true}]}));
 assert.equal(store.read().experiments[0].participants[0].converted,true,'invalid CSV rolls back the whole import');
 await assert.rejects(route('details',{name:'Changed'},'PATCH'),{status:409});
 await route('event-key',{});await assert.rejects(ingestOutcome(store,e.id,'secret',{...body,eventId:'rotated'}),{status:401});
 const cloned=await route('clone',{});assert.equal(cloned.status,'draft');assert.equal(cloned.participants.length,0);assert.equal(cloned.previousExperimentId,e.id);
});

test('archiving revokes public access and plan changes respect state and execution locks',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'graph8-plans-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=await openStore(join(dir,'state.json'));
 const r=createRoom({name:'Deal',company:'Acme',summary:'Review'});r.shareToken='link';
 const g=createGoal({name:'Goal',audience:'Audience',target:5,metric:'Replies',budget:0,deadline:'2026-12-31'});
 await store.update(s=>{s.rooms.push(r);s.goals.push(g);});
 await featureRoute({store,p:['api','rooms',r.id],method:'PATCH',b:{archived:true},busy:new Set()});assert.equal(store.read().rooms[0].shareToken,null);
 const route=(b,busy=new Set())=>featureRoute({store,p:['api','goals',g.id,'steps',g.steps[0].id],method:'PATCH',b,busy});
 const change={title:'Message experiment',detail:'Compare two offers',config:{name:'Offer test',variantA:'Trial',variantB:'Demo'}};await route(change);assert.equal(store.read().goals[0].steps[0].config.variantA,'Trial');
 await assert.rejects(route(change,new Set([g.id])),{status:409});
 await store.update(s=>{s.goals[0].status='active';});await assert.rejects(route(change));
});
