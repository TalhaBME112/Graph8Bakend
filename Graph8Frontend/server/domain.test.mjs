import test from 'node:test';
import assert from 'node:assert/strict';
import { assignment, experimentResult, createExperiment, createGoal, safeUrl, date, publicRoom } from './domain.mjs';

test('assignment is stable across runs and splits a cohort into both variants', () => {
  const first = Array.from({length:1000}, (_,i) => assignment('experiment', String(i)));
  assert.deepEqual(first, Array.from({length:1000}, (_,i) => assignment('experiment', String(i))));
  const count = first.filter(x => x === 'A').length; assert.ok(count > 400 && count < 600);
});
test('running tests and small samples never declare a winner', () => {
  const e = {minimum:30,status:'running',participants:Array.from({length:100},(_,i)=>({variant:i<50?'A':'B',converted:i<50}))};
  assert.match(experimentResult(e).verdict,/Directional/);
  e.status = 'completed'; assert.match(experimentResult(e).verdict,/Variant A leads/);
  e.participants = e.participants.slice(0,2); assert.match(experimentResult(e).verdict,/Inconclusive/);
});
test('unobserved outcomes do not count as failures or allow final conclusions', () => {
  const result = experimentResult({minimum:30,status:'completed',participants:[{variant:'A',converted:null},{variant:'B',converted:true}]});
  assert.equal(result.A.observed,0); assert.equal(result.A.enrolled,1); assert.equal(result.B.rate,1); assert.match(result.verdict,/Inconclusive/);
});
test('uncertainty intervals are finite at zero and full conversion', () => {
  for (const converted of [false,true]) {
    const r = experimentResult({status:'running',participants:[{variant:'A',converted}]});
    assert.ok(Number.isFinite(r.A.low) && Number.isFinite(r.A.high)); assert.ok(r.A.low >= 0 && r.A.high <= 1);
  }
});
test('dangerous resource URLs and invalid dates are rejected', () => {
  for (const url of ['javascript:alert(1)','http://example.com','https://user:secret@example.com']) assert.throws(()=>safeUrl(url));
  assert.equal(safeUrl('https://example.com/guide'),'https://example.com/guide');
  assert.throws(()=>date('2026-02-30')); assert.equal(date('2026-10-01'),'2026-10-01');
});
test('creation validates targets, minimum sample sizes and required fields', () => {
  assert.throws(()=>createExperiment({ name:'Test',hypothesis:'X',metric:'Reply',variantA:'A',variantB:'B',minimum:2 }));
  assert.throws(()=>createGoal({name:'Goal',audience:'Buyers',target:-1,metric:'Meetings',budget:0,deadline:'2026-10-01'}));
});
test('public room representation excludes private Graph8 IDs and access tokens', () => {
  const r = publicRoom({id:'room',name:'Name',company:'Company',summary:'Summary',dealId:'private',shareToken:'secret',views:23,milestones:[],documents:[],questions:[]});
  assert.equal(r.shareToken,undefined); assert.equal(r.dealId,undefined); assert.equal(r.views,undefined);
});
