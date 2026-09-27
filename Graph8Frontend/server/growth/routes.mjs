// /api/growth/* — Graph8-powered layers for Buyer Deal Rooms, the Campaign Learning Lab and
// Run My Goal. Workspace records stay in the JSON store; agent runs use the BidFlow engine.
import {resolve} from 'node:path';
import {AppError,id,now,text,number,date,createRoom,experimentResult} from '../domain.mjs';
import {aggregateNumbers} from '../features.mjs';
import {openTenderDb} from '../tender/database.mjs';
import {createEngine,describeGraph} from '../tender/bidflow/engine.mjs';
import {think,ensureSkill} from '../tender/bidflow/llm.mjs';
import * as g8 from '../tender/bidflow/g8.mjs';
import {titleRank,domainOf} from '../tender/bidflow/common.mjs';
import * as gx from './g8x.mjs';
import {samplePerArm,decide,metricCounts} from './stats.mjs';
import {goalGraph,syncGoalProgress} from './goal-graph.mjs';

const ORG='growth';
const find=(s,type,key)=>{const row=s[type].find(x=>x.id===key);if(!row)throw new AppError('Record not found.',404);return row;};
const log=(row,action)=>{row.activity??=[];row.activity.unshift({id:id(),at:now(),action});row.activity=row.activity.slice(0,200);};
const tryThink=async(task,payload,fallback,opts)=>{try{const r=await think(task,payload,opts);return {...r.data,_engine:`Graph8 skill · ${r.meta.model}`};}catch{return {...fallback(),_engine:'rules fallback'};}};

export function createGrowth({store,root}){
 const db=openTenderDb(process.env.GROWTH_DB||resolve(root,'server/data/growth.sqlite'));
 const graphs={goal_run:goalGraph(store)},engine=createEngine(db,graphs);
 const lastViewNote=new Map();

 // ── Buyer engagement → room timeline + Graph8 deal notes ─────────────────────
 async function track(roomId,type,detail,who){
  const room=await store.update(s=>{const r=s.rooms.find(x=>x.id===roomId);if(!r)return null;r.engagement??=[];r.engagement.unshift({id:id(),type,detail,who:who||'Buyer',at:now()});r.engagement=r.engagement.slice(0,500);r.lastBuyerActivityAt=now();return {dealId:r.dealId,name:r.name};});
  if(!room?.dealId)return;
  if(type==='view'){const last=lastViewNote.get(roomId)||0;if(Date.now()-last<3600e3)return;lastViewNote.set(roomId,Date.now());}
  try{await gx.dealNote(room.dealId,`Deal room "${room.name}" · ${who||'Buyer'} ${detail}`);}catch{}
 }

 async function syncIntel(roomId){
  const r=find(store.read(),'rooms',roomId);if(!r.dealId)throw new AppError('Link this room to a Graph8 deal first.',400);
  const intel=await gx.dealIntel(r.dealId);
  return store.update(s=>{const room=find(s,'rooms',roomId);room.intel=intel;room.dealSnapshot={name:intel.deal.name,stage:intel.deal.stage,amount:intel.deal.amount,currency:intel.deal.currency,at:now()};log(room,'Graph8 deal intelligence refreshed');return room;});
 }
 async function aiPlan(roomId){
  const r=find(store.read(),'rooms',roomId);
  const plan=await tryThink('You are preparing a buyer-facing deal room. Using the Graph8 deal data, write a warm, specific welcome summary and a mutual action plan that closes the missing stage requirements and moves the deal to signature. Return {"summary":string (<=90 words, buyer-facing, no internal notes),"milestones":[{"title":string,"owner":"buyer"|"seller","due_in_days":number,"why":string}] (5-7, ordered),"faq":[{"question":string,"answer":string}] (0-3, only facts in the data)}.',{room:{name:r.name,company:r.company,summary:r.summary},deal:r.intel?.deal,stage_readiness:r.intel?.readiness,stakeholders:r.intel?.stakeholders?.map(x=>({title:x.title,role:x.role})),recent_notes:r.intel?.notes?.slice(0,6).map(n=>n.content),line_items:r.intel?.lineItems,existing_milestones:r.milestones.map(m=>m.title)},
   ()=>({summary:r.summary,milestones:[...(r.intel?.readiness?.missing||[]).map((m,i)=>({title:m,owner:'seller',due_in_days:3+i*3,why:'Required to advance the Graph8 deal stage'})),{title:'Confirm decision criteria and stakeholders',owner:'buyer',due_in_days:5,why:'Aligns the evaluation'},{title:'Review commercial proposal',owner:'buyer',due_in_days:12,why:'Moves toward signature'},{title:'Signature and kickoff date',owner:'buyer',due_in_days:21,why:'Close'}],faq:[]}),{timeoutMs:90000});
  return plan;
 }

 async function route({p,method,b,url}){
  if(p[1]!=='growth')return undefined;
  const [, ,kind,key,action]=p;

  // Shared Graph8 pickers
  if(kind==='graph8'&&method==='GET'){
   if(key==='status'){let skill=null;try{skill=await ensureSkill();}catch{}let org=null;try{org=await g8.me();}catch{}return {org,skill,mailboxes:(await g8.mailboxes()).length};}
   if(key==='companies'){const q=String(url.searchParams.get('q')||'').trim().slice(0,120);if(q.length<2)throw new AppError('Type at least two characters.');const byDomain=/\.[a-z]{2,}$/i.test(q);return (await g8.findCompanies([{field:byDomain?'domain':'name',operator:byDomain?'any_of':'contains',value:[q.replace(/^https?:\/\//,'').replace(/^www\./,'')]}],{limit:8})).rows.map(c=>({name:c.name,domain:domainOf(c),industry:c.industry,employee_count:c.employee_count,revenue:c.revenue,city:c.city,state:c.state,country:c.country,linkedin_url:c.linkedin_url,logo_url:c.logo_url,description:String(c.description||'').slice(0,600)}));}
   if(key==='people'){const d=String(url.searchParams.get('domain')||'').toLowerCase();if(!d)throw new AppError('Choose a company first.');const r=await g8.findContacts([{field:'company_domain',operator:'any_of',value:[d]}],{limit:60});return r.rows.filter(x=>String(x.company_domain).toLowerCase()===d).map(x=>({first_name:x.first_name,last_name:x.last_name,job_title:x.job_title,seniority_level:x.seniority_level,linkedin_url:x.linkedin_url,company_domain:d,state:x.state,country:x.country,rank:titleRank(x.job_title)})).filter(x=>x.first_name).sort((a,c)=>c.rank-a.rank).slice(0,25);}
   if(key==='lists')return (await gx.listLists()).map(l=>({id:l.id,title:l.title,total:l.total,type:l.type}));
   if(key==='campaigns')return (await gx.listCampaigns()).map(c=>({id:c.id,name:c.name,status:c.status}));
   if(key==='deals')return (await gx.listDeals()).map(d=>({id:d.id,name:d.name,stage:d.stage_name||d.stage,amount:d.amount,currency:d.currency}));
  }

  // ── Buyer Deal Room ────────────────────────────────────────────────────────
  if(kind==='rooms'){
   if(key==='from-graph8'&&method==='POST'){
    const c=b.company||{},people=Array.isArray(b.people)?b.people.slice(0,8):[];if(!c.domain||!c.name)throw new AppError('Choose a Graph8 company.');if(!people.length)throw new AppError('Choose at least one stakeholder.');
    const k=`room-${String(c.domain).toLowerCase()}-${Date.now()}`,companyId=await g8.upsertCompany(c,{key:k+'-co'});
    const contactIds=[];for(const person of people){const cid=await g8.upsertContact({...person,company_domain:c.domain,company_id:companyId},{key:`${k}-${person.linkedin_url||person.first_name+person.last_name}`.slice(0,200)});if(cid)contactIds.push(Number(cid));}
    let dealId=b.dealId||null;
    if(!dealId){const pipes=await gx.pipelines(),pipe=pipes.find(x=>x.is_default)||pipes[0],stage=pipe?.stages?.find(x=>/discovery/i.test(x.name))||pipe?.stages?.find(x=>x.stage_type==='open'),owner=await gx.teamOwner();if(!owner)throw new AppError('No active Graph8 team member can own the deal.');
     const d=await gx.createDeal({name:text(b.dealName||`${c.name} · evaluation`,'Deal name',250),amount:Number(b.amount)||null,currency:/^[A-Z]{3}$/.test(b.currency||'')?b.currency:'USD',contact_ids:contactIds,company_id:Number(companyId),owner_id:owner.id,pipeline_id:pipe?.id,stage_id:stage?.id,description:`Created from a BidFlow Buyer Deal Room for ${c.name}.`},{key:k+'-deal'});dealId=d?.id??d?.deal_id;}
    const room=createRoom({name:b.dealName||`${c.name} · evaluation`,company:c.name,summary:b.summary||`Welcome to your shared workspace with our team. Everything for your evaluation of our solution lives here.`,dealId:String(dealId)});room.graph8Company={...c,companyId};
    await store.update(s=>{s.rooms.unshift(room);});
    await syncIntel(room.id);const plan=await aiPlan(room.id);
    await store.update(s=>{const r=find(s,'rooms',room.id);r.summary=plan.summary||r.summary;const start=Date.now();r.milestones=(plan.milestones||[]).slice(0,8).map(m=>({id:id(),title:String(m.title).slice(0,300),owner:m.owner==='buyer'?`${c.name} team`:'Our team',due:new Date(start+(Number(m.due_in_days)||7)*864e5).toISOString().slice(0,10),done:false,buyerEditable:m.owner==='buyer',why:m.why||''})).sort((x,y)=>x.due.localeCompare(y.due));r.faq=plan.faq||[];r.aiEngine=plan._engine;log(r,'Room built from live Graph8 deal with an AI mutual action plan');});
    try{await gx.dealNote(dealId,`Buyer Deal Room created: "${room.name}" with ${people.length} stakeholders and a mutual action plan.`);}catch{}
    return find(store.read(),'rooms',room.id);
   }
   const r=find(store.read(),'rooms',key);
   if(action==='link-deal'&&method==='POST'){await store.update(s=>{const room=find(s,'rooms',key);room.dealId=text(String(b.dealId),'Deal',200);log(room,'Linked to Graph8 deal');});return syncIntel(key);}
   if(action==='intel'&&method==='POST')return syncIntel(key);
   if(action==='ai-plan'&&method==='POST'){if(r.dealId&&!r.intel)await syncIntel(key);return aiPlan(key);}
   if(action==='apply-plan'&&method==='POST')return store.update(s=>{const room=find(s,'rooms',key);if(typeof b.summary==='string'&&b.summary.trim())room.summary=b.summary.trim().slice(0,4000);if(Array.isArray(b.milestones)){const start=Date.now();for(const m of b.milestones.slice(0,10))room.milestones.push({id:id(),title:text(m.title,'Milestone',300),owner:m.owner==='buyer'?`${room.company} team`:'Our team',due:new Date(start+(Number(m.due_in_days)||7)*864e5).toISOString().slice(0,10),done:false,buyerEditable:m.owner==='buyer',why:String(m.why||'').slice(0,300)});}if(Array.isArray(b.faq))room.faq=b.faq.slice(0,6).map(f=>({question:String(f.question).slice(0,300),answer:String(f.answer).slice(0,1000)}));log(room,'AI mutual action plan applied');return room;});
   if(action==='push'&&method==='POST'){if(!r.dealId)throw new AppError('Link a Graph8 deal first.');const doneN=r.milestones.filter(m=>m.done).length;const content=`Mutual action plan · ${r.name}\n${doneN}/${r.milestones.length} complete\n\n${r.milestones.map(m=>`${m.done?'✓':'○'} ${m.title} — ${m.owner}, due ${m.due}`).join('\n')}\n\nOpen buyer questions: ${r.questions.filter(q=>!q.answer).length}. Buyer engagement events: ${(r.engagement||[]).length}.`;await gx.dealNote(r.dealId,content);await store.update(s=>{log(find(s,'rooms',key),'Mutual plan pushed to Graph8 deal notes');});return {success:true};}
   if(action==='advance'&&method==='POST'){if(!r.dealId)throw new AppError('Link a Graph8 deal first.');if(b.approved!==true)throw new AppError('Confirm moving the Graph8 deal to its next stage.');await gx.advanceDeal(r.dealId);try{await gx.dealNote(r.dealId,`Stage advanced from the Buyer Deal Room "${r.name}".`);}catch{}return syncIntel(key);}
   if(action==='next-step'&&method==='POST'){if(!r.dealId)throw new AppError('Link a Graph8 deal first.');const ns=await gx.nextBestStep(r.dealId);return store.update(s=>{const room=find(s,'rooms',key);room.nextStep={value:ns,at:now()};log(room,'Graph8 next best step requested');return room.nextStep;});}
  }

  // ── Campaign Learning Lab ───────────────────────────────────────────────────
  if(kind==='experiments'){
   if(key==='design'&&method==='POST'){
    let context=[],camp=null,seq=null;try{context=await gx.gtmContext();}catch{}
    if(b.campaignId){try{camp=await gx.campaign(b.campaignId);seq=await gx.campaignSequence(b.campaignId);}catch{}}
    const baseline={reply:0.03,open:0.4,click:0.03,meeting:0.01}[b.metric||'reply']||0.03;
    return tryThink('Design ONE rigorous A/B test for a B2B outbound campaign. Change a single variable. Return {"name":string,"hypothesis":string ("We believe [change] will [increase metric] for [audience] because [insight]; we will know when [measurable result]"),"variable":string,"metric":string,"variant_a":{"label":string,"subject":string,"body":string},"variant_b":{"label":string,"subject":string,"body":string},"baseline":number (0-1 expected control rate),"mde":number (0-1 absolute lift worth detecting),"guardrail":string,"rationale":string}. Bodies <=110 words using {{first_name}}.',{question:String(b.topic||'').slice(0,2000),metric:b.metric||'reply',audience:b.audience||'',campaign:camp?{name:camp.name,brief:camp.brief,concept:camp.core_concept,persona:camp.target_persona}:null,sequence:seq,gtm_context:context},
     ()=>({name:`${String(b.topic||'Message').slice(0,60)} · A/B`,hypothesis:`We believe an outcome-led subject line will increase ${b.metric||'reply'} rate because it names the result buyers care about; we will know when B beats A at the pre-registered sample.`,variable:'Subject line',metric:b.metric||'reply',variant_a:{label:'Problem-led',subject:'Is {{company_name}} losing time on this?',body:'Hi {{first_name}}, teams like yours tell us this problem costs hours every week. Worth a quick chat?'},variant_b:{label:'Outcome-led',subject:'Cut that work in half at {{company_name}}',body:'Hi {{first_name}}, we help teams like yours get the result without the manual effort. Worth a quick chat?'},baseline,mde:baseline*0.5,guardrail:'Unsubscribe rate must stay below 1%',rationale:'Single-variable subject-line test.'}),{timeoutMs:90000});
   }
   const e=find(store.read(),'experiments',key);
   if(action==='plan'&&method==='POST'){if(e.status!=='draft')throw new AppError('The plan is pre-registered and locks when tracking starts.',409);const baseline=number(Number(b.baseline),'Baseline rate',0.0001,0.99),mde=number(Number(b.mde),'Minimum detectable effect',0.0001,0.9),alpha=number(Number(b.alpha??0.05),'Alpha',0.001,0.2),power=number(Number(b.power??0.8),'Power',0.5,0.99);const required=samplePerArm(baseline,mde,alpha,power);
    return store.update(s=>{const x=find(s,'experiments',key);x.plan={baseline,mde,alpha,power,requiredPerArm:required,metricSource:b.metricSource==='graph8'?'graph8':'contacts',metric:['reply','open','click','meeting'].includes(b.metric)?b.metric:'reply',probabilityThreshold:0.95,lossThreshold:Math.max(0.0005,mde/10),guardrail:b.guardrail?{metric:String(b.guardrail).slice(0,200),maxRate:Number(b.guardrailMax)||0.01}:null,registeredAt:now()};x.minimum=Math.max(30,Math.min(100000,required||30));if(b.copy)x.copy={A:b.copy.A,B:b.copy.B};log(x,`Pre-registered plan: ${required} per arm (α=${alpha}, power=${power})`);return x.plan;});}
   if(action==='copy'&&method==='POST')return store.update(s=>{const x=find(s,'experiments',key);if(x.status!=='draft')throw new AppError('Copy locks when tracking starts.',409);const v=o=>({subject:text(o?.subject,'Subject',250),body:text(o?.body,'Body',5000)});x.copy={A:v(b.A),B:v(b.B)};log(x,'Variant copy saved');return x.copy;});
   if(action==='audience'&&method==='POST'){if(e.status!=='draft')throw new AppError('Audience is locked after tracking starts.',409);const members=await gx.listMembers(b.listId,1000);if(!members.length)throw new AppError('That Graph8 list has no contacts.');
    return store.update(s=>{const x=find(s,'experiments',key);x.people??={};let added=0;for(const m of members){const cid=String(m.id);if(x.participants.some(p=>p.contactId===cid))continue;const h=[...`${x.id}:${cid}`].reduce((a,ch)=>(a*31+ch.charCodeAt(0))>>>0,7);x.participants.push({contactId:cid,variant:h%2?'B':'A',converted:null});x.people[cid]={name:[m.first_name,m.last_name].filter(Boolean).join(' ')||m.name,title:m.job_title,company:m.company_name};added++;}x.audienceListId=b.listId;log(x,`Imported ${added} contacts from Graph8 list ${b.listId}`);return {added,total:x.participants.length};});}
   if(action==='launch'&&method==='POST'){
    if(!e.copy)throw new AppError('Save subject and body for both variants first.');if(e.participants.length<2)throw new AppError('Add an audience first.');if(e.campaignA||e.campaignB)throw new AppError('Graph8 campaigns are already linked.',409);
    const out={};for(const v of ['A','B']){const ids=e.participants.filter(p=>p.variant===v).map(p=>Number(p.contactId)).filter(Number.isFinite);const listId=await g8.createList(`Lab · ${e.name} · ${v}`,`Learning Lab arm ${v}: ${e.hypothesis}`.slice(0,900),{key:`lab-${e.id}-list-${v}`});if(ids.length)await g8.addToList(listId,ids);
     out[v]={listId,campaignId:await g8.draftCampaign({name:`Lab · ${e.name} · ${v}`,brief:e.hypothesis,concept:v==='A'?e.variantA:e.variantB,persona:'',listId,subject:e.copy[v].subject,body:e.copy[v].body},{key:`lab-${e.id}-camp-${v}`}),contacts:ids.length};}
    return store.update(s=>{const x=find(s,'experiments',key);x.campaignA=String(out.A.campaignId||'');x.campaignB=String(out.B.campaignId||'');x.graph8Arms=out;x.plan&&(x.plan.metricSource=x.plan.metricSource||'graph8');log(x,'A/B arms created in Graph8 as campaign drafts');return out;});}
   if(action==='decision'&&(method==='GET'||method==='POST')){
    const plan=e.plan||{requiredPerArm:e.minimum,alpha:0.05,mde:0};let A,B,source,flat=null;
    if(plan.metricSource==='graph8'&&e.campaignA&&e.campaignB){const [ma,mb]=await Promise.all([gx.campaignMetrics(e.campaignA),gx.campaignMetrics(e.campaignB)]);const fa=aggregateNumbers(ma),fb=aggregateNumbers(mb);flat={A:fa,B:fb};const ca=metricCounts(fa,plan.metric),cb=metricCounts(fb,plan.metric);A={n:ca.n,x:ca.x};B={n:cb.n,x:cb.x};source=`Graph8 campaign metrics (${ca.successKey||plan.metric} / ${ca.sentKey||'sent'})`;
     await store.update(s=>{const x=find(s,'experiments',key);x.campaignMetrics={A:fa,B:fb,at:now()};});}
    else{const r=experimentResult(e);A={n:r.A.observed,x:r.A.converted};B={n:r.B.observed,x:r.B.converted};source='Contact-level outcomes recorded in the Lab';}
    const verdict=decide({A,B,plan});return store.update(s=>{const x=find(s,'experiments',key);x.decision={...verdict,A,B,source,at:now()};return x.decision;});}
   if(action==='learning'&&method==='POST'){const d=e.decision||{};const out=await tryThink('Write a concise, reusable learning from this experiment for the team playbook. Return {"headline":string,"what_we_learned":string,"next_test":string,"apply_to":string[]}.',{hypothesis:e.hypothesis,variants:{A:e.variantA,B:e.variantB,copy:e.copy},decision:d.label,reasons:d.reasons,metrics:{A:d.A,B:d.B}},()=>({headline:d.label||'Result recorded',what_we_learned:(d.reasons||[]).join(' '),next_test:'Test a bolder change on the same variable.',apply_to:[]}));return store.update(s=>{const x=find(s,'experiments',key);x.learning={...out,at:now()};x.lesson=x.lesson||`${out.headline}\n${out.what_we_learned}\nNext: ${out.next_test}`;log(x,'Learning summarised');return x.learning;});}
  }

  // ── Run My Goal ────────────────────────────────────────────────────────────
  if(kind==='graphs'&&method==='GET')return Object.values(graphs).map(describeGraph);
  if(kind==='goals'){
   if(key==='quick'&&method==='POST'){const {createGoal}=await import('../domain.mjs');const g=createGoal(b);g.steps=[];await store.update(s=>s.goals.unshift(g));const run=engine.start(ORG,'goal_run',{actor:'workspace',userId:'workspace',tenderId:g.id,input:{goal:g},trigger:'goal_created'});await store.update(s=>{find(s,'goals',g.id).orchestration={runId:run.id,at:now()};});return {goal:g,run};}
   const g=find(store.read(),'goals',key);
   if(action==='orchestrate'&&method==='POST'){const run=engine.start(ORG,'goal_run',{actor:'workspace',userId:'workspace',tenderId:g.id,input:{goal:g}});await store.update(s=>{const x=find(s,'goals',key);x.orchestration={...(x.orchestration||{}),runId:run.id,at:x.orchestration?.at||now()};});return run;}
   if(action==='runs'&&method==='GET')return engine.list(ORG,r=>r.tenderId===key).map(engine.view);
   if(action==='sync'&&method==='POST'){const pace=await syncGoalProgress(store,key);if(!pace)throw new AppError('Run the Goal Orchestrator first so the goal has Graph8 campaigns to track.');return pace;}
  }
  if(kind==='runs'){const run=engine.get(ORG,key);
   if(method==='GET'&&!action)return engine.view(run);
   if(action==='approve'&&method==='POST'){if(!['approve','reject'].includes(b.decision))throw new AppError('Choose approve or reject.');return engine.view(engine.resume(ORG,key,'workspace',{decision:b.decision,contacts:Math.max(0,Math.min(50,Number(b.contacts)||0)),campaigns:b.campaigns!==false,experiment:b.experiment!==false,room:b.room!==false}));}
   if(action==='resume'&&method==='POST')return engine.view(engine.resume(ORG,key,'workspace',{}));
   if(action==='cancel'&&method==='POST')return engine.view(engine.cancel(ORG,key,'workspace'));
  }
  throw new AppError('Growth route not found.',404);
 }

 // Keep goal progress live from Graph8 campaign metrics.
 const timer=setInterval(async()=>{for(const g of store.read().goals){if(g.status==='active'&&g.orchestration?.campaigns&&(!g.pace?.at||Date.now()-Date.parse(g.pace.at)>5*60e3)){try{await syncGoalProgress(store,g.id);}catch{}}}},60e3);timer.unref();
 return {route,track,close(){clearInterval(timer);db.close();}};
}
