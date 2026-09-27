import { createApiClient } from '@graph8/sdk';
import { AppError } from './domain.mjs';

// Only the Node service imports the privileged SDK. Nothing is bundled into Angular.
export function graph8Client(transport = {}) {
  if (!process.env.G8_API_KEY) throw new AppError('Set G8_API_KEY on the server and restart it to connect Graph8.', 503);
  const client=createApiClient(process.env.G8_API_KEY);
  return {call:(operation,input={},options={})=>client.call(operation,input,{signal:AbortSignal.timeout(30000),...transport,...options})};
}
export async function graph8Read(resource, page=1) {
  const client = graph8Client();
  const operations = { deals: 'list_deals_deals_get', campaigns: 'list_campaigns_campaigns_get', contacts: 'list_contacts_contacts_get' };
  if (!operations[resource]) throw new AppError('Unknown Graph8 resource.');
  return client.call(operations[resource], { query: {limit:100,page} });
}
export async function draftCampaign(goal, transport = {}) {
  return graph8Client(transport).call('create_campaign_campaigns_post', { body: { name: goal.name, brief: `Audience: ${goal.audience}. Target: ${goal.target} ${goal.metric} by ${goal.deadline}. Planning budget: USD ${goal.budget}.`, goal: `${goal.target} ${goal.metric}`, category: 'Growth workspace', auto_generate_documents: false } }, {maxRetries:0,idempotencyKey:`growth-${goal.id}-${goal.stepId || 'campaign'}`});
}
