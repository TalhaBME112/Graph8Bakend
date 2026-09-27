// Graph8 execution layer for BidFlow: every call goes through the official @graph8/sdk
// with bounded retries on rate limits, and each call is recorded on the running step.
import {createApiClient} from '@graph8/sdk';
import {AppError} from '../../domain.mjs';

let sdk;
function client(){if(!process.env.G8_API_KEY)throw new AppError('Connect a Graph8 API key to run BidFlow.',503);return sdk??=createApiClient(process.env.G8_API_KEY);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const unwrap=r=>r?.data??r;

// trace: optional array collecting {op, ms, ok} for the step log shown in the UI.
export async function call(operation,input={},{trace,retries=3,timeout=30000,idempotencyKey}={}){
 const started=Date.now();let attempt=0;
 for(;;){
  try{const result=await client().call(operation,input,{maxRetries:0,signal:AbortSignal.timeout(timeout),...(idempotencyKey?{idempotencyKey}:{})});trace?.push({op:operation,ms:Date.now()-started,ok:true});return result;}
  catch(e){const status=e.status??e.statusCode;if(status===429&&attempt<retries){await sleep(1200*2**attempt++);continue;}trace?.push({op:operation,ms:Date.now()-started,ok:false,error:String(e.message||e).slice(0,200)});throw e;}
 }
}

export async function me(){const d=unwrap(await call('describe_current_key_me_get',{},{timeout:20000}));return {id:d.org_id,name:d.org_name,unrestricted:d.unrestricted===true,scopes:d.scopes||[]};}

// Open data index (300M+ contacts, company graph). Free: no credits consumed.
export async function findCompanies(filters,{limit=50,page=1,trace}={}){const r=await call('search_companies_search_companies_post',{body:{filters,limit,page}},{trace});return {rows:unwrap(r)||[],total:r.pagination?.total??null};}
export async function findContacts(filters,{limit=50,page=1,trace}={}){const r=await call('search_contacts_search_contacts_post',{body:{filters,limit,page}},{trace});return {rows:unwrap(r)||[],total:r.pagination?.total??null};}
// Companies already tracked in the org's CRM.
export async function crmCompanies({name,domain,limit=100,trace}={}){const query={limit};if(name)query.name=name;if(domain)query.domain=domain;const r=await call('list_companies_companies_get',{query},{trace});const d=unwrap(r);return Array.isArray(d)?d:d?.companies||d?.items||[];}

export async function mailboxes({trace}={}){try{const d=unwrap(await call('list_mailboxes_mailboxes_get',{query:{limit:50}},{trace}));return Array.isArray(d)?d:[];}catch{return [];}}

// CRM writes (used only after a human approval node).
export async function createList(title,description,{trace,key}={}){const d=unwrap(await call('create_list_lists_post',{body:{title:title.slice(0,250),description:description?.slice(0,1000),type:'contacts'}},{trace,idempotencyKey:key}));return d?.id??d?.list_id??d?.list?.id;}
export async function createCompany(c,{trace,key}={}){const d=unwrap(await call('create_company_companies_post',{body:{domain:c.domain,name:c.name,industry:c.industry||null,employee_count:c.employee_count||null,city:c.city||null,state:c.state||null,country:c.country||null,linkedin_url:c.linkedin_url||null,website:c.website||null}},{trace,idempotencyKey:key}));return d?.id??d?.company_id??d?.company?.id;}
export async function createContact(p,{trace,key,listId}={}){const d=unwrap(await call('create_contacts_contacts_post',{body:{first_name:p.first_name,last_name:p.last_name,company_id:p.company_id?Number(p.company_id):null,job_title:p.job_title||null,seniority_level:p.seniority_level||null,job_department:p.job_department||null,linkedin_url:p.linkedin_url||null,company_domain:p.company_domain||null,city:p.city&&p.city!=='***'?p.city:null,state:p.state||null,country:p.country||null,list_id:listId?Number(listId):null,work_email:p.work_email&&!p.work_email.includes('*')?p.work_email:null}},{trace,idempotencyKey:key}));return d?.id??d?.contact_id??d?.contact?.id??d?.ids?.[0];}
export async function addToList(listId,contactIds,{trace}={}){if(!contactIds.length)return;await call('add_contacts_to_list_lists__list_id__contacts_post',{path:{list_id:Number(listId)},body:{contact_ids:contactIds.map(Number),conflict_resolution:'add_all'}},{trace});}
export async function note(entityType,entityId,content,{trace}={}){const d=unwrap(await call('create_record_note_notes_post',{body:{content:content.slice(0,20000),entity_type:entityType,entity_id:String(entityId)}},{trace}));return d?.id??d?.note?.id;}
export async function draftCampaign({name,brief,concept,persona,listId,subject,body},{trace,key}={}){
 const d=unwrap(await call('create_campaign_campaigns_post',{body:{name:name.slice(0,250),category:'Outbound',brief:brief?.slice(0,4000),core_concept:concept?.slice(0,2000),target_persona:persona?.slice(0,200),goal:'Invite qualified contractors to bid',audience_list_id:listId?String(listId):null,target_channels:['email'],auto_generate_documents:false}},{trace,idempotencyKey:key}));
 const id=d?.id??d?.campaign_id??d?.campaign?.id;
 if(id)await call('create_campaign_step_campaigns__campaign_id__sequence_steps_post',{path:{campaign_id:String(id)},body:{name:'Invitation to bid',channel:'email',mode:'email',day:0,cta_type:'soft_ask',personalization_level:'high',constraints:{subject,body},stop_on_reply:true}},{trace});
 return id;
}
// Closed-won deal for an awarded tender: default pipeline's "won" stage, owned by the first active team member.
export async function wonDeal({name,amount,currency,contactId,companyId,description},{trace,key}={}){
 const pipes=unwrap(await call('list_pipelines_deals_pipelines_get',{},{trace}))||[];const pipe=pipes.find(p=>p.is_default)||pipes[0];
 const stage=pipe?.stages?.find(s=>s.stage_type==='won');
 const team=unwrap(await call('list_team_members_team_members_get',{query:{limit:20}},{trace}));const member=(team?.items||team?.team_members||[]).find(m=>m.status==='active');
 if(!member)throw new Error('No active Graph8 team member to own the deal.');
 const body={name:name.slice(0,250),amount,currency,contact_ids:contactId?[Number(contactId)]:[],company_id:companyId?Number(companyId):null,owner_id:member.id,pipeline_id:pipe?.id||null,stage_id:stage?.id||null,close_date:new Date().toISOString().slice(0,10),description:description?.slice(0,4000),allow_duplicate:true};
 let d;try{d=unwrap(await call('create_deal_deals_post',{body},{trace,idempotencyKey:key}));}
 catch(e){if(!member.propelauth_user_id)throw e;d=unwrap(await call('create_deal_deals_post',{body:{...body,owner_id:member.propelauth_user_id}},{trace,idempotencyKey:key&&key+'-p'}));}
 return {dealId:d?.id??d?.deal_id??d?.deal?.id,pipeline:pipe?.name,stage:stage?.name};
}
// Idempotent CRM upserts: reuse the existing record when Graph8 reports a duplicate.
const isConflict=e=>(e.status??e.statusCode)===409||/conflict|already exists|duplicate/i.test(String(e.message));
export async function upsertCompany(c,opts={}){try{return await createCompany(c,opts);}catch(e){if(!isConflict(e))throw e;const rows=await crmCompanies({domain:c.domain,limit:5,trace:opts.trace});const hit=rows.find(r=>String(r.domain||'').toLowerCase()===c.domain.toLowerCase())||rows[0];if(!hit)throw e;return hit.id;}}
export async function upsertContact(p,opts={}){
 try{return await createContact(p,opts);}
 catch(e){if(!isConflict(e)||!p.work_email)throw e;const r=unwrap(await call('list_contacts_contacts_get',{query:{email:p.work_email,limit:5}},{trace:opts.trace}));const rows=Array.isArray(r)?r:r?.contacts||r?.items||[];const hit=rows[0];if(!hit)throw e;
  if(p.company_id){try{await call('update_contact_contacts__contact_id__patch',{path:{contact_id:Number(hit.id)},body:{company_id:Number(p.company_id)}},{trace:opts.trace});}catch{}}
  return hit.id;}
}
export const appUrl='https://app.graph8.com';
