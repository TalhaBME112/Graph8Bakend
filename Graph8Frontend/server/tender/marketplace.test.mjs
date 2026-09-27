import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTenderDb} from './database.mjs';
import {createMarketplace,matchTender} from './marketplace.mjs';
import {tenderUrl} from './model.mjs';

test('Tender registration accepts native tenders and normalizes official URLs',()=>{assert.equal(tenderUrl(''),'');assert.equal(tenderUrl('procurement.example/tender'),'https://procurement.example/tender');assert.throws(()=>tenderUrl('not a valid link'),/Official tender URL/);assert.throws(()=>tenderUrl('javascript:alert(1)'));assert.throws(()=>tenderUrl('https://name:secret@example.com'));});
test('Relevance is explained and geographic constraints are enforced',()=>{const t={category:'Consulting',country:'Pakistan',title:'Cloud strategy',description:'Cloud services'};assert.equal(matchTender(t,{categories:['Consulting'],countries:['Canada'],services:'Cloud'}).eligibleForMatch,false);assert.equal(matchTender(t,{categories:['Consulting'],countries:[],services:'Cloud'}).eligibleForMatch,true);});
test('Issuer → two private bids → evaluation → award, with isolation and revisions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'g8-market-test-')),db=openTenderDb(join(dir,'test.sqlite'));const market=createMarketplace(db,{readResource:async()=>({rows:[{id:1,name:'Live CRM company',description:'Cloud consulting'}],checkedAt:new Date().toISOString()})});
 const issuer={id:'issuer',name:'Issuer',role:'issuer'},otherIssuer={id:'issuer2',name:'Other issuer',role:'issuer'},alice={id:'a',name:'Alice',role:'contributor'},bob={id:'b',name:'Bob',role:'contributor'};
 async function call(user,path,method='GET',b={},org='org1'){let result;await market.route({org:{id:org},user,p:['market',...path.split('/')],method,b,send:v=>{result=v;},res:{writeHead(){},end(v){result=v;}}});return result;}
 try{
  const body={title:'Cloud consulting',description:'Provide a cloud readiness review with evidenced qualifications.',category:'Consulting',country:'Pakistan',currency:'USD',budget:10000,deadline:'2099-01-01T00:00:00Z'};
  // Unified B2B accounts: bidders may also issue tenders (covered in the dual-role test below).
  let t=await call(issuer,'tenders','POST',body);assert.equal(t.sourceUrl,'');assert.equal((await call(alice,'tenders')).length,0);
  await assert.rejects(call(otherIssuer,`tenders/${t.id}/publish`,'POST',{revision:t.revision}),/another account/);
  t=await call(issuer,`tenders/${t.id}/document`,'POST',{revision:t.revision,name:'specification.txt',base64:Buffer.from('Tender specification').toString('base64')});
  await assert.rejects(call(alice,`tenders/${t.id}/document/${t.documents[0].id}`),/Document not found/);
  t=await call(issuer,`tenders/${t.id}/publish`,'POST',{revision:t.revision});assert.equal((await call(alice,'tenders')).length,1);assert.equal((await call(alice,'tenders','GET',{},'org2')).length,0);
  for(const u of [alice,bob])await call(u,'profile','PATCH',{company:u.name,services:'Cloud consulting backed by documented client delivery.',categories:'Consulting',countries:'Pakistan',autoDraft:true});
  const aRun=await call(alice,'agent','POST');assert.equal(aRun.created,1);assert.equal((await call(alice,'agent','POST')).created,0);
  let a=(await call(alice,'bids'))[0];let b=await call(bob,`tenders/${t.id}/draft`,'POST');assert.equal((await call(issuer,`tenders/${t.id}/bids`)).length,0);
  await assert.rejects(call(bob,`bids/${a.id}/export`),/Bid not found/);await assert.rejects(call(issuer,`bids/${a.id}/export`),/Bid not found/);
  const payload={proposal:'We propose a cloud readiness assessment with stakeholder interviews, architecture review, an evidence register and final recommendations.',amount:8000,deliveryDays:20,evidence:'Signed client reference and delivery checklist.'};
  a=await call(alice,`bids/${a.id}`,'PATCH',{...payload,revision:a.revision});
  await assert.rejects(call(alice,`bids/${a.id}`,'PATCH',{...payload,revision:1}),/changed/);
  t=await call(issuer,`tenders/${t.id}/amend`,'POST',{revision:t.revision,note:'Include a security workshop.'});
  await assert.rejects(call(alice,`bids/${a.id}/submit`,'POST',{revision:a.revision,approved:true}),/Tender changed/);
  a=await call(alice,`bids/${a.id}`,'PATCH',{...payload,revision:a.revision});
  a=await call(alice,`bids/${a.id}/document`,'POST',{revision:a.revision,name:'evidence.txt',base64:Buffer.from('Private supplier evidence').toString('base64')});
  a=await call(alice,`bids/${a.id}/submit`,'POST',{revision:a.revision,approved:true});assert.ok(a.receipt);
  const firstReceipt=a.receipt;a=await call(alice,`bids/${a.id}/revise`,'POST',{revision:a.revision});assert.equal(a.status,'draft');assert.equal(a.history.at(-1).receipt,firstReceipt);a=await call(alice,`bids/${a.id}/submit`,'POST',{revision:a.revision,approved:true});assert.notEqual(a.receipt,firstReceipt);
  await assert.rejects(call(alice,`bids/${a.id}`,'PATCH',{...payload,revision:a.revision}),/Only drafts/);
  await assert.rejects(call(bob,`bids/${a.id}/document/${a.documents[0].id}`),/Bid not found/);
  assert.equal((await call(issuer,`bids/${a.id}/document/${a.documents[0].id}`)).toString(),'Private supplier evidence');
  b=await call(bob,`bids/${b.id}`,'PATCH',{...payload,amount:9000,revision:b.revision});b=await call(bob,`bids/${b.id}/submit`,'POST',{revision:b.revision,approved:true});
  assert.equal((await call(issuer,`tenders/${t.id}/bids`)).length,2);assert.equal((await call(issuer,'summary')).issuerPipeline.length,2);assert.equal((await call(alice,'summary')).issuerPipeline.length,0);await assert.rejects(call(alice,`tenders/${t.id}/recommendations`),/another account/);assert.equal((await call(alice,'bids')).length,1);
  a=await call(issuer,`bids/${a.id}/shortlist`,'POST',{revision:a.revision,technical:85,commercial:90,note:'Meets published evaluation criteria.'});
  await assert.rejects(call(issuer,`tenders/${t.id}/award`,'POST',{revision:t.revision,bidId:a.id,bidRevision:a.revision,approved:true,reason:'Best evaluated offer'}),/after the tender closes/);
  t=db.update('org1','market-tender',t.id,'test','test:clock',r=>r.deadline='2000-01-01T00:00:00Z');
  t=await call(issuer,`tenders/${t.id}/award`,'POST',{revision:t.revision,bidId:a.id,bidRevision:a.revision,approved:true,reason:'Best evaluated offer'});assert.equal(t.status,'awarded');assert.equal(t.award.comparison,undefined);assert.equal((await call(otherIssuer,'tenders')).length,1,'award notices stay visible to other organisations as history');assert.equal((await call(alice,'tenders')).length,1);await assert.rejects(call(alice,`tenders/${t.id}/draft`,'POST'),/closed/);assert.equal((await call(alice,'bids'))[0].status,'awarded');assert.equal((await call(bob,'bids'))[0].status,'rejected');assert.equal((await call(alice,'summary')).stats.historicalWinRate,null);assert.equal(db.verifyAudit('org1'),true);
  assert.equal(readFileSync(join(dir,'test.sqlite')).includes(Buffer.from('Private supplier evidence')),false);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('Graph8 AI enforces scopes, restricts execution to LLM skills and validates final text',async()=>{
 const {graph8BidDraft}=await import('./ai.mjs');const old=process.env.TENDER_LLM_SKILL_ID;process.env.TENDER_LLM_SKILL_ID='approved-skill';let calls=0;
 try{
 await assert.rejects(graph8BidDraft({scopes:['workflows:read']},{},async()=>{calls++;}),/requires workflows:run/);assert.equal(calls,0);
 await assert.rejects(graph8BidDraft({scopes:['workflows:read','workflows:run']},{},async()=>({type:'api'})),/only permits/);
 const result=await graph8BidDraft({scopes:['workflows:read','workflows:run']},{evidence:'verified'},async(op,input,opts)=>{if(op.startsWith('get_skill'))return {type:'llm'};assert.equal(opts.maxRetries,0);assert.match(input.body.source_text,/verified/);return {result:'This is a generated proposal based on supplied evidence and it requires human review.'};});assert.equal(result.reviewRequired,true);
 await assert.rejects(graph8BidDraft({scopes:['workflows:run']},{},async op=>op.startsWith('get_skill')?{type:'llm'}:{status:'running'}),/did not return a final/);
 }finally{if(old===undefined)delete process.env.TENDER_LLM_SKILL_ID;else process.env.TENDER_LLM_SKILL_ID=old;}
});

test('Submission validation names missing fields and rejects unresolved draft placeholders',async()=>{
 const {submissionIssues}=await import('./marketplace.mjs');
 const valid={proposal:'A complete proposal with a specific delivery approach and documented capabilities. We will deliver the stated scope.',amount:8500,deliveryDays:25,evidence:'Client reference ABC.'};
 assert.deepEqual(submissionIssues(valid),[]);
 assert.match(submissionIssues({...valid,amount:0}).join(' '),/Offer/);
 assert.match(submissionIssues({...valid,deliveryDays:0}).join(' '),/Delivery/);
 assert.match(submissionIssues({...valid,evidence:'  '}).join(' '),/Evidence/);
 assert.match(submissionIssues({...valid,proposal:'Short'}).join(' '),/80 characters/);
 assert.match(submissionIssues({...valid,proposal:valid.proposal+' [NEEDS REVIEW: add delivery]'}).join(' '),/placeholders/);
});

test('Issuer recommendations handle incomplete scoring, ties, budget warnings and private drafts',async()=>{
 const {rankBids,issuerPipeline}=await import('./evaluation.mjs');
 const t={id:'t',issuerId:'issuer',budget:100,currency:'USD'};
 const first={id:'a',tenderId:'t',status:'shortlisted',company:'A',amount:90,currency:'USD',evidence:'Reference',evaluation:{technical:90,commercial:80}};
 const second={...first,id:'b',company:'B',evaluation:null};
 assert.equal(rankBids(t,[first,second]).recommendedBidId,null);
 second.evaluation={technical:80,commercial:90};assert.equal(rankBids(t,[first,second]).tie,true);
 second.evaluation={technical:60,commercial:70};assert.equal(rankBids(t,[first,second]).recommendedBidId,'a');
 assert.equal(rankBids(t,[{...first,amount:110},second]).recommendedBidId,null);
 const hidden={...first,id:'draft',status:'draft'};assert.equal(rankBids(t,[first,hidden]).rows.length,1);
 assert.equal(issuerPipeline([t],[first,second,hidden],'issuer').length,2);assert.equal(issuerPipeline([t],[first],'other').length,0);
});
test('Issuers edit drafts freely; live edits publish an addendum, notify bidders and never shorten the deadline',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'g8-edit-test-')),db=openTenderDb(join(dir,'t.sqlite'));const market=createMarketplace(db,{readResource:async()=>({rows:[]})});
 const issuer={id:'i',name:'Issuer',role:'issuer'},alice={id:'a',name:'Alice',role:'contributor'};
 async function call(user,path,method='GET',b={}){let result;await market.route({org:{id:'o'},user,p:['market',...path.split('/')],method,b,send:v=>{result=v;},res:{writeHead(){},end(v){result=v;}}});return result;}
 try{
  const base={title:'Roof repair',description:'Repair the school roof with licensed contractors only.',category:'Construction',country:'PK',currency:'PKR',budget:100,deadline:'2099-01-01T00:00:00Z'};
  let t=await call(issuer,'tenders','POST',base);
  t=await call(issuer,`tenders/${t.id}`,'PATCH',{...base,title:'Roof and gutter repair',revision:t.revision});assert.equal(t.title,'Roof and gutter repair');assert.equal(t.amendments.length,0);
  await assert.rejects(call(alice,`tenders/${t.id}`,'PATCH',{...base,revision:t.revision}),/another account/);
  t=await call(issuer,`tenders/${t.id}/publish`,'POST',{revision:t.revision});
  await call(alice,'profile','PATCH',{company:'Alice Build',services:'Roof repair, licensed contractors',categories:'Construction',countries:'Pakistan'});
  assert.equal((await call(alice,'tenders')).find(x=>x.id===t.id).match.eligibleForMatch,true,'PK tender matches a Pakistan profile');
  await call(alice,`tenders/${t.id}/draft`,'POST');
  await assert.rejects(call(issuer,`tenders/${t.id}`,'PATCH',{...base,title:'Roof and gutter repair',deadline:'2098-01-01T00:00:00Z',revision:t.revision}),/cannot have its closing time shortened/);
  t=await call(issuer,`tenders/${t.id}`,'PATCH',{...base,title:'Roof and gutter repair',budget:150,revision:t.revision,note:'Scope widened'});
  assert.equal(t.amendments.length,1);assert.match(t.amendments[0].note,/budget changed\. Scope widened/);
  assert.ok(db.list('o','agent-event').some(e=>e.userId==='a'&&e.action==='tender:updated'));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
