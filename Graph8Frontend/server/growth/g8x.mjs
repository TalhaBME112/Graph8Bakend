// Graph8 reads/writes used by Deal Rooms, the Learning Lab and Run My Goal.
// Built on the same SDK client (retries, tracing) as BidFlow.
import {call} from '../tender/bidflow/g8.mjs';
const unwrap=r=>r?.data??r;
const arr=(d,...keys)=>{if(Array.isArray(d))return d;for(const k of keys)if(Array.isArray(d?.[k]))return d[k];return [];};
const safe=async(fn,fallback=null)=>{try{return await fn();}catch{return fallback;}};

export async function gtmContext(){const d=unwrap(await call('list_global_context_documents_global_context_documents_get',{query:{include_content:true,limit:50}}));return arr(d,'documents','items').filter(x=>x.content&&x.title).map(x=>({category:x.category,title:x.title,content:String(x.content).slice(0,2500)})).slice(0,12);}
export async function listDeals(){return arr(unwrap(await call('list_deals_deals_get',{query:{limit:100}})),'deals','items');}
export async function listCampaigns(){return arr(unwrap(await call('list_campaigns_campaigns_get',{query:{limit:100}})),'campaigns','items');}
export async function listLists(){return arr(unwrap(await call('list_lists_lists_get',{query:{limit:100}})),'lists','items');}
export async function listMembers(listId,max=1000){const out=[];for(let page=1;out.length<max&&page<=10;page++){const r=await call('list_contacts_contacts_get',{query:{list_id:Number(listId),limit:100,page}});const rows=arr(unwrap(r),'contacts','items');out.push(...rows);if(rows.length<100)break;}return out.slice(0,max);}
export async function campaign(id){return unwrap(await call('get_campaign_campaigns__campaign_id__get',{path:{campaign_id:String(id)}}));}
export async function campaignSequence(id){return safe(async()=>unwrap(await call('get_campaign_sequence_campaigns__campaign_id__sequence_get',{path:{campaign_id:String(id)}})));}
export async function campaignMetrics(id){return unwrap(await call('get_campaign_metrics_campaigns__campaign_id__metrics_get',{path:{campaign_id:String(id)}}));}

// Everything a deal room needs from Graph8, fetched in parallel; missing pieces degrade gracefully.
export async function dealIntel(dealId){
 const path={deal_id:String(dealId)};
 const [detail,contacts,notes,lines,readiness,docs,quotes]=await Promise.all([
  call('get_deal_detail_deals__deal_id__detail_get',{path}).then(unwrap),
  safe(async()=>arr(unwrap(await call('list_deal_contacts_deals__deal_id__contacts_get',{path})),'contacts','items'),[]),
  safe(async()=>arr(unwrap(await call('list_deal_notes_deals__deal_id__notes_get',{path})),'notes','items'),[]),
  safe(async()=>unwrap(await call('list_deal_line_items_deals__deal_id__line_items_get',{path}))),
  safe(async()=>unwrap(await call('get_deal_stage_readiness_deals__deal_id__stage_readiness_get',{path}))),
  safe(async()=>arr(unwrap(await call('list_deal_documents_deals__deal_id__documents_get',{path})),'items','documents'),[]),
  safe(async()=>arr(unwrap(await call('list_quotes_quotes_get',{query:{deal_id:String(dealId),limit:20}})),'quotes','items'),[]),
 ]);
 return {
  deal:{id:detail.id,name:detail.name,stage:detail.stage||detail.stage_name,stageId:detail.stage_id,pipelineId:detail.pipeline_id,amount:detail.amount??lines?.amount??null,currency:detail.currency||lines?.currency||'USD',closeDate:detail.close_date||null,description:detail.description||'',companyId:detail.company_id||null,companyName:detail.company_name||detail.company?.name||null},
  stakeholders:contacts.map(c=>({id:c.person_id||c.id,name:c.name||c.contact_name||[c.CONTACT_FIRST_NAME,c.CONTACT_LAST_NAME].filter(Boolean).join(' '),title:c.title||c.CONTACT_JOB_TITLE||'',email:c.email||c.CONTACT_WORK_EMAIL||'',role:c.buying_role||c.role||null,primary:!!c.is_primary})),
  notes:notes.slice(0,12).map(n=>({id:n.id,content:String(n.content||'').slice(0,1200),at:n.created_at,by:n.created_by_name||n.created_by})),
  lineItems:(lines?.line_items||[]).map(l=>({name:l.product_name||l.name,quantity:l.quantity,amount:l.amount??l.unit_amount,currency:l.currency})),
  readiness:readiness?{stage:readiness.current_stage_name,next:readiness.next_stage_name,coverage:readiness.coverage_pct,ready:readiness.ready_to_advance,missing:(readiness.missing_required||[]).map(m=>m.label||m.key)}:null,
  documents:docs.map(d=>({id:d.id,title:d.title||d.doc_type||d.name,type:d.doc_type,url:d.url||d.public_url||null,status:d.status})),
  quotes:quotes.map(q=>({id:q.id,number:q.quote_number||q.number,title:q.title,status:q.status,total:q.total??q.total_amount,currency:q.currency,url:q.public_url||q.url||null,viewedAt:q.viewed_at||null,signedAt:q.signed_at||q.accepted_at||null})),
  syncedAt:new Date().toISOString(),
 };
}
export async function dealNote(dealId,content){return unwrap(await call('create_deal_note_deals__deal_id__notes_post',{path:{deal_id:String(dealId)},body:{content:content.slice(0,20000)}}));}
export async function advanceDeal(dealId){return unwrap(await call('advance_deal_stage_deals__deal_id__advance_stage_post',{path:{deal_id:String(dealId)}}));}
export async function nextBestStep(dealId){return unwrap(await call('suggest_deal_next_best_step_deals__deal_id__next_best_step_post',{path:{deal_id:String(dealId)}},{timeout:60000}));}
export async function createDeal(body,{key}={}){return unwrap(await call('create_deal_deals_post',{body},{idempotencyKey:key}));}
export async function pipelines(){return arr(unwrap(await call('list_pipelines_deals_pipelines_get',{})),'pipelines','items');}
export async function teamOwner(){const t=unwrap(await call('list_team_members_team_members_get',{query:{limit:20}}));return (t?.items||t?.team_members||[]).find(m=>m.status==='active');}
