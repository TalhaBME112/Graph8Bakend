import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, text, date, number, id, now, safeUrl, createExperiment, experimentResult } from './domain.mjs';
import { graph8Client } from './graph8.mjs';

const find = (s, type, key) => { const row = s[type].find(x => x.id === key); if (!row) throw new AppError('Record not found.',404); return row; };
const equal = (a,b) => { const x=Buffer.from(a||''),y=Buffer.from(b||''); return x.length === y.length && timingSafeEqual(x,y); };
const activity = (row, action) => { row.updatedAt=now(); row.activity ??=[]; row.activity.unshift({id:id(),at:now(),action}); row.activity=row.activity.slice(0,200); };
export function aggregateNumbers(value, prefix='', result={}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for(const [key,v] of Object.entries(value)) { const path=prefix?`${prefix}.${key}`:key; if(typeof v==='number' && Number.isFinite(v)) result[path]=v; else if(v && typeof v==='object' && !Array.isArray(v) && path.split('.').length<6) aggregateNumbers(v,path,result); }
  return result;
}
export function refreshGoalProgress(s) {
  for(const g of s.goals) {
    if (!g.progressExperimentId || g.status === 'completed') continue;
    const e=s.experiments.find(x=>x.id===g.progressExperimentId); if(!e)continue;
    const result=experimentResult(e); g.achieved=result.A.converted+result.B.converted; g.progressSyncedAt=now();
  }
}
export async function ingestOutcome(store, experimentId, secret, body) {
  return store.update(s=>{
    const e=find(s,'experiments',experimentId);
    if(!e.eventKey || !equal(secret,e.eventKey))throw new AppError('Invalid event credential.',401);
    if(e.status!=='running')throw new AppError('Experiment is not running.',409);
    const eventId=text(body.eventId,'Event ID',200),contactId=text(body.contactId,'Contact ID',200);
    if(typeof body.converted!=='boolean')throw new AppError('converted must be a boolean.');
    e.events ??=[];
    if(e.events.some(x=>x.eventId===eventId))return {duplicate:true};
    const person=e.participants.find(x=>x.contactId===contactId); if(!person)throw new AppError('Assign this contact to the experiment first.',404);
    const occurredAt=Date.parse(body.occurredAt); if(!Number.isFinite(occurredAt) || occurredAt>Date.now()+60000)throw new AppError('Supply an ISO occurredAt timestamp, not in the future.');
    if(person.outcomeAt && occurredAt<Date.parse(person.outcomeAt))throw new AppError('A more recent outcome has already been recorded.',409);
    if(e.events.length>=50000)throw new AppError('Event limit reached for this experiment.',409);
    person.converted=body.converted;person.outcomeAt=new Date(occurredAt).toISOString();person.source='event';
    e.events.push({eventId,contactId,at:now()});activity(e,'Outcome received from event API'); refreshGoalProgress(s);
    return {accepted:true,variant:person.variant};
  });
}

// Returns undefined only when the route belongs to the base API.
export async function featureRoute({store,p,method,b,url,busy}) {
  const collection=p[1], key=p[2], action=p[3];
  if(collection==='export' && method==='GET')return {version:1,exportedAt:now(),...store.read(),security:'Contains buyer links and event credentials; keep private.'};
  if(collection==='rooms') {
    if(method==='PATCH' && p.length===3)return store.update(s=>{const r=find(s,'rooms',key); for(const field of ['name','company','summary']) if(b[field]!==undefined)r[field]=text(b[field],field,field==='summary'?4000:500); if(b.archived!==undefined){r.archived=Boolean(b.archived);if(r.archived){r.shareToken=null;r.shareExpiresAt=null;}} activity(r,b.archived?'Room archived and access revoked':'Room details updated');return {success:true};});
    if(method==='DELETE' && ['documents','milestones'].includes(action))return store.update(s=>{const r=find(s,'rooms',key),before=r[action].length;r[action]=r[action].filter(x=>x.id!==p[4]);if(r[action].length===before)throw new AppError('Item not found.',404);activity(r,`${action==='documents'?'Resource':'Milestone'} removed`);return {success:true};});
    if(method==='PATCH' && action==='milestones' && b.title!==undefined)return store.update(s=>{const r=find(s,'rooms',key),m=r.milestones.find(x=>x.id===p[4]);if(!m)throw new AppError('Milestone not found.',404);m.title=text(b.title,'Title');m.owner=text(b.owner,'Owner');m.due=date(b.due);m.buyerEditable=Boolean(b.buyerEditable);activity(r,'Milestone edited');return {success:true};});
    if(method==='POST' && action==='sync') {
      const r=find(store.read(),'rooms',key); if(!r.dealId)throw new AppError('Import a Graph8 deal to use this feature.');
      const response=await graph8Client().call('get_deal_deals__deal_id__get',{path:{deal_id:r.dealId}});
      const value=response.data || response;
      return store.update(s=>{const room=find(s,'rooms',key); room.dealSnapshot={name:value.name||value.title,stage:value.stage_name||value.stage?.name||value.stage_id,amount:value.amount,currency:value.currency||'USD',status:value.status||value.outcome,at:now()};activity(room,'Graph8 deal refreshed');return {success:true};});
    }
  }
  if(collection==='experiments') {
    if(method==='POST' && action==='event-key')return store.update(s=>{const e=find(s,'experiments',key);e.eventKey=randomBytes(32).toString('hex');activity(e,'Event credential rotated');return {success:true};});
    if(method==='POST' && action==='clone')return store.update(s=>{const source=find(s,'experiments',key),e=createExperiment({...source,name:`${source.name} · follow-up`});e.hypothesis=b.hypothesis?text(b.hypothesis,'Hypothesis',2000):source.hypothesis;e.previousExperimentId=source.id;s.experiments.unshift(e);return e;});
    if(method==='PATCH' && action==='details')return store.update(s=>{const e=find(s,'experiments',key);if(e.status!=='draft')throw new AppError('Design is locked after the experiment starts. Clone it for a new hypothesis.',409);for(const f of ['name','hypothesis','metric','variantA','variantB'])if(b[f]!==undefined)e[f]=text(b[f],f,2000);if(b.minimum!==undefined){e.minimum=number(b.minimum,'Minimum per variant',30,100000);if(!Number.isInteger(e.minimum))throw new AppError('Minimum must be a whole number.');} activity(e,'Experiment design updated');return {success:true};});
    if(method==='POST' && action==='import-outcomes')return store.update(s=>{const e=find(s,'experiments',key);if(e.status!=='running')throw new AppError('Start tracking before importing outcomes.');if(!Array.isArray(b.rows)||b.rows.length>10000)throw new AppError('Supply at most 10,000 rows.');const seen=new Set();for(const row of b.rows){if(seen.has(row.contactId))throw new AppError('Duplicate contact in outcome import.');seen.add(row.contactId);const person=e.participants.find(x=>x.contactId===row.contactId);if(!person)throw new AppError(`Unknown contact: ${String(row.contactId).slice(0,80)}`);if(typeof row.converted!=='boolean')throw new AppError('Every outcome must be true or false.');person.converted=row.converted;person.source='csv';person.outcomeAt=now();}activity(e,`Imported ${b.rows.length} outcomes`);refreshGoalProgress(s);return {success:true,count:b.rows.length};});
    if(method==='POST' && action==='sync') {
      const e=find(store.read(),'experiments',key);if(!e.campaignA||!e.campaignB)throw new AppError('Link distinct Graph8 campaigns for A and B first.');
      const responses=await Promise.all(['A','B'].map(v=>graph8Client().call('get_campaign_metrics_campaigns__campaign_id__metrics_get',{path:{campaign_id:e[`campaign${v}`]}})));
      return store.update(s=>{const exp=find(s,'experiments',key);exp.campaignMetrics={A:aggregateNumbers(responses[0].data||responses[0]),B:aggregateNumbers(responses[1].data||responses[1]),at:now()};activity(exp,'Graph8 campaign metrics refreshed');return {success:true};});
    }
  }
  if(collection==='goals') {
    if(busy.has(key))throw new AppError('Wait for the running action before editing.',409);
    if(method==='PATCH' && action==='details')return store.update(s=>{const g=find(s,'goals',key);if(g.status==='completed')throw new AppError('Completed goals are read-only.');for(const f of ['name','audience'])if(b[f]!==undefined)g[f]=text(b[f],f,2000);if(b.deadline!==undefined)g.deadline=date(b.deadline);if(b.budget!==undefined)g.budget=number(b.budget,'Budget',0);if(b.target!==undefined){g.target=number(b.target,'Target',1);if(!Number.isInteger(g.target))throw new AppError('Target must be a whole number.');}activity(g,'Goal details updated');return {success:true};});
    if(method==='PATCH' && action==='steps')return store.update(s=>{const g=find(s,'goals',key);if(!['draft','paused'].includes(g.status))throw new AppError('Pause this goal before editing its plan.');const step=g.steps.find(x=>x.id===p[4]);if(!step||step.status!=='pending')throw new AppError('Only pending steps can be edited.');step.title=text(b.title,'Title');step.detail=text(b.detail,'Description',2000);step.config=b.config&&typeof b.config==='object'?{name:text(b.config.name||step.title,'Output name'),hypothesis:typeof b.config.hypothesis==='string'?b.config.hypothesis.slice(0,2000):'',variantA:typeof b.config.variantA==='string'?b.config.variantA.slice(0,500):'',variantB:typeof b.config.variantB==='string'?b.config.variantB.slice(0,500):''}:{};activity(g,'Plan step edited');return {success:true};});
    if(method==='POST' && action==='link-progress')return store.update(s=>{const g=find(s,'goals',key);if(g.status==='completed')throw new AppError('Completed goals are read-only.');if(!b.experimentId){g.progressExperimentId=null;return {success:true};}const e=find(s,'experiments',b.experimentId);g.progressExperimentId=e.id;g.metric=e.metric;refreshGoalProgress(s);activity(g,`Progress linked to ${e.name}`);return {success:true};});
    if(method==='POST' && action==='automation')return store.update(s=>{const g=find(s,'goals',key);if(g.status==='completed')throw new AppError('Completed goals are read-only.');g.autopilotLocal=b.enabled===true;activity(g,g.autopilotLocal?'Local plan automation enabled':'Local plan automation disabled');return {success:true};});
    if(method==='POST' && action==='reconcile') {
      const g=find(store.read(),'goals',key),step=g.steps.find(x=>x.id===b.stepId);
      if(!step||!['uncertain','running'].includes(step.status))throw new AppError('Only uncertain actions require reconciliation.');
      if(!b.campaignId)throw new AppError('Choose the existing Graph8 campaign that fulfills this action.');
      await graph8Client().call('get_campaign_campaigns__campaign_id__get',{path:{campaign_id:text(b.campaignId,'Campaign ID')}});
      return store.update(s=>{const goal=find(s,'goals',key),st=goal.steps.find(x=>x.id===b.stepId);st.status='completed';st.entityId=b.campaignId;goal.receipts.unshift({id:id(),at:now(),action:st.title,detail:`Reconciled with existing Graph8 campaign ${b.campaignId}.`});return {success:true};});
    }
  }
  return undefined;
}
