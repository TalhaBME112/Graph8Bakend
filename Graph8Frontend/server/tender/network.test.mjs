import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTenderDb} from './database.mjs';
import {createMarketplace} from './marketplace.mjs';

function setup(){
 const dir=mkdtempSync(join(tmpdir(),'g8-net-')),db=openTenderDb(join(dir,'t.sqlite')),market=createMarketplace(db,{readResource:async()=>({rows:[]})});
 const users={buyer:{id:'buyer',name:'Buyer Co',role:'issuer',email:'buyer@x.test'},acme:{id:'acme',name:'Acme Build',role:'contributor',email:'acme@x.test'},bolt:{id:'bolt',name:'Bolt Works',role:'contributor',email:'bolt@x.test'}};
 for(const u of Object.values(users))db.create('o','user',{...u,password:'x'});
 async function call(user,path,method='GET',b={}){let result;await market.route({org:{id:'o'},user,p:['market',...path.split('/')],method,b,send:v=>{result=v;},res:{writeHead(){},end(v){result=v;}}});return result;}
 return {db,call,users,done:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
const tender={title:'Warehouse racking',description:'Supply and install pallet racking for a 5,000 m² warehouse.',category:'Construction',country:'Pakistan',currency:'USD',budget:50000,deadline:'2099-01-01T00:00:00Z'};

test('Bidders see their bid move through submitted → opened → under review → decision, with notifications',async()=>{
 const {call,users:{buyer,acme},done}=setup();
 try{
  let t=await call(buyer,'tenders','POST',tender);t=await call(buyer,`tenders/${t.id}/publish`,'POST',{revision:t.revision});
  await call(acme,'profile','PATCH',{company:'Acme Build',services:'Pallet racking supply and installation',categories:'Construction',countries:'Pakistan'});
  let bid=await call(acme,`tenders/${t.id}/draft`,'POST');
  bid=await call(acme,`bids/${bid.id}`,'PATCH',{proposal:'We will supply and install certified pallet racking with load signage and a 5-year warranty across the full warehouse floor.',amount:45000,deliveryDays:30,evidence:'Three comparable installations in 2025',revision:bid.revision});
  bid=await call(acme,`bids/${bid.id}/submit`,'POST',{approved:true,revision:bid.revision});
  assert.equal((await call(acme,'bids'))[0].tracking.stage,'submitted');
  assert.ok((await call(buyer,'notifications')).items.some(n=>n.title==='New bid from Acme Build'));
  await call(buyer,`bids/${bid.id}/opened`,'POST');await call(buyer,`bids/${bid.id}/opened`,'POST');
  let tr=(await call(acme,'bids'))[0].tracking;assert.equal(tr.stage,'opened');assert.equal(tr.views,1,'repeat views within 30 minutes are not double counted');
  assert.ok((await call(acme,'notifications')).items.some(n=>n.title==='Your bid was opened by the buyer'));
  bid=(await call(buyer,`tenders/${t.id}/bids`))[0];await call(buyer,`bids/${bid.id}/shortlist`,'POST',{technical:80,commercial:90,note:'Strong',revision:bid.revision});
  const mine=(await call(acme,'bids'))[0];assert.equal(mine.tracking.stage,'under_review');assert.equal(mine.evaluation,undefined,'scores stay hidden until the decision');
 }finally{done();}
});

test('Clarifications are numbered, answered officially and anonymised for other bidders',async()=>{
 const {call,users:{buyer,acme,bolt},done}=setup();
 try{
  let t=await call(buyer,'tenders','POST',tender);t=await call(buyer,`tenders/${t.id}/publish`,'POST',{revision:t.revision});
  const q=await call(acme,`tenders/${t.id}/clarifications`,'POST',{question:'Is seismic bracing required?'});assert.equal(q.ref,'CL-001');
  assert.equal((await call(bolt,`tenders/${t.id}/clarifications`)).length,0,'pending questions are private to the asker and buyer');
  assert.equal((await call(buyer,`tenders/${t.id}/clarifications`))[0].askedByCompany,'Acme Build');
  await call(buyer,`tenders/${t.id}/clarifications/${q.id}/answer`,'POST',{answer:'Yes, to local code.'});
  const seen=await call(bolt,`tenders/${t.id}/clarifications`);assert.equal(seen[0].answer,'Yes, to local code.');assert.equal(seen[0].askedByCompany,undefined);
  const n=await call(buyer,`tenders/${t.id}/clarifications/notice`,'POST',{title:'Site visit',body:'A site visit is scheduled for Monday 10:00.'});assert.equal(n.ref,'CL-002');
  assert.equal(t.revision,(await call(buyer,'tenders')).find(x=>x.id===t.id).revision,'clarifications do not invalidate bids');
 }finally{done();}
});

test('Organisations are both buyers and suppliers, and can message, email-log and call-log each other',async()=>{
 const {call,users:{buyer,acme},done}=setup();
 try{
  let own=await call(acme,'tenders','POST',{...tender,title:'Acme office fit-out'});assert.equal(own.issuerId,'acme','a supplier can issue its own tender');
  own=await call(acme,`tenders/${own.id}/publish`,'POST',{revision:own.revision});
  await call(buyer,'profile','PATCH',{company:'Buyer Co',services:'Office fit-out and joinery',categories:'Construction',countries:''});
  await assert.rejects(call(acme,`tenders/${own.id}/draft`,'POST'),/other than the issuer/);
  const bid=await call(buyer,`tenders/${own.id}/draft`,'POST');assert.equal(bid.bidderId,'buyer');
  const {conversation}=await call(buyer,'conversations','POST',{tenderId:own.id,body:'Can we visit the site?'});
  assert.equal(conversation.counterpart.company,'Acme Build');
  await call(acme,`conversations/${conversation.id}/messages`,'POST',{channel:'call',body:'Agreed site visit Tuesday',outcome:'connected',minutes:6});
  await call(acme,`conversations/${conversation.id}/messages`,'POST',{channel:'note',body:'Private: strong prospect'});
  const theirs=await call(buyer,`conversations/${conversation.id}`);assert.equal(theirs.messages.length,2,'private notes are only visible to their author');assert.equal(theirs.unread,1);
  assert.ok((await call(buyer,'notifications')).items.some(n=>n.title==='Acme Build logged a call with you'));
  const me=await call(acme,'me','PATCH',{name:'Acme Build',phone:'+92 300 0000000',company:'Acme Build Pvt Ltd'});assert.equal(me.phone,'+92 300 0000000');
 }finally{done();}
});

test('Cold outreach never spends credits or sends email without explicit approval',async()=>{
 const {call,users:{buyer},done}=setup();
 try{
  await assert.rejects(call(buyer,'outreach/enrich','POST',{contactIds:[1],listId:2}),/Confirm the credit charge/);
  await assert.rejects(call(buyer,'outreach/verify','POST',{contactIds:[1]}),/Confirm the verification charge/);
  await assert.rejects(call(buyer,'outreach/enrich','POST',{contactIds:[],listId:2,approved:true}),/Select contacts/);
 }finally{done();}
});
