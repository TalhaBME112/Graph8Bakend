import {createApiClient} from '@graph8/sdk';
import {AppError} from '../domain.mjs';
export const resources={companies:'list_companies_companies_get',contacts:'list_contacts_contacts_get',deals:'list_deals_deals_get',quotes:'list_quotes_quotes_get',products:'list_quotable_products_quotable_products_get',knowledge:'list_knowledge_knowledge_get',context:'list_global_context_documents_global_context_documents_get',profile:'get_company_profile_company_profile_get',pipelines:'list_pipelines_deals_pipelines_get',workflows:'list_workflows_workflows_get'};
let identity;
function client(){if(!process.env.G8_API_KEY)throw new AppError('Connect a Graph8 API key to use Tender Workspace.',503);return createApiClient(process.env.G8_API_KEY);}
export async function orgContext(force=false){if(!force&&identity&&identity.expires>Date.now())return identity.value;const r=await client().call('describe_current_key_me_get',{}, {signal:AbortSignal.timeout(20000)});const d=r.data||r;if(!d.org_id)throw new AppError('Graph8 did not identify the organization.',502);const value={id:d.org_id,name:d.org_name,scopes:d.scopes||[],unrestricted:d.unrestricted===true,checkedAt:new Date().toISOString()};identity={value,expires:Date.now()+30000};return value;}
export const can=(org,scope)=>org.unrestricted||(org.scopes||[]).includes(scope);
export function rows(value,resource){const d=value?.data??value;for(const candidate of [d,d?.[resource],d?.items,d?.documents,d?.actions,d?.concepts,d?.pipelines])if(Array.isArray(candidate))return candidate;if(d&&typeof d==='object')return [d];return [];}
export async function readResource(resource,page=1,query=''){
 const op=resources[resource];if(!op)throw new AppError('Unknown Graph8 resource.');
 let input={};if(['companies','contacts','deals','quotes','products'].includes(resource))input={query:{limit:100,page}};
 if(resource==='companies'&&query)input.query.name=query;if(resource==='deals'&&query)input.query.search=query;
 if(resource==='knowledge')input={query:{limit:100}};if(resource==='context')input={query:{include_content:true,limit:100}};
 const result=await client().call(op,input,{signal:AbortSignal.timeout(20000)});
 return {resource,rows:rows(result,resource),page,hasNext:result.pagination?.has_next??false,checkedAt:new Date().toISOString(),source:'Graph8 live API',operation:op};
}
export async function liveCall(operation,input={},options={}){const org=await orgContext(true),c=client(),meta=c.operation(operation);if(!can(org,meta.scope))throw new AppError(`Graph8 permission required: ${meta.scope}. Your key is read-only for this operation.`,403);return c.call(operation,input,{maxRetries:0,signal:AbortSignal.timeout(30000),...options});}
export async function liveRecord(type,id){const operations={companies:'get_company_companies__company_id__get',deals:'get_deal_deals__deal_id__get',quotes:'get_quote_quotes__quote_id__get',contacts:'get_contact_contacts__contact_id__get'};const keys={companies:'company_id',deals:'deal_id',quotes:'quote_id',contacts:'contact_id'};const op=operations[type];if(!op)throw new AppError('Unsupported record type.');const r=await liveCall(op,{path:{[keys[type]]:id}});return r.data||r;}
