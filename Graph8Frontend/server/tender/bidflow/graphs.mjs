// The two BidFlow agent graphs.
//  • contractor_match (issuer): tender → ICP → Graph8 prospecting → fit scoring ⟲ broaden →
//    decision makers → invitations → human approval → Graph8 CRM + campaign draft.
//  • bid_pursuit (bidder): discovery → parsing → eligibility → bid/no-bid ⟶ estimation →
//    bid generation ⟲ red team → human approval → execution.
import {defineGraph,END} from './engine.mjs';
import * as g8 from './g8.mjs';
import {INDUSTRIES,ALL_INDUSTRIES,adjacent,country,detectState,keywords,ruleFit,titleRank,clamp,domainOf,idealBands} from './common.mjs';
import {uid,stamp} from '../model.mjs';
import {submissionIssues} from '../marketplace.mjs';

const money=(n,c)=>{try{return new Intl.NumberFormat('en',{style:'currency',currency:c||'USD',maximumFractionDigits:0}).format(n||0);}catch{return `${c} ${n}`;}};
const tenderBrief=t=>({title:t.title,issuer:t.issuer,category:t.category,country:t.country,region:t.region||'',budget:t.budget?money(t.budget,t.currency):'not stated',deadline:t.deadline,description:String(t.description||'').slice(0,9000),documents:String(t.documentsText||'').slice(0,12000),amendments:(t.amendments||[]).map(a=>a.note)});

// ── shared node: tender parsing ───────────────────────────────────────────────
const parseNode={label:'Parse tender',kind:'llm',about:'Graph8 LLM extracts scope, trades, location, value and mandatory requirements from the notice and its documents.',
 async run(s,ctx){
  const t=s.tender,text=`${t.title}\n${t.description}\n${t.documentsText||''}`;
  const {data,engine}=await ctx.tryThink('Extract a structured procurement brief. Return {"summary":string (2 sentences),"trades":string[],"scope_items":string[] (max 8),"location":{"country":string,"state":string,"city":string},"estimated_value":number|null,"currency":string,"certifications":string[],"mandatory_requirements":string[] (max 10, verbatim-ish),"evaluation_criteria":string[],"keywords":string[] (8-15 lowercase scope keywords useful to match supplier profiles),"contract_type":string,"risks":string[]}.',tenderBrief(t),
   ()=>({summary:String(t.description||t.title).slice(0,280),trades:[t.category],scope_items:[],location:{country:t.country,state:detectState(text),city:''},estimated_value:t.budget||null,currency:t.currency,certifications:[...new Set((text.match(/\b(ISO ?\d{4,5}|licen[cs]ed [a-z ]{3,30}|certified [a-z ]{3,30})/gi)||[]).map(x=>x.trim()))].slice(0,6),mandatory_requirements:(text.match(/[^.\n]*(must|shall|mandatory|required)[^.\n]*/gi)||[]).slice(0,10).map(x=>x.trim()),evaluation_criteria:[],keywords:keywords(text,15),contract_type:'unknown',risks:[]}));
  const parsed={...data,location:{country:country(data.location?.country||t.country),state:data.location?.state||detectState(text),city:data.location?.city||''},keywords:(data.keywords||[]).map(k=>String(k).toLowerCase()).slice(0,15)};
  return {patch:{parsed},summary:`${parsed.summary||t.title}`,detail:{engine,trades:parsed.trades,location:parsed.location,mandatory:parsed.mandatory_requirements,keywords:parsed.keywords}};
 }};

// ── Issuer graph: suggest and invite the best-fit contractors ──────────────────
export const contractorMatch=defineGraph({
 id:'contractor_match',name:'Contractor Match',description:'Finds, ranks and invites the contractors best suited to an issued tender, using Graph8 company and contact intelligence.',start:'parse_tender',
 nodes:{
  parse_tender:parseNode,
  build_icp:{label:'Build contractor ICP',kind:'llm',about:'Turns the tender into an ideal-contractor profile and Graph8 search filters.',
   async run(s,ctx){
    const base=INDUSTRIES[s.tender.category]||[];
    const {data,engine}=await ctx.tryThink(`Design the ideal contractor profile (ICP) for bidders on this tender. Choose industries ONLY from this vocabulary: ${JSON.stringify(ALL_INDUSTRIES)}. Return {"industries":string[] (1-4),"states":string[] (US states only if the work is in the US, else []),"countries":string[],"size_bands":string[] (from ["11-50","51-200","201-500","501-1000","1001-5000","5001-10000","10001+"]),"must_have":string[] (capability keywords),"nice_to_have":string[],"persona_titles":string[] (job titles who respond to invitations to bid),"exclude":string[],"rationale":string}.`,{tender:tenderBrief(s.tender),parsed:s.parsed},
     ()=>({industries:base.slice(0,3),states:s.parsed.location.state?[s.parsed.location.state]:[],countries:[s.parsed.location.country].filter(Boolean),size_bands:idealBands(s.tender.budget),must_have:s.parsed.keywords.slice(0,6),nice_to_have:[],persona_titles:['Business Development Director','Estimating Manager','CEO','President'],exclude:[],rationale:'Category, location and budget based profile.'}));
    const icp={...data,industries:(data.industries||[]).filter(Boolean).slice(0,4),countries:(data.countries||[]).map(country).filter(Boolean)};
    if(!icp.industries.length)icp.industries=base.slice(0,3);if(!icp.countries.length&&s.parsed.location.country)icp.countries=[s.parsed.location.country];
    return {patch:{icp,broaden:0},summary:`${icp.industries.join(', ')} · ${[...(icp.states||[]),...icp.countries].join(', ')||'any location'} · ${icp.size_bands?.join('/')||'any size'}`,detail:{engine,...icp}};
   }},
  discover:{label:'Discover in Graph8',kind:'graph8',about:'Searches Graph8\'s open company index, the org CRM and registered BidFlow suppliers.',
   async run(s,ctx){
    const filters=[];if(s.icp.industries.length)filters.push({field:'industry',operator:'contains',value:s.icp.industries});
    if(s.icp.countries.length)filters.push({field:'country',operator:'any_of',value:s.icp.countries});
    if(s.icp.states?.length&&!s.broaden)filters.push({field:'state',operator:'any_of',value:s.icp.states});
    const pages=await Promise.all([1,2].map(page=>g8.findCompanies(filters,{limit:40,page,trace:ctx.trace}).catch(()=>({rows:[],total:0}))));
    const index=pages.flatMap(p=>p.rows).map(c=>({...c,domain:domainOf(c),source:'Graph8 open index'})).filter(c=>/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(c.domain)&&!/^(none|example|na)\./.test(c.domain));
    let crm=[];try{crm=(await g8.crmCompanies({limit:100,trace:ctx.trace})).map(c=>({...c,domain:domainOf(c)}));}catch{}
    const crmDomains=new Set(crm.map(c=>c.domain).filter(Boolean));
    const network=ctx.db.list(ctx.org,'market-profile').filter(p=>(p.categories||[]).includes(s.tender.category)&&p.id!==s.tender.issuerId).map(p=>({name:p.company,domain:p.graph8Company?.domain||`network:${p.id}`,description:p.services,industry:p.graph8Company?.industry||s.tender.category,employee_count:p.graph8Company?.employee_count,state:p.graph8Company?.state,country:p.graph8Company?.country||(p.countries||[])[0],source:'BidFlow network',networkUserId:p.id}));
    const byDomain=new Map();for(const c of [...network,...index])if(!byDomain.has(c.domain))byDomain.set(c.domain,{...c,inCrm:crmDomains.has(c.domain)});
    const seen=new Set((s.candidates||[]).map(c=>c.domain));const merged=[...(s.candidates||[]),...[...byDomain.values()].filter(c=>!seen.has(c.domain))];
    return {patch:{candidates:merged.slice(0,120)},summary:`${index.length} companies from Graph8 index (${pages[0].total?.toLocaleString?.()||'?'} total matches), ${network.length} BidFlow network suppliers, ${[...byDomain.values()].filter(c=>c.inCrm).length} already in your CRM`,detail:{filters,broadened:!!s.broaden,sample:merged.slice(0,8).map(c=>`${c.name} · ${c.city||c.state||c.country||''}`)}};
   }},
  score_fit:{label:'Score contractor fit',kind:'llm',about:'Rules pre-score every candidate, then the Graph8 LLM re-ranks the top 25 against the tender scope.',
   async run(s,ctx){
    const pre=s.candidates.map(c=>{const r=ruleFit(c,s);return {...c,ruleScore:r.score+(c.source==='BidFlow network'?10:0)+(c.inCrm?5:0),ruleReasons:r.reasons};}).sort((a,b)=>b.ruleScore-a.ruleScore);
    const top=pre.slice(0,25);
    const {data,engine}=await ctx.tryThink('Score how well each contractor fits this tender (0-100) using ONLY the supplied company data. Consider trade/scope match from the description, geography, company size vs contract value, and capability evidence. Return {"scores":[{"domain":string,"score":number,"reasons":string[] (2-3 short, specific),"risks":string[] (0-2)}]} covering every company.',{tender:{...tenderBrief(s.tender),description:String(s.tender.description).slice(0,3000)},icp:s.icp,companies:top.map(c=>({domain:c.domain,name:c.name,industry:c.industry,size:c.employee_count,revenue:c.revenue,location:[c.city,c.state,c.country].filter(Boolean).join(', '),description:String(c.description||'').slice(0,600),bidflowNetwork:c.source==='BidFlow network'}))},
     ()=>({scores:top.map(c=>({domain:c.domain,score:c.ruleScore,reasons:c.ruleReasons.slice(0,3),risks:[]}))}),{timeoutMs:90000});
    const llm=new Map((data.scores||[]).map(x=>[String(x.domain).toLowerCase(),x]));
    const matches=top.map(c=>{const l=llm.get(c.domain);const score=l?clamp(engine==='llm'?0.7*l.score+0.3*c.ruleScore:l.score):c.ruleScore;return {domain:c.domain,name:c.name,industry:c.industry,employee_count:c.employee_count,revenue:c.revenue,city:c.city,state:c.state,country:c.country,linkedin_url:c.linkedin_url,website:c.website,logo_url:c.logo_url,description:String(c.description||'').slice(0,500),source:c.source,inCrm:c.inCrm,networkUserId:c.networkUserId,score,ruleScore:c.ruleScore,reasons:l?.reasons?.length?l.reasons:c.ruleReasons.slice(0,3),risks:l?.risks||[]};}).sort((a,b)=>b.score-a.score);
    const strong=matches.filter(m=>m.score>=65).length;
    return {patch:{matches:matches.slice(0,20)},summary:`${matches.length} ranked · ${strong} strong fits (≥65) · top: ${matches.slice(0,3).map(m=>`${m.name} ${m.score}`).join(', ')}`,detail:{engine,top:matches.slice(0,10).map(m=>({name:m.name,score:m.score,reasons:m.reasons}))}};
   }},
  fit_gate:{label:'Enough strong fits?',kind:'condition',about:'Conditional edge: continue with ≥3 strong fits, otherwise broaden the ICP and search again (max 2 loops).',
   async run(s){const strong=(s.matches||[]).filter(m=>m.score>=65).length;return {summary:`${strong} strong fits · broaden attempts ${s.broaden||0}/2`};}},
  broaden_icp:{label:'Broaden ICP',kind:'rule',about:'Feedback loop: relaxes geography and adds adjacent industries before re-searching Graph8.',
   async run(s){const icp={...s.icp,industries:[...new Set([...s.icp.industries,...adjacent(s.tender.category)])].slice(0,6),size_bands:[]};return {patch:{icp,broaden:(s.broaden||0)+1},summary:`Relaxed state filter; added ${adjacent(s.tender.category).join(', ')}`};}},
  find_decision_makers:{label:'Find decision makers',kind:'graph8',about:'Pulls bid, estimating and executive contacts at the top contractors from Graph8\'s 300M+ contact graph.',
   async run(s,ctx){
    const top=s.matches.slice(0,12),domains=top.map(m=>m.domain).filter(d=>!d.startsWith('network:')&&/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)&&!/^(none|example|na)\./.test(d));
    // Seniority is sparse in the index, so search each company by bid-relevant titles and rank in code.
    const titles=['Business Development','Estimat','Preconstruction','Proposal','Bid','Sales','President','CEO','Chief','Owner','Founder','Managing Director','General Manager','Vice President','Director','Operations','Principal'];
    const people=[];
    for(let i=0;i<domains.length;i+=4)await Promise.all(domains.slice(i,i+4).map(async d=>{try{let r=await g8.findContacts([{field:'company_domain',operator:'any_of',value:[d]},{field:'job_title',operator:'contains',value:titles}],{limit:25,trace:ctx.trace});if(!r.rows.length)r=await g8.findContacts([{field:'company_domain',operator:'any_of',value:[d]}],{limit:25,trace:ctx.trace});people.push(...r.rows.filter(p=>String(p.company_domain||'').toLowerCase()===d));}catch{}}));
    const byDomain={};
    for(const p of people){const d=String(p.company_domain||'').toLowerCase(),rank=titleRank(p.job_title);if(rank<0)continue;(byDomain[d]??=[]).push({key:`${d}:${p.linkedin_url||p.first_name+p.last_name}`,first_name:p.first_name,last_name:p.last_name,job_title:p.job_title,seniority_level:p.seniority_level,job_department:p.job_department,linkedin_url:p.linkedin_url,city:p.city,state:p.state,country:p.country,company_domain:d,emailAvailable:!!p.work_email,work_email:p.work_email&&!p.work_email.includes('*')?p.work_email:null,confidence:p.confidence_score,rank});}
    for(const m of top.filter(m=>m.networkUserId)){try{const u=ctx.db.get(ctx.org,'user',m.networkUserId);(byDomain[m.domain]??=[]).push({key:`${m.domain}:user`,first_name:u.name.split(' ')[0],last_name:u.name.split(' ').slice(1).join(' '),job_title:'BidFlow supplier account',work_email:u.email,emailAvailable:true,company_domain:m.domain,network:true,rank:10});}catch{}}
    for(const d of Object.keys(byDomain))byDomain[d]=byDomain[d].sort((a,b)=>b.rank-a.rank||(b.confidence||0)-(a.confidence||0)).slice(0,3);
    const matches=s.matches.map(m=>({...m,contacts:byDomain[m.domain]||[]}));
    const n=Object.values(byDomain).flat().length;
    return {patch:{matches},summary:`${n} decision makers across ${Object.keys(byDomain).length} of ${top.length} companies (emails are enriched only after approval)`,detail:{sample:Object.values(byDomain).flat().slice(0,8).map(p=>`${p.first_name} ${p.last_name} — ${p.job_title}`)}};
   }},
  draft_invitations:{label:'Draft invitations',kind:'llm',about:'Graph8 LLM writes a personalised invitation-to-bid for each shortlisted contractor.',
   async run(s,ctx){
    const top=s.matches.slice(0,12);
    const {data,engine}=await ctx.tryThink('Write a short, professional invitation-to-bid email for each contractor. Reference the specific fit reasons, the tender scope, value and closing date; no hype, no invented facts; include a clear call to action to review the tender and submit a bid on the Graph8 BidFlow portal. Return {"invitations":[{"domain":string,"subject":string,"body":string (<=150 words, plain text, greeting uses {{first_name}})}]}.',{issuer:s.tender.issuer,tender:{title:s.tender.title,summary:s.parsed.summary,value:s.tender.budget?money(s.tender.budget,s.tender.currency):'on request',deadline:s.tender.deadline,location:s.parsed.location},contractors:top.map(m=>({domain:m.domain,name:m.name,reasons:m.reasons}))},
     ()=>({invitations:top.map(m=>({domain:m.domain,subject:`Invitation to bid: ${s.tender.title}`,body:`Hi {{first_name}},\n\n${s.tender.issuer} has opened a tender that matches ${m.name}'s profile (${m.reasons.slice(0,2).join('; ')}).\n\n${s.parsed.summary}\n\nValue: ${s.tender.budget?money(s.tender.budget,s.tender.currency):'on request'} · Closes ${new Date(s.tender.deadline).toUTCString()}\n\nReview the scope and submit your bid on the Graph8 BidFlow portal. Reply to this email with any questions.\n\nRegards,\n${s.tender.issuer}`}))}),{timeoutMs:90000});
    const greet=b=>/\{\{first_name\}\}/.test(b)?b:String(b||'').replace(/^(dear|hi|hello)[^\n,]*,?/i,'Hi {{first_name}},');
    const inv=new Map((data.invitations||[]).map(i=>[String(i.domain).toLowerCase(),{...i,body:greet(i.body)}]));
    const matches=s.matches.map(m=>inv.has(m.domain)?{...m,invitation:{subject:inv.get(m.domain).subject,body:inv.get(m.domain).body}}:m);
    return {patch:{matches},summary:`${inv.size} personalised invitations drafted`,detail:{engine,example:[...inv.values()][0]}};
   }},
  approval:{label:'Issuer approval',kind:'human',about:'Human-in-the-loop: the issuer picks contractors, edits invitations and approves before anything is written to Graph8.',
   async run(s){const n=s.matches.filter(m=>m.invitation).length;return {interrupt:{title:'Review suggested contractors',message:`${n} contractors are ready to invite. Select who to invite, edit any email, then approve to push them into Graph8.`},summary:`Waiting for issuer to review ${n} suggestions`};}},
  execute_graph8:{label:'Execute in Graph8',kind:'graph8',about:'Creates companies, contacts and a tender list in Graph8, attaches each invitation as a note, drafts an email campaign, and invites network suppliers in-app.',
   async run(s,ctx){
    const a=s.approval||{},selected=s.matches.filter(m=>(a.selected||[]).includes(m.domain));
    const t=s.tender,out={listId:null,campaignId:null,companies:[],networkInvites:[],errors:[],mailboxes:0,sent:0};
    const err=(where,e)=>out.errors.push(`${where}: ${String(e.message||e).slice(0,160)}`);
    const external=selected.filter(m=>!m.domain.startsWith('network:'));
    try{out.listId=await g8.createList(`BidFlow · ${t.title}`,`Contractors invited to bid on "${t.title}" (${t.issuer}). Created by BidFlow run ${ctx.run.id}.`,{trace:ctx.trace,key:`bidflow-${ctx.run.id}-list`});}catch(e){err('Create list',e);}
    for(const m of external){
     const row={domain:m.domain,name:m.name,companyId:null,contacts:[]};const inv={...m.invitation,...(a.edits?.[m.domain]||{})};
     try{row.companyId=await g8.upsertCompany(m,{trace:ctx.trace,key:`bidflow-${ctx.run.id}-co-${m.domain}`});}catch(e){err(`Company ${m.name}`,e);}
     const chosen=(m.contacts||[]).filter(p=>!a.contacts||!a.contacts[m.domain]||a.contacts[m.domain].includes(p.key));
     for(const p of chosen){
      try{const id=await g8.upsertContact({...p,company_id:row.companyId},{trace:ctx.trace,listId:out.listId,key:`bidflow-${ctx.run.id}-ct-${p.key}`.slice(0,200)});row.contacts.push({name:`${p.first_name} ${p.last_name}`,title:p.job_title,contactId:id});
       if(id&&inv.subject){try{await g8.note('contact',id,`BidFlow invitation to bid — ${t.title}\n\nSubject: ${inv.subject}\n\n${String(inv.body).replace(/\{\{first_name\}\}/g,p.first_name)}`,{trace:ctx.trace});}catch(e){err('Note',e);}}}
      catch(e){err(`Contact ${p.first_name} ${p.last_name}`,e);}
     }
     if(row.companyId&&inv.subject){try{await g8.note('company',row.companyId,`BidFlow: invited to bid on "${t.title}" (fit ${m.score}/100).\nWhy: ${m.reasons.join('; ')}`,{trace:ctx.trace});}catch(e){err('Company note',e);}}
     out.companies.push(row);
    }
    for(const m of selected.filter(m=>m.networkUserId)){
     const inv={...m.invitation,...(a.edits?.[m.domain]||{})};
     ctx.db.create(ctx.org,'market-invite',{id:uid(),tenderId:t.id,bidderId:m.networkUserId,company:m.name,score:m.score,reasons:m.reasons,subject:inv.subject,body:inv.body,at:stamp(),runId:ctx.run.id},'bidflow');
     ctx.db.create(ctx.org,'agent-event',{id:uid(),userId:m.networkUserId,action:'invitation:received',details:`${t.issuer} invited you to bid on "${t.title}" (BidFlow fit ${m.score}/100).`,at:stamp()},'bidflow');
     out.networkInvites.push(m.name);
    }
    if(out.listId&&external.length){const first=external.find(m=>m.invitation)||external[0];const inv={...first.invitation,...(a.edits?.[first.domain]||{})};
     try{out.campaignId=await g8.draftCampaign({name:`BidFlow invitation · ${t.title}`,brief:`${t.issuer} is inviting pre-qualified contractors to bid on "${t.title}". ${s.parsed.summary}`,concept:`Invitation to bid for ${s.parsed.trades?.join(', ')||t.category} contractors`,persona:(s.icp.persona_titles||[]).slice(0,3).join(', '),listId:out.listId,subject:inv.subject||`Invitation to bid: ${t.title}`,body:inv.body||''},{trace:ctx.trace,key:`bidflow-${ctx.run.id}-campaign`});}catch(e){err('Campaign draft',e);}}
    out.mailboxes=(await g8.mailboxes({trace:ctx.trace})).length;
    out.delivery=out.mailboxes?'Campaign drafted; launch it from Graph8 to send.':'Drafted in Graph8. Connect a mailbox in Graph8 to launch sending.';
    try{ctx.db.update(ctx.org,'market-tender',t.id,'bidflow','bidflow:invited',r=>{r.bidflow={runId:ctx.run.id,invited:selected.length,listId:out.listId,campaignId:out.campaignId,at:stamp()};});}catch{}
    const contacts=out.companies.reduce((n,c)=>n+c.contacts.length,0);
    return {patch:{execution:out},summary:`${out.companies.length} companies + ${contacts} contacts in Graph8 · list ${out.listId??'—'} · campaign draft ${out.campaignId??'—'} · ${out.networkInvites.length} in-app invites${out.errors.length?` · ${out.errors.length} warnings`:''}`,detail:out};
   }},
 },
 edges:{
  parse_tender:'build_icp',build_icp:'discover',discover:'score_fit',score_fit:'fit_gate',
  fit_gate:{route:s=>{const strong=(s.matches||[]).filter(m=>m.score>=65).length;if(strong>=3)return 'enough';if((s.broaden||0)<2)return 'broaden';return (s.matches||[]).length?'proceed':'none';},branches:{enough:'find_decision_makers',broaden:'broaden_icp',proceed:'find_decision_makers',none:END}},
  broaden_icp:'discover',find_decision_makers:'draft_invitations',draft_invitations:'approval',
  approval:{route:s=>s.approval?.decision==='approve'&&(s.approval.selected||[]).length?'approved':'rejected',branches:{approved:'execute_graph8',rejected:END}},
  execute_graph8:END,
 }});

// ── Bidder graph: autonomous bid pursuit ─────────────────────────────────────
export const bidPursuit=defineGraph({
 id:'bid_pursuit',name:'Bid Pursuit',description:'Evaluates an opportunity for a supplier, decides bid/no-bid, estimates, drafts and red-teams the proposal, then executes after approval.',start:'discovery',
 nodes:{
  discovery:{label:'Discovery & intel',kind:'graph8',about:'Loads the opportunity and enriches supplier and buyer context from Graph8.',
   async run(s,ctx){
    let supplier=s.profile.graph8Company||null,buyer=null;
    if(!supplier&&s.profile.company){try{const r=await g8.findCompanies([{field:'name',operator:'contains',value:[s.profile.company]}],{limit:1,trace:ctx.trace});supplier=r.rows[0]||null;}catch{}}
    try{const r=await g8.findCompanies([{field:'name',operator:'contains',value:[String(s.tender.issuer).slice(0,80)]}],{limit:1,trace:ctx.trace});buyer=r.rows[0]||null;}catch{}
    const pick=c=>c&&{name:c.name,domain:domainOf(c),industry:c.industry,employee_count:c.employee_count,revenue:c.revenue,city:c.city,state:c.state,country:c.country,description:String(c.description||'').slice(0,800)};
    return {patch:{supplier:pick(supplier),buyer:pick(buyer)},summary:`${s.tender.external?`External notice from ${s.tender.source?.name}`:'BidFlow marketplace tender'} · supplier ${supplier?`matched in Graph8 (${supplier.name})`:'not found in Graph8'} · buyer ${buyer?`${buyer.name}`:'not in Graph8 index'}`};
   }},
  parse_tender:parseNode,
  eligibility:{label:'Eligibility check',kind:'llm',about:'Maps mandatory requirements against the supplier profile and Graph8 firmographics.',
   async run(s,ctx){
    const {data,engine}=await ctx.tryThink('Assess the supplier against each mandatory requirement using ONLY the supplier evidence. Return {"requirements":[{"requirement":string,"status":"met"|"unmet"|"unknown","evidence":string}],"eligible":"yes"|"no"|"unverified","blockers":string[]}.',{requirements:s.parsed.mandatory_requirements,certifications:s.parsed.certifications,tender_location:s.parsed.location,supplier:{profile:{company:s.profile.company,services:String(s.profile.services).slice(0,4000),categories:s.profile.categories,countries:s.profile.countries},graph8:s.supplier}},
     ()=>{const cat=(s.profile.categories||[]).includes(s.tender.category),reg=!(s.profile.countries||[]).length||(s.profile.countries||[]).some(c=>country(c)===country(s.tender.country));return {requirements:(s.parsed.mandatory_requirements||[]).map(r=>({requirement:r,status:'unknown',evidence:''})),eligible:cat&&reg?'unverified':'no',blockers:[!cat&&'Category outside supplier profile',!reg&&'Location outside supplier markets'].filter(Boolean)};});
    const counts={met:0,unmet:0,unknown:0};for(const r of data.requirements||[])counts[r.status]=(counts[r.status]||0)+1;
    return {patch:{eligibility:data},summary:`Eligibility: ${data.eligible} · ${counts.met} met, ${counts.unmet} unmet, ${counts.unknown} unknown`,detail:{engine,...data}};
   }},
  bid_no_bid:{label:'Bid / no-bid',kind:'llm',about:'Scores strategic fit, capacity, competition, value and timing; routes to estimation or stops.',
   async run(s,ctx){
    const days=Math.round((Date.parse(s.tender.deadline)-Date.now())/864e5);
    const {data,engine}=await ctx.tryThink('Decide whether this supplier should bid. Score factors 0-100: fit, capability, capacity, competition (higher=less competitive), value, timing. Return {"score":number,"decision":"bid"|"no_bid"|"review","factors":{"fit":number,"capability":number,"capacity":number,"competition":number,"value":number,"timing":number},"rationale":string,"win_themes":string[]}. Choose no_bid if eligibility is "no" or the deadline is under 2 days.',{tender:tenderBrief(s.tender),days_to_deadline:days,eligibility:s.eligibility,supplier:{company:s.profile.company,services:String(s.profile.services).slice(0,2000),graph8:s.supplier},buyer:s.buyer},
     ()=>{const fit=(s.profile.categories||[]).includes(s.tender.category)?75:30,timing=days>=10?80:days>=3?55:10,elig=s.eligibility.eligible==='no'?0:s.eligibility.eligible==='yes'?85:60;const score=Math.round(0.4*fit+0.3*elig+0.3*timing);return {score,decision:elig===0||days<2?'no_bid':score>=60?'bid':'review',factors:{fit,capability:elig,capacity:60,competition:50,value:60,timing},rationale:'Rules-based qualification from profile category, eligibility and time to deadline.',win_themes:[]};});
    const decision=data.eligible==='no'?'no_bid':data.decision;
    return {patch:{bidDecision:{...data,decision,score:clamp(data.score)}},summary:`${String(decision).toUpperCase()} · score ${clamp(data.score)}/100 · ${data.rationale||''}`.slice(0,300),detail:{engine,...data}};
   }},
  record_no_bid:{label:'Record no-bid',kind:'rule',about:'Logs the no-bid decision and reasons for learning; no outreach or submission happens.',
   async run(s,ctx){ctx.db.create(ctx.org,'agent-event',{id:uid(),userId:s.userId,action:'bidflow:no-bid',details:`No-bid on "${s.tender.title}": ${s.bidDecision.rationale}`,at:stamp()},'bidflow');return {summary:'No-bid recorded with rationale'};}},
  estimation:{label:'Estimation',kind:'llm',about:'Builds a cost breakdown, price and delivery schedule within the budget envelope.',
   async run(s,ctx){
    const repricing=!!s.redTeam?.issues?.some(i=>i.kind==='price');
    const {data,engine}=await ctx.tryThink(`${repricing?'RE-PRICE this bid: the red team rejected the previous price for exceeding the budget. The new price MUST be at or below the budget; cut scope-neutral costs, contingency or margin and explain in assumptions. ':''}Produce a commercial estimate for this bid. Use the stated budget as a ceiling when present. Return`+'  {"currency":string,"lines":[{"item":string,"cost":number}],"subtotal":number,"contingency_pct":number,"margin_pct":number,"price":number,"delivery_days":number,"assumptions":string[]}.',{tender:tenderBrief(s.tender),parsed:{scope:s.parsed.scope_items,value:s.parsed.estimated_value},supplier:{services:String(s.profile.services).slice(0,1500),size:s.supplier?.employee_count},previous:repricing?s.estimate:undefined},
     ()=>{const ceiling=s.tender.budget||s.parsed.estimated_value||100000,price=Math.round(ceiling*0.92);return {currency:s.tender.currency,lines:[{item:'Delivery team & labour',cost:Math.round(price*0.55)},{item:'Materials, tools & licences',cost:Math.round(price*0.2)},{item:'Project management & QA',cost:Math.round(price*0.08)}],subtotal:Math.round(price*0.83),contingency_pct:5,margin_pct:12,price,delivery_days:90,assumptions:['Budget-anchored estimate; replace with supplier rates.']};});
    let price=Math.round(Number(data.price)||0);const days=Math.max(1,Math.round(Number(data.delivery_days)||90));
    if(repricing&&s.tender.budget&&price>s.tender.budget)price=Math.floor(s.tender.budget*0.985);
    return {patch:{estimate:{...data,currency:s.tender.currency,price,delivery_days:days,round:(s.estimate?.round||0)+1}},summary:`${repricing?'Re-priced after red team · ':''}${money(price,s.tender.currency)} · ${days} days · margin ${data.margin_pct??'?'}%${s.tender.budget&&price>s.tender.budget?' · ABOVE BUDGET':''}`,detail:{engine,...data}};
   }},
  bid_generation:{label:'Bid generation',kind:'llm',about:'Drafts the proposal from evidence; on a red-team loop it revises against the critique.',
   async run(s,ctx){
    const critique=s.redTeam&&!s.redTeam.pass?s.redTeam.issues:null;
    const {data,engine}=await ctx.tryThink(`Write a complete, compliant bid proposal in markdown for the supplier. Sections: Executive summary, Understanding of requirements, Technical approach & methodology, Compliance matrix (one line per mandatory requirement with how it is met), Delivery plan & timeline, Team & relevant experience, Commercial summary, Risk management. Use ONLY supplier evidence; where evidence is missing, state an explicit commitment rather than inventing credentials. Never output placeholders like TODO, TBD or [NEEDS ...].${critique?' This is a REVISION: fix every red-team issue listed in critique.':''} Return {"proposal":string,"evidence_summary":string}.`,{tender:tenderBrief(s.tender),requirements:s.eligibility.requirements,win_themes:s.bidDecision.win_themes,estimate:s.estimate,supplier:{company:s.profile.company,services:String(s.profile.services).slice(0,4000),graph8:s.supplier},previous_draft:critique?String(s.draft?.proposal||'').slice(0,12000):undefined,critique},
     ()=>({proposal:[`# Proposal: ${s.tender.title}`,`**Bidder:** ${s.profile.company}`,`## Executive summary\n${s.profile.company} proposes to deliver ${s.tender.title} for ${s.tender.issuer}. ${s.parsed.summary}`,`## Understanding of requirements\n${(s.parsed.scope_items||[]).map(x=>`- ${x}`).join('\n')||s.parsed.summary}`,`## Compliance matrix\n${(s.eligibility.requirements||[]).map(r=>`- ${r.requirement}: ${r.status==='met'?r.evidence:'We commit to meet this requirement and will provide evidence on request.'}`).join('\n')||'- All published requirements will be met.'}`,`## Relevant capabilities\n${s.profile.services}`,`## Delivery plan\nDelivery within ${s.estimate.delivery_days} days from award.`,`## Commercial summary\nFixed price: ${money(s.estimate.price,s.tender.currency)}`].join('\n\n'),evidence_summary:String(s.profile.services).slice(0,600)}),{timeoutMs:120000});
    return {patch:{draft:{proposal:String(data.proposal||''),evidence:String(data.evidence_summary||s.profile.services||'').slice(0,4000),revision:(s.draft?.revision||0)+1}},summary:`Draft v${(s.draft?.revision||0)+1} · ${String(data.proposal||'').length.toLocaleString()} characters${critique?` · revised for ${critique.length} red-team issues`:''}`,detail:{engine}};
   }},
  red_team:{label:'Red-team review',kind:'llm',about:'An adversarial reviewer checks compliance coverage, unsupported claims, price and placeholders; failures loop back to bid generation.',
   async run(s,ctx){
    const local=submissionIssues({proposal:s.draft.proposal,amount:s.estimate.price,deliveryDays:s.estimate.delivery_days,evidence:s.draft.evidence}).map(m=>({severity:'blocker',message:m}));
    if(s.tender.budget&&s.estimate.price>s.tender.budget)local.push({severity:'major',kind:'price',message:`Price ${money(s.estimate.price,s.tender.currency)} exceeds budget ${money(s.tender.budget,s.tender.currency)}.`});
    const {data,engine}=await ctx.tryThink('Act as a strict red-team evaluator for this bid. Check: every mandatory requirement is addressed; no claims unsupported by supplier evidence; price/timeline consistent with the tender; clear win themes; no placeholders. Return {"score":number (0-100),"issues":[{"severity":"blocker"|"major"|"minor","message":string}],"strengths":string[]}.',{tender:tenderBrief(s.tender),requirements:s.parsed.mandatory_requirements,supplier_evidence:String(s.profile.services).slice(0,3000),estimate:s.estimate,proposal:String(s.draft.proposal).slice(0,14000)},
     ()=>({score:local.length?50:80,issues:[],strengths:[]}),{timeoutMs:90000});
    const issues=[...local,...(data.issues||[])].slice(0,15),pass=!issues.some(i=>['blocker','major'].includes(i.severity))&&clamp(data.score)>=70;
    return {patch:{redTeam:{pass,score:clamp(data.score),issues,strengths:data.strengths||[],round:(s.redTeam?.round||0)+1}},summary:`${pass?'PASS':'FAIL'} · ${clamp(data.score)}/100 · ${issues.filter(i=>i.severity!=='minor').length} blocking/major issues`,detail:{engine,issues,strengths:data.strengths}};
   }},
  approval:{label:'Bid approval',kind:'human',about:'Human-in-the-loop: the bidder reviews, edits and approves (optionally submits) before execution.',
   async run(s){return {interrupt:{title:'Approve bid',message:s.redTeam.pass?'Red team passed. Review the proposal and approve to save it as your bid (optionally submit).':`Red team still flags ${s.redTeam.issues.length} issues after ${s.redTeam.round} rounds. Edit before approving.`},summary:'Waiting for bidder approval'};}},
  execution:{label:'Execute bid',kind:'rule',about:'Writes the approved proposal into the bid, submits when requested (marketplace tenders), and logs the pursuit.',
   async run(s,ctx){
    const a=s.approval||{},t=ctx.db.get(ctx.org,'market-tender',s.tender.id),edit={proposal:a.proposal??s.draft.proposal,amount:Number(a.amount??s.estimate.price),deliveryDays:Number(a.deliveryDays??s.estimate.delivery_days),evidence:a.evidence??s.draft.evidence};
    let bid=ctx.db.list(ctx.org,'market-bid').find(b=>b.tenderId===t.id&&b.bidderId===s.userId);
    if(bid&&bid.status!=='draft')return {summary:`Bid already ${bid.status}; proposal kept in this run for reference.`,patch:{execution:{bidId:bid.id,status:bid.status}}};
    if(!bid)bid=ctx.db.create(ctx.org,'market-bid',{id:uid(),tenderId:t.id,bidderId:s.userId,company:s.profile.company,status:'draft',proposal:edit.proposal,amount:edit.amount,currency:t.currency,deliveryDays:edit.deliveryDays,evidence:edit.evidence,documents:[],createdAt:stamp(),tenderRevision:t.revision,history:[],messages:[],bidflowRunId:ctx.run.id},s.userId);
    else bid=ctx.db.update(ctx.org,'market-bid',bid.id,s.userId,'bid:bidflow-draft',r=>{Object.assign(r,edit,{tenderRevision:t.revision,bidflowRunId:ctx.run.id});});
    let status='draft',note=t.external?`External tender: submit via the official portal (${t.sourceUrl}).`:'Saved as draft.';
    if(a.submit&&!t.external){const issues=submissionIssues(bid);if(issues.length)note=`Not submitted: ${issues.join(' ')}`;else if(Date.parse(t.deadline)<=Date.now())note='Not submitted: tender closed.';else{bid=ctx.db.update(ctx.org,'market-bid',bid.id,s.userId,'bid:submitted',r=>{r.status='submitted';r.submittedAt=stamp();r.receipt=uid();r.history.push({event:'Submitted via BidFlow',at:stamp(),tenderRevision:t.revision});});status='submitted';note=`Submitted. Receipt ${bid.receipt}.`;}}
    ctx.db.create(ctx.org,'agent-event',{id:uid(),userId:s.userId,action:`bidflow:${status}`,details:`BidFlow ${status==='submitted'?'submitted':'prepared'} a bid for "${t.title}" (${money(edit.amount,t.currency)}).`,at:stamp()},'bidflow');
    return {patch:{execution:{bidId:bid.id,status,note}},summary:note};
   }},
 },
 edges:{
  discovery:'parse_tender',parse_tender:'eligibility',eligibility:'bid_no_bid',
  bid_no_bid:{route:s=>s.bidDecision.decision==='no_bid'?'no_bid':'bid',branches:{bid:'estimation',no_bid:'record_no_bid'}},
  record_no_bid:END,estimation:'bid_generation',bid_generation:'red_team',
  red_team:{route:s=>s.redTeam.pass?'pass':s.redTeam.round>=3?'escalate':s.redTeam.issues.some(i=>i.kind==='price')?'reprice':'revise',branches:{pass:'approval',reprice:'estimation',revise:'bid_generation',escalate:'approval'}},
  approval:{route:s=>s.approval?.decision==='approve'?'approved':'rejected',branches:{approved:'execution',rejected:END}},
  execution:END,
 }});

export const GRAPHS={contractor_match:contractorMatch,bid_pursuit:bidPursuit};
