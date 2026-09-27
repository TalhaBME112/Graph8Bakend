// Peer-to-peer layer of the marketplace: account profiles, notifications, conversations
// (message / email / call log / private note), bid tracking events, official clarifications
// and the tender document register. Logs live in their own record kinds so that viewing or
// downloading never changes a tender's or bid's revision.
import {AppError,text} from '../domain.mjs';
import {uid,stamp} from './model.mjs';
import * as g8 from './bidflow/g8.mjs';

const need=(ok,msg,status=403)=>{if(!ok)throw new AppError(msg,status);};
const clip=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const BID_STAGES=['draft','submitted','opened','under_review','decision'];

export function createNetwork(db){
 const user=(org,id)=>{try{return db.get(org,'user',id);}catch{return null;}};
 const company=(org,id)=>{const p=db.list(org,'market-profile').find(x=>x.id===id),u=user(org,id);return p?.company||u?.company||u?.name||'Unknown organisation';};
 const card=(org,id)=>{const u=user(org,id);if(!u)return null;return {id:u.id,name:u.name,company:company(org,id),title:u.title||'',email:u.email,phone:u.phone||'',website:u.website||''};};

 function notify(org,userId,{type,title,body='',link={}}){if(!userId||userId==='external')return;db.create(org,'notification',{id:uid(),userId,type,title:String(title).slice(0,200),body:String(body).slice(0,600),link,read:false,at:stamp()},'system');}
 const BIDDER_COPY={opened:'Your bid was opened by the buyer',under_review:'Your bid is under evaluation',shortlisted:'Your bid was shortlisted',awarded:'You won the tender',not_awarded:'The tender was awarded to another bidder',cancelled:'The tender was cancelled',tender_updated:'The tender was updated'};
 function bidEvent(org,bid,type,{detail='',actor='system',notifyBidder=true,notifyIssuerId=null,issuerTitle=''}={}){
  db.create(org,'bid-event',{id:uid(),bidId:bid.id,tenderId:bid.tenderId,type,detail:String(detail).slice(0,500),actor,at:stamp()},actor);
  if(notifyBidder&&BIDDER_COPY[type])notify(org,bid.bidderId,{type:'bid:'+type,title:BIDDER_COPY[type],body:detail,link:{tenderId:bid.tenderId,bidId:bid.id}});
  if(notifyIssuerId)notify(org,notifyIssuerId,{type:'bid:'+type,title:issuerTitle,body:detail,link:{tenderId:bid.tenderId,bidId:bid.id}});
 }
 function tracking(org,bid){
  let events=db.list(org,'bid-event').filter(e=>e.bidId===bid.id).sort((a,b)=>a.at.localeCompare(b.at));
  // Bids created before tracking existed: reconstruct the timeline from the bid's own history.
  if(!events.some(e=>e.type!=='draft_created')){const legacy=[];for(const h of bid.history||[])legacy.push({id:'h'+h.at,type:h.event==='Submitted'?'submitted':h.event==='Withdrawn for revision'?'withdrawn':'submitted',at:h.at,detail:''});
   if(bid.evaluation?.at){legacy.push({id:'e',type:'opened',at:bid.evaluation.at,detail:'Recorded at evaluation'},{id:'r',type:'under_review',at:bid.evaluation.at,detail:''});if(bid.status!=='submitted')legacy.push({id:'s',type:'shortlisted',at:bid.evaluation.at,detail:''});}
   if(['awarded','rejected','cancelled'].includes(bid.status))legacy.push({id:'o',type:bid.status==='awarded'?'awarded':bid.status==='rejected'?'not_awarded':'cancelled',at:bid.updatedAt||bid.evaluation?.at||bid.submittedAt,detail:bid.outcomeReason||''});
   events=[...events,...legacy].filter(e=>e.at).sort((a,b)=>a.at.localeCompare(b.at));}
  const first=t=>events.find(e=>e.type===t)?.at||null,views=events.filter(e=>['opened','viewed'].includes(e.type)).length;
  const reviewed=first('under_review')||first('shortlisted'),decided=['awarded','rejected','cancelled'].includes(bid.status)?(first('awarded')||first('not_awarded')||first('cancelled')||bid.updatedAt):null;
  const stage=decided?'decision':reviewed?'under_review':first('opened')?'opened':['submitted','shortlisted'].includes(bid.status)?'submitted':'draft';
  return {stage,submittedAt:bid.submittedAt||first('submitted'),openedAt:first('opened'),views,reviewedAt:reviewed,shortlistedAt:first('shortlisted'),decidedAt:decided,outcome:['awarded','rejected','cancelled'].includes(bid.status)?bid.status:null,events};
 }
 function logTender(org,tenderId,type,userId,detail={}){db.create(org,'tender-log',{id:uid(),tenderId,type,userId,company:company(org,userId),...detail,at:stamp()},userId||'system');}
 const bidderIds=(org,tenderId)=>[...new Set(db.list(org,'market-bid').filter(b=>b.tenderId===tenderId).map(b=>b.bidderId))];

 // ── Conversations ────────────────────────────────────────────────────────────
 function conversationFor(org,me,other,{tenderId=null,bidId=null,subject=''}){
  need(other&&other!==me,'Choose who to contact.',400);need(user(org,other),'That organisation has no account on this network.',404);
  const found=db.list(org,'conversation').find(c=>c.participants.includes(me)&&c.participants.includes(other)&&(c.bidId||null)===bidId&&(c.tenderId||null)===tenderId);
  if(found)return found;
  return db.create(org,'conversation',{id:uid(),participants:[me,other],tenderId,bidId,subject:clip(subject,200)||'Conversation',messages:[],lastRead:{},createdAt:stamp()},me);
 }
 async function deliverEmail(to,subject,body){
  try{const boxes=await g8.mailboxes();const box=boxes.find(b=>b.email||b.address);if(!box)return {delivery:'mail_client'};
   await g8.call('compose_inbox_email_inbox_emails_compose_post',{body:{from_mailbox:box.email||box.address,to:[to],subject,content:body,save_as_draft:false,include_signature:true}});return {delivery:'graph8',mailbox:box.email||box.address};}
  catch(e){return {delivery:'mail_client',error:String(e.message).slice(0,160)};}
 }
 async function post(org,me,conv,b){
  const channel=['message','email','call','note'].includes(b.channel)?b.channel:'message';
  const body=text(b.body,channel==='call'?'Call notes':'Message',8000),other=conv.participants.find(x=>x!==me);
  const meta={};
  if(channel==='call'){meta.outcome=clip(b.outcome,60)||'connected';meta.minutes=Math.max(0,Math.min(600,Number(b.minutes)||0));}
  if(channel==='email'){const to=user(org,other)?.email;need(to,'This contact has no email address.',400);Object.assign(meta,{to,subject:clip(b.subject,200)||conv.subject},await deliverEmail(to,clip(b.subject,200)||conv.subject,body));}
  const saved=db.update(org,'conversation',conv.id,me,'conversation:'+channel,c=>{c.messages.push({id:uid(),from:me,channel,body,meta,at:stamp()});c.updatedAt=stamp();c.lastRead[me]=stamp();});
  if(channel!=='note'){const who=company(org,me);notify(org,other,{type:'message:'+channel,title:channel==='call'?`${who} logged a call with you`:channel==='email'?`Email from ${who}`:`New message from ${who}`,body:body.slice(0,200),link:{conversationId:conv.id,tenderId:conv.tenderId,bidId:conv.bidId}});}
  return {conversation:view(org,me,saved),meta};
 }
 function view(org,me,c){
  const other=c.participants.find(x=>x!==me),seen=c.lastRead?.[me]||'';
  const messages=c.messages.filter(m=>m.channel!=='note'||m.from===me);
  return {id:c.id,subject:c.subject,tenderId:c.tenderId,bidId:c.bidId,updatedAt:c.updatedAt||c.createdAt,counterpart:card(org,other),messages,unread:messages.filter(m=>m.from!==me&&m.at>seen).length,last:messages.at(-1)||null};
 }

 // ── Clarifications (official, numbered, asker anonymised for other bidders) ───
 function clarifications(org,t,me){
  const rows=db.list(org,'clarification').filter(c=>c.tenderId===t.id).sort((a,b)=>a.number-b.number);
  const legacy=(t.questions||[]).map((q,i)=>({id:q.id,legacy:true,number:0,ref:`Q-${i+1}`,kind:'question',question:q.question,answer:q.answer,askedBy:q.askedBy,at:q.at,answeredAt:q.answeredAt,status:q.answer?'answered':'pending'}));
  return [...legacy,...rows].filter(c=>t.issuerId===me||c.status!=='pending'||c.askedBy===me).map(c=>({...c,askedBy:undefined,mine:c.askedBy===me,askedByCompany:t.issuerId===me&&c.askedBy?company(org,c.askedBy):undefined}));
 }
 const nextNumber=(org,tenderId)=>db.list(org,'clarification').filter(c=>c.tenderId===tenderId).reduce((n,c)=>Math.max(n,c.number),0)+1;

 async function route({org,user:u,p,method,b,send,getTender,isOpen,own}){
  const [,kind,id,action,sub]=p;const out=(v,s)=>{send(v,s);return true;};
  if(kind==='me'){if(method==='GET')return out(card(org.id,u.id));
   if(method==='PATCH')return out(db.update(org.id,'user',u.id,u.id,'account:profile',r=>{r.name=text(b.name??r.name,'Name',100);r.phone=clip(b.phone,40);r.title=clip(b.title,120);r.company=clip(b.company,200);r.website=clip(b.website,200);})&&card(org.id,u.id));}
  if(kind==='notifications'){
   const mine=db.list(org.id,'notification').filter(n=>n.userId===u.id);
   if(method==='GET')return out({unread:mine.filter(n=>!n.read).length,items:mine.slice(0,60)});
   if(method==='POST'&&id==='read'){const ids=Array.isArray(b.ids)?new Set(b.ids):null;for(const n of mine.filter(n=>!n.read&&(!ids||ids.has(n.id))))db.update(org.id,'notification',n.id,u.id,'notification:read',r=>{r.read=true;});return out({success:true});}
  }
  if(kind==='conversations'){
   if(!id&&method==='GET')return out(db.list(org.id,'conversation').filter(c=>c.participants.includes(u.id)).map(c=>view(org.id,u.id,c)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));
   if(!id&&method==='POST'){
    let other=b.toUserId,tenderId=b.tenderId||null,bidId=b.bidId||null,subject=b.subject;
    if(bidId){const bid=db.get(org.id,'market-bid',bidId),t=getTender(bid.tenderId);need(bid.bidderId===u.id||t.issuerId===u.id,'Bid not found.',404);other=bid.bidderId===u.id?t.issuerId:bid.bidderId;tenderId=t.id;subject??=`Bid for ${t.title}`;}
    else if(tenderId&&!other){const t=getTender(tenderId);need(t.issuerId!=='external','This notice is published by an external buyer. Use the contact on the official notice.',400);other=t.issuerId;subject??=`Question about ${t.title}`;}
    const conv=conversationFor(org.id,u.id,other,{tenderId,bidId,subject});
    if(b.body)return out(await post(org.id,u.id,conv,b),201);return out({conversation:view(org.id,u.id,conv)},201);
   }
   const conv=db.get(org.id,'conversation',id);need(conv.participants.includes(u.id),'Conversation not found.',404);
   if(method==='GET')return out(view(org.id,u.id,conv));
   if(action==='messages'&&method==='POST')return out(await post(org.id,u.id,conv,b));
   if(action==='read'&&method==='POST')return out(view(org.id,u.id,db.update(org.id,'conversation',id,u.id,'conversation:read',c=>{c.lastRead={...(c.lastRead||{}),[u.id]:stamp()};})));
  }
  if(kind==='contacts'&&method==='GET'){
   const ids=new Set();for(const c of db.list(org.id,'conversation'))if(c.participants.includes(u.id))c.participants.forEach(x=>ids.add(x));
   const tenders=db.list(org.id,'market-tender'),bids=db.list(org.id,'market-bid');
   for(const bid of bids){const t=tenders.find(x=>x.id===bid.tenderId);if(!t)continue;if(bid.bidderId===u.id&&t.issuerId!=='external')ids.add(t.issuerId);if(t.issuerId===u.id&&bid.status!=='draft')ids.add(bid.bidderId);}
   ids.delete(u.id);const network=[...ids].map(x=>card(org.id,x)).filter(Boolean);
   const external=[];for(const r of db.list(org.id,'bidflow-run').filter(r=>r.userId===u.id&&r.state?.execution?.companies)){for(const c of r.state.execution.companies)for(const p of c.contacts)external.push({name:p.name,title:p.title,company:c.name,domain:c.domain,graph8ContactId:p.contactId,tender:r.state.tender?.title,linkedin:(r.state.matches||[]).find(m=>m.domain===c.domain)?.contacts?.find(x=>`${x.first_name} ${x.last_name}`===p.name)?.linkedin_url||''});}
   return out({network,graph8:external});
  }
  if(kind==='graph8-note'&&method==='POST'){need(b.contactId,'Choose a Graph8 contact.',400);await g8.note('contact',b.contactId,`${text(b.channel||'Note','Type',20)} · ${text(b.body,'Notes',5000)}`);return out({success:true});}

  if(kind==='tenders'&&id){
   const t=getTender(id);
   if(action==='clarifications'){
    if(method==='GET')return out(clarifications(org.id,t,u.id));
    if(method==='POST'&&!sub){need(t.issuerId!==u.id,'Issuers publish official notices instead of asking questions.',400);need(isOpen(t),'Clarifications close with the tender.',409);need(!t.clarificationDeadline||Date.parse(t.clarificationDeadline)>Date.now(),'The clarification period has ended.',409);
     const n=nextNumber(org.id,t.id),c=db.create(org.id,'clarification',{id:uid(),tenderId:t.id,number:n,ref:`CL-${String(n).padStart(3,'0')}`,kind:'question',question:text(b.question,'Question',4000),askedBy:u.id,at:stamp(),status:'pending',answer:''},u.id);
     notify(org.id,t.issuerId,{type:'clarification:asked',title:`${c.ref}: new clarification request`,body:c.question.slice(0,200),link:{tenderId:t.id,tab:'clarifications'}});return out(c,201);}
    if(method==='POST'&&sub==='notice'){own(t);need(t.status==='published','Publish the tender first.',409);const n=nextNumber(org.id,t.id),c=db.create(org.id,'clarification',{id:uid(),tenderId:t.id,number:n,ref:`CL-${String(n).padStart(3,'0')}`,kind:'notice',question:text(b.title,'Title',300),answer:text(b.body,'Notice',8000),askedBy:null,at:stamp(),answeredAt:stamp(),status:'answered'},u.id);
     for(const x of bidderIds(org.id,t.id))notify(org.id,x,{type:'clarification:notice',title:`${c.ref}: official clarification issued`,body:`${t.title}: ${c.question}`,link:{tenderId:t.id,tab:'clarifications'}});return out(c,201);}
    if(method==='POST'&&action==='clarifications'&&p[5]==='answer'){own(t);const c=db.get(org.id,'clarification',sub);need(c.tenderId===t.id,'Clarification not found.',404);
     const saved=db.update(org.id,'clarification',sub,u.id,'clarification:answered',r=>{r.answer=text(b.answer,'Official answer',8000);r.answeredAt=stamp();r.status='answered';});
     for(const x of new Set([...bidderIds(org.id,t.id),c.askedBy]))notify(org.id,x,{type:'clarification:answered',title:`${c.ref} answered`,body:`${t.title}: ${c.question.slice(0,150)}`,link:{tenderId:t.id,tab:'clarifications'}});return out(saved);}
   }
   if(action==='viewed'&&method==='POST'){if(t.issuerId!==u.id&&!db.list(org.id,'tender-log').some(l=>l.tenderId===t.id&&l.userId===u.id&&l.type==='view'&&Date.now()-Date.parse(l.at)<3600e3))logTender(org.id,t.id,'view',u.id);return out({success:true});}
   if(action==='register'&&method==='GET'){const logs=db.list(org.id,'tender-log').filter(l=>l.tenderId===t.id);
    const docs=(t.documents||[]).map(d=>{const dl=logs.filter(l=>l.type==='download'&&l.docId===d.id);return {...d,downloads:dl.length,downloadedBy:t.issuerId===u.id?[...new Set(dl.map(l=>l.company))]:undefined};});
    return out({documents:docs,views:t.issuerId===u.id?logs.filter(l=>l.type==='view').length:undefined,interested:t.issuerId===u.id?[...new Set(logs.map(l=>l.company))]:undefined});}
  }
  if(kind==='bids'&&id){
   const bid=db.get(org.id,'market-bid',id),t=getTender(bid.tenderId);need(bid.bidderId===u.id||(t.issuerId===u.id&&bid.status!=='draft'),'Bid not found.',404);
   if(action==='opened'&&method==='POST'){need(t.issuerId===u.id,'Only the buyer opens bids.');const events=db.list(org.id,'bid-event').filter(e=>e.bidId===id);
    if(!events.some(e=>e.type==='opened'))bidEvent(org.id,bid,'opened',{actor:u.id,detail:`Opened by ${company(org.id,u.id)}`});
    else if(!events.some(e=>['opened','viewed'].includes(e.type)&&Date.now()-Date.parse(e.at)<30*60e3))bidEvent(org.id,bid,'viewed',{actor:u.id,notifyBidder:false,detail:'Viewed again'});
    return out(tracking(org.id,bid));}
   if(action==='tracking'&&method==='GET')return out(tracking(org.id,bid));
  }
  return undefined;
 }
 return {route,notify,bidEvent,tracking,logTender,company,card,bidderIds};
}
