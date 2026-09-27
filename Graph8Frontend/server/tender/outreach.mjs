// Cold outreach through Graph8: audiences are Graph8 lists (e.g. the suppliers BidFlow
// invited), contact data is completed with Graph8 enrichment (credits, explicit approval),
// work emails are verified, and emails go out through a Graph8 sequence. Enrolment is only
// possible for verified emails and a connected sending mailbox.
import {AppError,text} from '../domain.mjs';
import {uid,stamp} from './model.mjs';
import * as g8 from './bidflow/g8.mjs';
import {listLists,listMembers} from '../growth/g8x.mjs';

const unwrap=r=>r?.data??r;
const need=(ok,msg,status=400)=>{if(!ok)throw new AppError(msg,status);};
const ids=v=>(Array.isArray(v)?v:[]).map(Number).filter(Number.isFinite).slice(0,200);

export function createOutreach(db,{notify}){
 const jobs=(org,u)=>db.list(org,'outreach-job').filter(j=>j.userId===u);
 const seqs=(org,u)=>db.list(org,'outreach-sequence').filter(s=>s.userId===u);
 const verified=(org)=>{const map={};for(const j of db.list(org,'outreach-verify'))Object.assign(map,j.results||{});return map;};

 async function status(){
  const [credits,boxes,team]=await Promise.all([g8.call('get_credit_holds_usage_holds_get',{}).then(unwrap).catch(()=>null),g8.mailboxes(),g8.call('list_team_members_team_members_get',{query:{limit:20}}).then(unwrap).catch(()=>null)]);
  const owner=(team?.items||team?.team_members||[]).find(m=>m.status==='active');
  return {credits:credits?{available:credits.available_credits,total:credits.total_credits,held:credits.held_credits}:null,mailboxes:boxes.map(b=>({id:b.id,email:b.email||b.address,status:b.status})),sender:owner?.email||null};
 }
 const person=(m,v)=>({id:Number(m.id),name:[m.first_name,m.last_name].filter(Boolean).join(' ')||m.full_name||'Contact',title:m.job_title||'',company:m.company?.name||m.company_name||'',linkedin:m.linkedin_url||'',email:m.work_email||null,phone:m.direct_phone||m.mobile_phone||null,verification:m.work_email?(v[m.id]||'unverified'):null});

 async function route({org,user:u,p,method,b,send}){
  if(p[1]!=='outreach')return false;const [, ,kind,id,action]=p,out=(v,s)=>{send(v,s);return true;};
  if(kind==='status'&&method==='GET')return out(await status());
  if(kind==='lists'&&!id&&method==='GET'){const lists=await listLists();return out(lists.filter(l=>(l.type||'contacts')==='contacts').map(l=>({id:l.id,title:l.title,total:l.total})));}
  if(kind==='lists'&&id&&action==='members'&&method==='GET'){const v=verified(org.id);return out((await listMembers(id,500)).map(m=>person(m,v)));}

  // Enrichment: Graph8 waterfall job on the list (charges credits per contact and provider step).
  if(kind==='enrich'&&method==='POST'){
   const contactIds=ids(b.contactIds),listId=Number(b.listId);need(contactIds.length,'Select contacts to enrich.');need(Number.isFinite(listId),'Choose the Graph8 list these contacts belong to.');
   need(b.approved===true,'Confirm the credit charge before enriching.');
   need(contactIds.length<=25,'Enrich at most 25 contacts at a time.');
   const s=await status();need(!s.credits||s.credits.available>0,'No Graph8 credits available.',402);
   // Graph8 person lookup per contact; only business contact fields are written back
   // (personal emails and household attributes in the lookup response are discarded).
   const results=[];
   for(const cid of contactIds){
    try{const c=unwrap(await g8.call('get_contact_contacts__contact_id__get',{path:{contact_id:cid}}));
     const domain=String(c.company?.domain||c.company?.website||'').replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0]||null;
     const r=unwrap(await g8.call('lookup_person_enrichment_lookup_person_post',{body:{first_name:c.first_name,last_name:c.last_name,company_domain:domain,linkedin_url:c.linkedin_url||null}},{retries:0,timeout:90000}));
     const d=r?.data||{},patch={};if(d.work_email&&!c.work_email)patch.work_email=d.work_email;if(d.direct_phone&&!c.direct_phone)patch.direct_phone=String(d.direct_phone);if(d.mobile_phone&&!c.mobile_phone)patch.mobile_phone=String(d.mobile_phone);
     if(Object.keys(patch).length)await g8.call('update_contact_contacts__contact_id__patch',{path:{contact_id:cid},body:patch},{retries:0});
     results.push({contactId:cid,found:!!r?.found,confidence:d.confidence_score??null,fields:Object.keys(patch)});}
    catch(e){results.push({contactId:cid,found:false,error:String(e.message).slice(0,160)});}
   }
   const after=await status();const successful=results.filter(x=>x.fields?.length).length;
   const job=db.create(org.id,'outreach-job',{id:uid(),userId:u.id,listId,contactIds,status:'completed',total:contactIds.length,successful,failed:results.filter(x=>x.error).length,results,creditsUsed:s.credits&&after.credits?Math.max(0,s.credits.available-after.credits.available):null,startedAt:stamp(),finishedAt:stamp(),warnings:results.filter(x=>x.error).map(x=>`Contact ${x.contactId}: ${x.error}`)},u.id);
   notify(org.id,u.id,{type:'outreach:enriched',title:`Enrichment finished: ${successful} of ${contactIds.length} contacts updated`,body:job.creditsUsed!=null?`${job.creditsUsed} Graph8 credits used`:'',link:{tab:'contacts'}});
   return out(job,201);
  }
  if(kind==='jobs'&&method==='GET'&&!id){return out(jobs(org.id,u.id).slice(0,20));}
  if(kind==='jobs'&&id&&method==='GET'){const job=db.get(org.id,'outreach-job',id);need(job.userId===u.id,'Job not found.',404);
   if(!['completed','failed','cancelled'].includes(job.status)){const r=unwrap(await g8.call('get_enrichment_job_enrichment_jobs__job_id__get',{path:{job_id:id},query:{include_provider_errors:true}}));
    const saved=db.update(org.id,'outreach-job',id,u.id,'outreach:job',x=>{x.status=r.status;x.completed=r.completed;x.successful=r.successful_enrichments;x.failed=r.failed_enrichments;x.creditsUsed=r.total_credits_used??x.creditsUsed;x.warnings=r.warnings||[];x.errors=(r.provider_errors||[]).slice(0,5);if(['completed','failed','cancelled'].includes(r.status))x.finishedAt=stamp();});
    if(saved.finishedAt&&!job.finishedAt)notify(org.id,u.id,{type:'outreach:enriched',title:`Enrichment ${saved.status}: ${saved.successful??0} of ${saved.total} contacts`,body:saved.creditsUsed!=null?`${saved.creditsUsed} Graph8 credits used`:'',link:{tab:'contacts'}});return out(saved);}
   return out(job);}

  // Email verification of enriched work emails.
  if(kind==='verify'&&method==='POST'){const contactIds=ids(b.contactIds);need(contactIds.length,'Select contacts with work emails.');need(b.approved===true,'Confirm the verification charge.');
   const r=unwrap(await g8.call('verify_contact_emails_contacts_verify_email_post',{body:{contact_pks:contactIds}},{retries:0,timeout:90000}));
   const rows=Array.isArray(r)?r:r?.items||r?.results||r?.contacts||[];const results={};
   for(const row of rows){const cid=row.id??row.contact_pk??row.contact_id;const st=String(row.status||row.email_status||row.verification_status||row.result||'').toLowerCase();if(cid!=null)results[cid]=/valid|deliverable|ok/.test(st)&&!/invalid|undeliverable/.test(st)?'valid':st.includes('catch')?'catch_all':st?'invalid':'checked';}
   for(const cid of contactIds)results[cid]??='checked';
   db.create(org.id,'outreach-verify',{id:uid(),userId:u.id,results,at:stamp()},u.id);return out({results});}

  // Sequences
  if(kind==='sequences'&&!id&&method==='GET'){return out(seqs(org.id,u.id));}
  if(kind==='sequences'&&!id&&method==='POST'){
   const steps=(Array.isArray(b.steps)?b.steps:[]).slice(0,6).map((s,i)=>({subject:text(s.subject,`Step ${i+1} subject`,250),body:text(s.body,`Step ${i+1} body`,5000),day:Math.max(0,Math.min(60,Number(s.day)||0))}));need(steps.length,'Add at least one email step.');
   const st=await status();need(st.sender,'No active Graph8 team member to own the sequence.',409);
   const listId=Number(b.listId)||null;
   const created=unwrap(await g8.call('create_sequence_sequences_post',{body:{name:text(b.name,'Sequence name',200),description:String(b.description||'Created by Graph8 BidFlow').slice(0,500),user_email:st.sender,associated_list_id:listId,finish_on_reply:true,send_in_same_thread:true,wait_for_new_contacts:false}},{retries:0,idempotencyKey:`outreach-${u.id}-${String(b.name).slice(0,60)}-${listId}`}));
   await g8.call('add_sequence_steps_sequences__sequence_id__steps_post',{path:{sequence_id:String(created.id)},body:{steps:steps.map((s,i)=>({step_order:i+1,step_type:'EMAIL',input_type:'MANUAL_TEMPLATE',time_interval:i===0?0:Math.max(1,s.day-(steps[i-1]?.day||0)),step_data:{subject:s.subject,body:s.body}}))}},{retries:0});
   return out(db.create(org.id,'outreach-sequence',{id:String(created.id),userId:u.id,name:created.name,status:created.status,listId,tenderId:b.tenderId||null,steps,enrolled:[],createdAt:stamp()},u.id),201);
  }
  if(kind==='sequences'&&id){const seq=db.get(org.id,'outreach-sequence',id);need(seq.userId===u.id,'Sequence not found.',404);
   if(action==='enroll'&&method==='POST'){
    const st=await status();need(st.mailboxes.length,'Connect a sending mailbox in Graph8 (Settings → Mailboxes) before enrolling contacts. Nothing was sent.',409);
    need(b.approved===true,'Confirm that these people will receive emails from your mailbox.');
    const listId=Number(b.listId||seq.listId);const v=verified(org.id);const members=await listMembers(listId,500);
    const eligible=members.filter(m=>ids(b.contactIds).includes(Number(m.id))&&m.work_email&&v[m.id]!=='invalid').map(m=>Number(m.id));
    need(eligible.length,'None of the selected contacts has a usable work email. Enrich and verify first.');
    const r=unwrap(await g8.call('add_contacts_to_sequence_sequences__sequence_id__contacts_post',{path:{sequence_id:id},body:{contact_ids:eligible,list_id:listId}},{retries:0}));
    return out(db.update(org.id,'outreach-sequence',id,u.id,'outreach:enrolled',x=>{x.enrolled=[...new Set([...(x.enrolled||[]),...eligible])];x.status=r.status||x.status;x.enrolledAt=stamp();}));
   }
   if(action==='stats'&&method==='GET'){const r=await g8.call('get_sequence_stats_sequences__sequence_id__stats_get',{path:{sequence_id:id}}).then(unwrap).catch(e=>({error:e.message}));return out(r);}
  }
  return false;
 }

 // Replies to outreach arrive in the Graph8 inbox of connected mailboxes → notifications.
 let lastCheck=new Date(Date.now()-3600e3).toISOString(),busy=false;
 async function tick(org){if(busy)return;busy=true;try{
  const owners=[...new Set(db.list(org,'outreach-sequence').map(s=>s.userId))];if(!owners.length)return;
  const boxes=(await g8.mailboxes()).map(b=>b.email||b.address).filter(Boolean);if(!boxes.length)return;
  const r=unwrap(await g8.call('search_inbox_emails_inbox_emails_search_post',{query:{page:1,page_size:50},body:{mailboxes:boxes,updated_after:lastCheck,sort_by:'last_message_at',sort_order:'desc'}}));lastCheck=new Date().toISOString();
  for(const e of (r?.items||r?.emails||r?.threads||[])){const key=String(e.id||e.thread_id);if(db.list(org,'outreach-reply').some(x=>x.id===key))continue;const from=e.from_email||e.from||e.sender||'';if(boxes.includes(from))continue;
   db.create(org,'outreach-reply',{id:key,from,subject:e.subject||'',at:stamp()},'system');for(const uid_ of owners)notify(org,uid_,{type:'outreach:reply',title:`Reply from ${from||'a prospect'}`,body:String(e.subject||e.snippet||'').slice(0,200),link:{tab:'contacts'}});}
 }catch{}finally{busy=false;}}
 return {route,tick};
}
