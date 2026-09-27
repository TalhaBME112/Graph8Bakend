// Run My Goal: an orchestration graph over existing Graph8 primitives (GTM context, the
// contact graph, lists, campaigns/sequences) plus the workspace's Lab and Deal Rooms.
import {defineGraph,END} from '../tender/bidflow/engine.mjs';
import * as g8 from '../tender/bidflow/g8.mjs';
import * as gx from './g8x.mjs';
import {id,now,createExperiment,createRoom} from '../domain.mjs';
import {samplePerArm} from './stats.mjs';
import {country,clamp} from '../tender/bidflow/common.mjs';

const RATES={'Qualified meetings':{chain:['reply','meeting'],reply:0.03,meeting:0.3},'Qualified replies':{chain:['reply'],reply:0.03},'New opportunities':{chain:['reply','meeting','opportunity'],reply:0.03,meeting:0.3,opportunity:0.5}};
const TITLE_HINTS=['VP','Head','Director','Chief','Manager','Founder','Owner','Lead'];
const days=d=>Math.max(1,Math.round((Date.parse(d)-Date.now())/864e5));

export function goalGraph(store){
 return defineGraph({id:'goal_run',name:'Goal Orchestrator',description:'Turns an outcome goal into a sized, paced and approved go-to-market plan executed on Graph8 primitives.',start:'understand_goal',
 nodes:{
  understand_goal:{label:'Understand goal',kind:'llm',about:'Graph8 LLM reads the goal and your Graph8 GTM context (ICP, personas, messaging) and turns it into an audience definition and funnel assumptions.',
   async run(s,ctx){
    let context=[];try{context=await gx.gtmContext();}catch{}
    const g=s.goal,widen=s.widen||0;
    const {data,engine}=await ctx.tryThink(`Translate this growth goal into a targetable B2B audience for Graph8's contact database.${widen?` The previous audience was too small; broaden job titles and adjacent roles (widening pass ${widen}) but KEEP the same countries/geography.`:''} Return {"objective":string,"job_titles":string[] (3-8 short title keywords, e.g. "Operations","Head of Sales"),"seniority":string[] (from ["Owner","Founder","C-Level","Partner","Vice President","Director","Manager"]),"industries":string[] (1-4 broad industry words),"countries":string[],"company_size":string|null,"messaging_angle":string,"reply_rate":number (0-1 expected cold reply rate),"meeting_rate":number (0-1 replies that become meetings),"assumptions":string[]}.`,{goal:{name:g.name,audience:g.audience,target:g.target,metric:g.metric,deadline:g.deadline,budget:g.budget},previous:s.audience||null,gtm_context:context},
     ()=>{const words=String(g.audience).split(/[^A-Za-z&]+/).filter(w=>w.length>3);return {objective:`${g.target} ${g.metric} by ${g.deadline}`,job_titles:words.filter(w=>/^[A-Z]/.test(w)).slice(0,5).concat(['Director']).slice(0,6),seniority:['Director','Vice President','C-Level'],industries:[],countries:[],company_size:null,messaging_angle:'Outcome-led message tied to the audience’s core metric.',reply_rate:0.03,meeting_rate:0.3,assumptions:['Benchmark cold reply rate of 3%.']};});
    const audience={...data,job_titles:(data.job_titles||[]).slice(0,8),industries:widen>=1?[]:(data.industries||[]).slice(0,4),countries:(s.audience?.countries?.length?s.audience.countries:(data.countries||[]).map(country).filter(Boolean)),seniority:widen>=2?[]:(data.seniority||[])};
    return {patch:{audience,gtmDocs:context.map(c=>c.title)},summary:`${audience.objective} · titles: ${audience.job_titles.join(', ')}${audience.industries.length?' · '+audience.industries.join(', '):''}${audience.countries.length?' · '+audience.countries.join(', '):''}`,detail:{engine,gtmContextUsed:context.map(c=>c.title),...audience}};
   }},
  audit_gtm:{label:'Audit GTM state',kind:'graph8',about:'Reads current Graph8 pipeline, campaigns, lists and mailboxes, plus workspace experiments and rooms.',
   async run(s,ctx){
    const [deals,campaigns,lists,boxes]=await Promise.all([gx.listDeals().catch(()=>[]),gx.listCampaigns().catch(()=>[]),gx.listLists().catch(()=>[]),g8.mailboxes({trace:ctx.trace})]);
    const ws=store.read(),open=deals.filter(d=>!/closed|won|lost/i.test(d.stage_name||d.stage||''));
    const audit={deals:deals.length,openDeals:open.length,pipelineValue:open.reduce((n,d)=>n+(Number(d.amount)||0),0),campaigns:campaigns.length,liveCampaigns:campaigns.filter(c=>/active|running|launched/i.test(c.status||'')).length,lists:lists.length,mailboxes:boxes.length,experiments:ws.experiments.length,rooms:ws.rooms.length};
    return {patch:{audit},summary:`${audit.openDeals} open deals · ${audit.campaigns} campaigns (${audit.liveCampaigns} live) · ${audit.lists} lists · ${audit.mailboxes} mailboxes · ${audit.experiments} experiments · ${audit.rooms} rooms`,detail:audit};
   }},
  size_market:{label:'Size the market',kind:'graph8',about:'Counts reachable decision makers and companies in Graph8\'s open data index for this audience.',
   async run(s,ctx){
    const a=s.audience,f=[];
    if(a.job_titles?.length)f.push({field:'job_title',operator:'contains',value:a.job_titles});
    if(a.industries?.length)f.push({field:'company_industry',operator:'contains',value:a.industries});
    if(a.countries?.length)f.push({field:'country',operator:'any_of',value:a.countries});
    if(a.seniority?.length)f.push({field:'seniority_level',operator:'any_of',value:a.seniority});
    let r=await g8.findContacts(f,{limit:60,trace:ctx.trace});
    if(!r.rows.length&&f.some(x=>x.field==='seniority_level')){const f2=f.filter(x=>x.field!=='seniority_level');r=await g8.findContacts(f2,{limit:60,trace:ctx.trace});f.splice(0,f.length,...f2);}
    const prospects=r.rows.filter(p=>p.first_name&&p.company_domain).map(p=>({first_name:p.first_name,last_name:p.last_name,job_title:p.job_title,seniority_level:p.seniority_level,job_department:p.job_department,linkedin_url:p.linkedin_url,company_name:p.company_name,company_domain:p.company_domain,company_industry:p.company_industry,state:p.state,country:p.country,work_email:p.work_email}));
    const tam=r.total??prospects.length;
    return {patch:{market:{filters:f,tam,prospects}},summary:`${Number(tam).toLocaleString()} reachable contacts in Graph8 · sample: ${prospects.slice(0,3).map(p=>`${p.first_name} ${p.last_name} (${p.job_title}, ${p.company_name})`).join('; ')}`,detail:{filters:f,tam,sample:prospects.slice(0,10).map(p=>`${p.first_name} ${p.last_name} — ${p.job_title} @ ${p.company_name}`)}};
   }},
  model_funnel:{label:'Model the funnel',kind:'rule',about:'Works backwards from the target to contacts, weekly pace and the A/B test sample size.',
   async run(s){
    const g=s.goal,base=RATES[g.metric]||RATES['Qualified replies'],reply=Math.min(0.08,Math.max(0.005,s.audience.reply_rate||base.reply)),meeting=Math.min(0.9,Math.max(0.05,s.audience.meeting_rate||base.meeting||0.3));
    const conv=base.chain.reduce((p,k)=>p*(k==='reply'?reply:k==='meeting'?meeting:base[k]),1);
    const contacts=Math.ceil(g.target/conv),weeks=Math.max(1,Math.ceil(days(g.deadline)/7)),perWeek=Math.ceil(contacts/weeks);
    const perArm=samplePerArm(reply,Math.max(0.01,reply*0.5));
    const funnel={conversion:conv,replyRate:reply,meetingRate:meeting,contactsNeeded:contacts,weeks,contactsPerWeek:perWeek,abSamplePerArm:perArm,feasible:s.market.tam>=contacts};
    return {patch:{funnel},summary:`${contacts.toLocaleString()} contacts needed (${(conv*100).toFixed(2)}% to ${g.metric.toLowerCase()}) · ${perWeek.toLocaleString()}/week over ${weeks} weeks · A/B needs ${perArm?.toLocaleString()??'n/a'} per arm`,detail:funnel};
   }},
  feasibility:{label:'Enough audience?',kind:'condition',about:'Conditional edge: if the reachable market is smaller than the funnel requires, broaden the audience and re-size (max 2 loops).',
   async run(s){return {summary:`TAM ${Number(s.market.tam).toLocaleString()} vs ${s.funnel.contactsNeeded.toLocaleString()} needed · widen passes ${s.widen||0}/2`};}},
  widen:{label:'Broaden audience',kind:'rule',about:'Feedback loop: relaxes industry, then seniority (never geography), then re-runs goal understanding.',
   async run(s){return {patch:{widen:(s.widen||0)+1},summary:`Widening pass ${(s.widen||0)+1}: ${!s.widen?'dropping the industry filter and broadening titles':'dropping the seniority filter'} (geography kept)`};}},
  plan:{label:'Draft the plan',kind:'llm',about:'Graph8 LLM writes the sequence, the A/B hypothesis and the buyer-room plan using the funnel numbers.',
   async run(s,ctx){
    const {data,engine}=await ctx.tryThink('Create an executable outbound plan for this goal. Return {"sequence":[{"day":number,"subject":string,"body":string (<=120 words, uses {{first_name}} and {{company_name}})}] (3 steps),"experiment":{"hypothesis":string ("We believe ... because ... we will know when ..."),"variant_a":string (subject line for step 1),"variant_b":string (alternative subject line)},"room_milestones":[{"title":string,"owner":"buyer"|"seller","day":number}] (4-6),"weekly_checkpoints":string[],"risks":string[]}.',{goal:s.goal,audience:s.audience,funnel:s.funnel,audit:s.audit},
     ()=>({sequence:[{day:0,subject:`Quick question about ${s.goal.metric.toLowerCase()}`,body:`Hi {{first_name}},\n\n${s.audience.messaging_angle}\n\nWorth a 15-minute conversation next week?`},{day:3,subject:'Re: quick question',body:'Hi {{first_name}}, following up in case this is relevant for {{company_name}}.'},{day:8,subject:'Closing the loop',body:'Hi {{first_name}}, should I close this out or is there a better person to speak with?'}],experiment:{hypothesis:`We believe an outcome-led subject line increases replies for ${s.goal.audience} because it states the result they care about; we will know when reply rate improves at the pre-registered sample.`,variant_a:`Quick question about ${s.goal.metric.toLowerCase()}`,variant_b:`${s.goal.target} ${s.goal.metric.toLowerCase()} by ${s.goal.deadline}?`},room_milestones:[{title:'Intro call and success criteria',owner:'seller',day:3},{title:'Share evaluation requirements',owner:'buyer',day:7},{title:'Solution walkthrough',owner:'seller',day:14},{title:'Commercial proposal review',owner:'buyer',day:21}],weekly_checkpoints:['Review reply rate vs plan','Rotate subject if A/B is decided'],risks:['No connected mailbox: campaigns stay in draft.']}),{timeoutMs:90000});
    return {patch:{plan:data},summary:`${(data.sequence||[]).length}-step sequence · A/B: "${data.experiment?.variant_a}" vs "${data.experiment?.variant_b}" · ${(data.room_milestones||[]).length} buyer-room milestones`,detail:{engine,...data}};
   }},
  approval:{label:'Approve plan',kind:'human',about:'Human-in-the-loop: you choose how many prospects to import and which Graph8 assets to create.',
   async run(s){return {interrupt:{title:'Approve goal plan',message:`Import up to ${Math.min(50,s.market.prospects.length)} prospects into Graph8, create A/B campaign drafts, a Lab experiment and a buyer-room template.`},summary:'Waiting for approval'};}},
  execute:{label:'Execute on Graph8',kind:'graph8',about:'Creates the prospect list and contacts, two campaign drafts (A/B) with the sequence, the Lab experiment and a buyer-room template, then activates the goal.',
   async run(s,ctx){
    const a=s.approval||{},g=s.goal,take=Math.max(0,Math.min(Number(a.contacts??20),50,s.market.prospects.length)),out={lists:{},campaigns:{},contacts:0,experimentId:null,roomId:null,errors:[]};
    const err=(w,e)=>out.errors.push(`${w}: ${String(e.message||e).slice(0,160)}`);
    const pick=s.market.prospects.slice(0,take),ids={A:[],B:[]};
    for(const v of ['A','B'])try{out.lists[v]=await g8.createList(`Goal · ${g.name} · ${v}`,`Run My Goal "${g.name}" — variant ${v}`,{trace:ctx.trace,key:`goal-${ctx.run.id}-list-${v}`});}catch(e){err(`List ${v}`,e);}
    for(const [i,p] of pick.entries()){const v=i%2?'B':'A';try{const cid=await g8.upsertContact(p,{trace:ctx.trace,listId:out.lists[v],key:`goal-${ctx.run.id}-ct-${p.linkedin_url||p.first_name+p.last_name+p.company_domain}`.slice(0,200)});if(cid){ids[v].push(Number(cid));out.contacts++;}}catch(e){err(`Contact ${p.first_name} ${p.last_name}`,e);}}
    if(a.campaigns!==false)for(const v of ['A','B']){if(!out.lists[v])continue;const seq=s.plan.sequence||[],first=seq[0]||{subject:g.name,body:''};
     try{const cid=await g8.draftCampaign({name:`Goal · ${g.name} · ${v}`,brief:`${s.audience.objective}. Audience: ${g.audience}.`,concept:s.audience.messaging_angle,persona:s.audience.job_titles.slice(0,3).join(', '),listId:out.lists[v],subject:v==='A'?s.plan.experiment?.variant_a||first.subject:s.plan.experiment?.variant_b||first.subject,body:first.body},{trace:ctx.trace,key:`goal-${ctx.run.id}-camp-${v}`});out.campaigns[v]=cid;
      for(const st of seq.slice(1))try{await g8.call('create_campaign_step_campaigns__campaign_id__sequence_steps_post',{path:{campaign_id:String(cid)},body:{name:`Follow-up day ${st.day}`,channel:'email',mode:'email',day:Number(st.day)||0,cta_type:'soft_ask',personalization_level:'high',constraints:{subject:st.subject,body:st.body},stop_on_reply:true}},{trace:ctx.trace});}catch(e){err('Sequence step',e);}}catch(e){err(`Campaign ${v}`,e);}}
    await store.update(ws=>{
     if(a.experiment!==false){const e=createExperiment({name:`${g.name} · subject line test`,hypothesis:s.plan.experiment?.hypothesis||`Subject line B lifts replies for ${g.audience}.`,metric:'Reply rate',variantA:s.plan.experiment?.variant_a||'Variant A',variantB:s.plan.experiment?.variant_b||'Variant B',minimum:30});
      e.participants=[...ids.A.map(c=>({contactId:String(c),variant:'A',converted:null})),...ids.B.map(c=>({contactId:String(c),variant:'B',converted:null}))];
      e.campaignA=out.campaigns.A||'';e.campaignB=out.campaigns.B||'';e.plan={baseline:s.funnel.replyRate,mde:Math.max(0.01,s.funnel.replyRate*0.5),alpha:0.05,power:0.8,requiredPerArm:s.funnel.abSamplePerArm||30,metricSource:'graph8',metric:'reply',probabilityThreshold:0.95,lossThreshold:0.002,guardrail:{metric:'unsubscribe',maxRate:0.01}};e.goalId=g.id;e.source='Run My Goal';ws.experiments.unshift(e);out.experimentId=e.id;}
     if(a.room!==false){const r=createRoom({name:`${g.name} · buyer room template`,company:g.audience.slice(0,480),summary:`A shared space for ${g.audience} evaluating how we help reach ${g.target} ${g.metric.toLowerCase()}.`});const start=Date.now();r.milestones=(s.plan.room_milestones||[]).map(m=>({id:id(),title:String(m.title).slice(0,300),owner:m.owner==='buyer'?'Buyer':'Our team',due:new Date(start+(Number(m.day)||7)*864e5).toISOString().slice(0,10),done:false,buyerEditable:m.owner==='buyer'}));r.template=true;r.goalId=g.id;ws.rooms.unshift(r);out.roomId=r.id;}
     const goal=ws.goals.find(x=>x.id===g.id);if(goal){goal.orchestration={runId:ctx.run.id,lists:out.lists,campaigns:out.campaigns,experimentId:out.experimentId,roomId:out.roomId,funnel:s.funnel,audience:s.audience,tam:s.market.tam,contacts:out.contacts,at:now()};if(goal.status==='draft')goal.status='active';
      goal.receipts.unshift({id:id(),at:now(),action:'Goal Orchestrator executed',detail:`${out.contacts} prospects in Graph8 lists ${Object.values(out.lists).join(', ')}; campaign drafts ${Object.values(out.campaigns).join(', ')||'—'}; experiment and buyer room created.`});}
    });
    return {patch:{execution:out},summary:`${out.contacts} Graph8 contacts in A/B lists · ${Object.keys(out.campaigns).length} campaign drafts · Lab experiment ${out.experimentId?'✓':'—'} · room template ${out.roomId?'✓':'—'}${out.errors.length?` · ${out.errors.length} warnings`:''}`,detail:out};
   }},
 },
 edges:{understand_goal:'audit_gtm',audit_gtm:'size_market',size_market:'model_funnel',model_funnel:'feasibility',
  feasibility:{route:s=>s.funnel.feasible?'feasible':(s.widen||0)<2?'widen':'stretch',branches:{feasible:'plan',widen:'widen',stretch:'plan'}},
  widen:'understand_goal',plan:'approval',approval:{route:s=>s.approval?.decision==='approve'?'approved':'rejected',branches:{approved:'execute',rejected:END}},execute:END}});
}

// Progress monitor: live campaign metrics → goal.achieved and pace.
export async function syncGoalProgress(store,goalId){
 const g=store.read().goals.find(x=>x.id===goalId);if(!g?.orchestration?.campaigns)return null;
 const key=/meeting/i.test(g.metric)?/meeting|booked/i:/opportun/i.test(g.metric)?/opportun|deal/i:/repl(y|ied|ies)/i;
 let total=0,sent=0;const per={};
 for(const [v,cid] of Object.entries(g.orchestration.campaigns)){try{const m=await gx.campaignMetrics(cid);const flat={};(function walk(o,p=''){for(const [k,val] of Object.entries(o||{})){const path=p?p+'.'+k:k;if(typeof val==='number')flat[path]=val;else if(val&&typeof val==='object'&&!Array.isArray(val))walk(val,path);}})(m);
  const hit=Object.keys(flat).find(k=>key.test(k)&&!/rate|pct|percent/i.test(k)),s=Object.keys(flat).find(k=>/sent|delivered/i.test(k)&&!/rate/i.test(k));per[v]={success:hit?flat[hit]:0,sent:s?flat[s]:0,successKey:hit||null};total+=per[v].success;sent+=per[v].sent;}catch(e){per[v]={error:String(e.message).slice(0,120)};}}
 const created=Date.parse(g.orchestration.at||g.createdAt),span=Math.max(1,Date.parse(g.deadline)-created),elapsed=Math.min(1,Math.max(0,(Date.now()-created)/span)),expected=Math.round(g.target*elapsed);
 return store.update(ws=>{const goal=ws.goals.find(x=>x.id===goalId);goal.achieved=Math.max(goal.achieved||0,total);goal.pace={sent,expectedByNow:expected,status:sent===0?'not_started':goal.achieved>=expected?'on_track':'behind',perCampaign:per,at:now()};return goal.pace;});
}
