import test from 'node:test';
import assert from 'node:assert/strict';
import { draftCampaign } from './graph8.mjs';

test('campaign SDK transport uses one attempt, stable idempotency and no document generation',async()=>{
 const original=process.env.G8_API_KEY;process.env.G8_API_KEY='test-fixture-key';
 const goal={id:'goal-one',stepId:'step-one',name:'Growth',audience:'SaaS',target:5,metric:'Meetings',deadline:'2026-12-31',budget:500};
 try{
  const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({data:{id:'campaign-fixture'}}),{status:201,headers:{'Content-Type':'application/json'}});};
  const response=await draftCampaign(goal,{fetchImpl});assert.equal(response.data.id,'campaign-fixture');assert.equal(calls.length,1);
  const {options,url}=calls[0];assert.equal(options.method,'POST');assert.match(String(url),/\/campaigns$/);assert.equal(new Headers(options.headers).get('Idempotency-Key'),'growth-goal-one-step-one');assert.equal(JSON.parse(options.body).auto_generate_documents,false);
  let attempts=0;await assert.rejects(draftCampaign(goal,{fetchImpl:async()=>{attempts++;return new Response(JSON.stringify({error:'Temporary failure'}),{status:503});}}));assert.equal(attempts,1);
 }finally{if(original===undefined)delete process.env.G8_API_KEY;else process.env.G8_API_KEY=original;}
});
