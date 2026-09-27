// HTTP surface for BidFlow (/api/tender/bidflow/*) plus the autonomous triggers:
//  • tender published  → Contractor Match run for the issuer
//  • background tick   → public feed sync + supplier autopilot (Bid Pursuit runs)
import {AppError} from '../../domain.mjs';
import {stamp} from '../model.mjs';
import {extractDocument} from '../documents.mjs';
import {matchTender} from '../marketplace.mjs';
import {createEngine,describeGraph} from './engine.mjs';
import {GRAPHS} from './graphs.mjs';
import {ensureSkill,skillInfo} from './llm.mjs';
import {feedRecords,syncFeed,ADAPTERS} from './feeds.mjs';
import * as g8 from './g8.mjs';

const ORG_ROLES=['issuer','contributor','administrator'],issuerRole=u=>ORG_ROLES.includes(u.role),bidderRole=u=>ORG_ROLES.includes(u.role);
const deny=(ok,msg,status=403)=>{if(!ok)throw new AppError(msg,status);};
const summaryOf=r=>({id:r.id,graphId:r.graphId,graphName:r.graphName,tenderId:r.tenderId,userId:r.userId,status:r.status,trigger:r.trigger,current:r.current,createdAt:r.createdAt,updatedAt:r.updatedAt,finishedAt:r.finishedAt,error:r.error,steps:r.steps.length,title:r.state?.tender?.title,headline:r.steps.at(-1)?.summary});

export function createBidFlow(db){
 const engine=createEngine(db,GRAPHS);
 let statusCache=null;

 async function tenderInput(org,t){
  let documentsText='';
  for(const d of (t.documents||[]).slice(0,4)){try{const doc=db.get(org,'market-document',d.id),parsed=await extractDocument(doc.name,Buffer.from(doc.base64,'base64'));documentsText+=`\n--- ${doc.name}\n`+parsed.pages.map(p=>p.text).join('\n').slice(0,8000);}catch{}}
  return {id:t.id,title:t.title,description:t.description,category:t.category,country:t.country,region:t.region,currency:t.currency,budget:t.budget,deadline:t.deadline,issuer:t.issuer,issuerId:t.issuerId,external:!!t.external,source:t.source||null,sourceUrl:t.sourceUrl,amendments:t.amendments||[],documentsText};
 }
 const profileOf=(org,userId)=>db.list(org,'market-profile').find(p=>p.id===userId);

 async function startMatch(org,user,t,trigger='manual'){deny(t.issuerId===user.id||user.role==='administrator','Only the issuing account can run contractor matching.',404);return engine.start(org,'contractor_match',{actor:user.id,userId:user.id,tenderId:t.id,trigger,input:{tender:await tenderInput(org,t)}});}
 async function startPursuit(org,user,t,trigger='manual'){
  const profile=profileOf(org,user.id);deny(profile?.services,'Complete your supplier profile (services and categories) before running BidFlow.',400);
  deny(t.issuerId!==user.id,'You cannot bid on your own tender.');deny(t.status==='published'&&Date.parse(t.deadline)>Date.now(),'This tender is closed.',409);
  return engine.start(org,'bid_pursuit',{actor:user.id,userId:user.id,tenderId:t.id,trigger,input:{tender:await tenderInput(org,t),profile,userId:user.id}});
 }

 async function route({org,user,p,method,b,send,url}){
  const [,kind,id,action]=p;
  if(kind==='status'&&method==='GET'){
   if(!statusCache||statusCache.expires<Date.now()){let identity=null,skill=null,boxes=null,error=null;try{identity=await g8.me();}catch(e){error=e.message;}try{skill=await ensureSkill();}catch(e){error??=`LLM skill: ${e.message}`;}try{boxes=(await g8.mailboxes()).length;}catch{}statusCache={value:{identity,skill,mailboxes:boxes,error,checkedAt:stamp()},expires:Date.now()+60000};}
   return send({...statusCache.value,graphs:Object.values(GRAPHS).map(describeGraph),feeds:feedRecords(db,org.id),appUrl:g8.appUrl});
  }
  if(kind==='graphs'&&method==='GET')return send(Object.values(GRAPHS).map(describeGraph));
  if(kind==='runs'){
   if(!id&&method==='GET'){const tenderId=url.searchParams.get('tenderId');return send(engine.list(org.id,r=>(r.userId===user.id||user.role==='administrator')&&(!tenderId||r.tenderId===tenderId)).slice(0,50).map(r=>({...summaryOf(r),stale:engine.view(r).stale})));}
   const run=engine.get(org.id,id);deny(run.userId===user.id||user.role==='administrator','Run not found.',404);
   if(method==='GET'&&!action)return send(engine.view(run));
   if(action==='approve'&&method==='POST'){deny(['approve','reject'].includes(b.decision),'Choose approve or reject.',400);
    const approval=run.graphId==='contractor_match'?{decision:b.decision,selected:Array.isArray(b.selected)?b.selected.map(String).slice(0,40):[],contacts:b.contacts&&typeof b.contacts==='object'?b.contacts:null,edits:b.edits&&typeof b.edits==='object'?b.edits:{}}
     :{decision:b.decision,submit:b.submit===true,proposal:typeof b.proposal==='string'?b.proposal.slice(0,100000):undefined,amount:Number.isFinite(b.amount)?b.amount:undefined,deliveryDays:Number.isFinite(b.deliveryDays)?b.deliveryDays:undefined};
    if(approval.decision==='approve'&&run.graphId==='contractor_match')deny(approval.selected.length,'Select at least one contractor to invite.',400);
    return send(engine.view(engine.resume(org.id,id,user.id,approval)));}
   if(action==='resume'&&method==='POST')return send(engine.view(engine.resume(org.id,id,user.id,{})));
   if(action==='cancel'&&method==='POST')return send(engine.view(engine.cancel(org.id,id,user.id)));
  }
  if(kind==='match'&&method==='POST'){deny(issuerRole(user),'An issuer account is required.');return send(await startMatch(org.id,user,db.get(org.id,'market-tender',String(b.tenderId))),201);}
  if(kind==='pursue'&&method==='POST'){deny(bidderRole(user),'A bidder account is required.');return send(await startPursuit(org.id,user,db.get(org.id,'market-tender',String(b.tenderId))),201);}
  if(kind==='feeds'){
   if(method==='GET')return send(feedRecords(db,org.id));
   deny(['administrator','issuer','contributor'].includes(user.role),'Not allowed.');
   if(action==='sync'&&method==='POST'){try{return send(await syncFeed(db,org.id,id,user.id));}catch(e){db.update(org.id,'bidflow-feed',id,user.id,'feed:error',f=>{f.error=String(e.message).slice(0,300);f.lastSync=stamp();});throw e;}}
   if(method==='PATCH'&&id)return send(db.update(org.id,'bidflow-feed',id,user.id,'feed:configured',f=>{f.enabled=b.enabled===true;if(Number.isInteger(b.limit))f.limit=Math.max(5,Math.min(100,b.limit));}));
  }
  if(kind==='graph8'&&id==='companies'&&method==='GET'){const q=String(url.searchParams.get('q')||'').trim().slice(0,120);deny(q.length>=2,'Type at least two characters.',400);const byDomain=/\.[a-z]{2,}$/i.test(q);const r=await g8.findCompanies([{field:byDomain?'domain':'name',operator:byDomain?'any_of':'contains',value:[q.replace(/^https?:\/\//,'').replace(/^www\./,'')]}],{limit:8});return send(r.rows.map(c=>({name:c.name,domain:c.domain,industry:c.industry,employee_count:c.employee_count,revenue:c.revenue,city:c.city,state:c.state,country:c.country,linkedin_url:c.linkedin_url,logo_url:c.logo_url,description:String(c.description||'').slice(0,1500)})));}
  if(kind==='profile'&&id==='graph8'&&method==='POST'){deny(bidderRole(user),'Only bidders have supplier profiles.');const c=b.company||{};deny(typeof c.name==='string'&&c.name,'Choose a Graph8 company.',400);const snap={name:String(c.name).slice(0,200),domain:String(c.domain||'').slice(0,200),industry:c.industry||'',employee_count:c.employee_count||'',revenue:c.revenue||'',city:c.city||'',state:c.state||'',country:c.country||'',linkedin_url:c.linkedin_url||'',description:String(c.description||'').slice(0,3000),linkedAt:stamp()};
   const existing=profileOf(org.id,user.id);if(existing)return send(db.update(org.id,'market-profile',user.id,user.id,'profile:graph8-linked',r=>{r.graph8Company=snap;if(typeof b.autoPursue==='boolean')r.autoPursue=b.autoPursue;}));
   return send(db.create(org.id,'market-profile',{id:user.id,company:snap.name,services:snap.description,categories:[],countries:snap.country?[snap.country]:[],autoDraft:false,graph8Company:snap},user.id));}
  if(kind==='profile'&&id==='autopilot'&&method==='POST'){deny(bidderRole(user),'Only bidders have supplier profiles.');const existing=profileOf(org.id,user.id);deny(existing,'Save your supplier profile first.',400);return send(db.update(org.id,'market-profile',user.id,user.id,'profile:autopilot',r=>{r.autoPursue=b.enabled===true;}));}
  if(kind==='invites'&&method==='GET')return send(db.list(org.id,'market-invite').filter(i=>i.bidderId===user.id));
  throw new AppError('BidFlow route not found.',404);
 }

 // Autonomous triggers ------------------------------------------------------------
 async function onPublish(org,tender,user){try{await startMatch(org,user,tender,'tender_published');}catch{}}
 // Award → Graph8: winner company + contact, a Closed Won deal and a note, recorded on the tender.
 async function onAward(org,tender,bid,user){
  const trace=[],out={status:'running',at:stamp(),companyId:null,contactId:null,dealId:null,errors:[]};
  const save=()=>{try{db.update(org,'market-tender',tender.id,'bidflow','award:graph8',r=>{r.award={...r.award,graph8:{...out,ops:trace.length}};});}catch{}};save();
  const key='bidflow-award-'+tender.id;let bidder=null;try{bidder=db.get(org,'user',bid.bidderId);}catch{}
  const profile=profileOf(org,bid.bidderId),emailDomain=String(bidder?.email||'').split('@')[1]||'',free=/^(gmail|yahoo|hotmail|outlook|live|icloud|aol|proton(mail)?|gmx|yandex|mail)./i.test(emailDomain);
  const co=profile?.graph8Company?.domain?profile.graph8Company:(!free&&emailDomain?{name:bid.company,domain:emailDomain}:null);
  try{if(co)out.companyId=await g8.upsertCompany(co,{trace,key:key+'-co'});else out.errors.push('Company: link the supplier to a Graph8 company (Supplier identity) so the deal has an account.');}catch(e){out.errors.push('Company: '+e.message);}
  try{if(bidder){const [first,...rest]=bidder.name.split(' ');out.contactId=await g8.upsertContact({first_name:first,last_name:rest.join(' ')||bid.company,job_title:'Awarded supplier contact',work_email:bidder.email,company_domain:co?.domain||null,company_id:out.companyId},{trace,key:key+'-contact'});}}catch(e){out.errors.push('Contact: '+e.message);}
  try{const d=await g8.wonDeal({name:`Tender award · ${tender.title} · ${bid.company}`,amount:bid.amount,currency:bid.currency,contactId:out.contactId,companyId:out.companyId,description:`Awarded by ${tender.issuer} via Graph8 BidFlow.
Rationale: ${tender.award?.reason||''}
Bid receipt: ${bid.receipt}
Delivery: ${bid.deliveryDays} days`},{trace,key:key+'-deal'});Object.assign(out,d);}catch(e){out.errors.push('Deal: '+e.message);}
  try{if(out.dealId)await g8.note('deal',out.dealId,`BidFlow award: "${tender.title}" awarded to ${bid.company} for ${bid.currency} ${bid.amount}.

${String(bid.proposal).slice(0,3000)}`,{trace});}catch(e){out.errors.push('Note: '+e.message);}
  out.status=out.dealId?'completed':'failed';out.at=stamp();save();
  try{db.create(org,'agent-event',{id:crypto.randomUUID(),userId:bid.bidderId,action:'tender:awarded',details:`You won "${tender.title}" (${bid.currency} ${bid.amount}).${out.dealId?' Recorded as a Closed Won deal in Graph8.':''}`,at:stamp()},'bidflow');}catch{}
 }
 let ticking=false;
 async function tick(org){
  if(ticking)return;ticking=true;
  try{
   for(const f of feedRecords(db,org))if(f.enabled&&ADAPTERS[f.type]&&(!f.lastSync||Date.now()-Date.parse(f.lastSync)>30*60000)){try{await syncFeed(db,org,f.id);}catch(e){try{db.update(org,'bidflow-feed',f.id,'feed-monitor','feed:error',r=>{r.error=String(e.message).slice(0,300);r.lastSync=stamp();});}catch{}}}
   const runs=engine.list(org,()=>true),open=db.list(org,'market-tender').filter(t=>t.status==='published'&&Date.parse(t.deadline)>Date.now());
   for(const p of db.list(org,'market-profile').filter(p=>p.autoPursue&&p.services)){
    let u;try{u=db.get(org,'user',p.id);}catch{continue;}if(!bidderRole(u))continue;
    const fresh=open.filter(t=>t.issuerId!==u.id&&!runs.some(r=>r.userId===u.id&&r.tenderId===t.id)&&!db.list(org,'market-bid').some(x=>x.bidderId===u.id&&x.tenderId===t.id)).map(t=>({t,m:matchTender(t,p)})).filter(x=>x.m.eligibleForMatch&&x.m.score>=60).sort((a,b)=>b.m.score-a.m.score).slice(0,2);
    for(const {t} of fresh){try{await startPursuit(org,u,t,'autopilot');}catch{}}
   }
  }finally{ticking=false;}
 }
 return {route,onPublish,onAward,tick,engine};
}
export {skillInfo};
