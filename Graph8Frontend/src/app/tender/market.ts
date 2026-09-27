import {Component,Input,Output,EventEmitter,signal,computed,OnInit,OnDestroy} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {BidFlow} from './bidflow';

type Tab='overview'|'discover'|'bids'|'tenders'|'messages'|'contacts'|'agent';
const EVENT_LABELS:Record<string,string>={draft_created:'Draft created',submitted:'Submitted to buyer',resubmitted:'Resubmitted to buyer',opened:'Opened by buyer',viewed:'Viewed again by buyer',document_opened:'Buyer opened an attachment',under_review:'Evaluation completed',shortlisted:'Shortlisted',withdrawn:'Withdrawn for revision',tender_updated:'Tender changed — review and re-confirm',awarded:'Awarded',not_awarded:'Not awarded',cancelled:'Tender cancelled'};

// Unified marketplace: every organisation can publish tenders and bid on others'.
@Component({selector:'app-tender-market',standalone:true,imports:[CommonModule,FormsModule,BidFlow],templateUrl:'./market.html',styleUrl:'./market.scss'})
export class TenderMarket implements OnInit,OnDestroy{
 @Input() user:any;@Output() signout=new EventEmitter<void>();@Output() internal=new EventEmitter<void>();
 readonly timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 readonly docCategories=['Specification','Terms and conditions','Bill of quantities','Drawings','Forms','Other'];
 readonly stages=[{key:'draft',label:'Draft'},{key:'submitted',label:'Submitted'},{key:'opened',label:'Opened'},{key:'under_review',label:'Under review'},{key:'decision',label:'Decision'}];
 clock=signal(Date.now());private serverEpoch=Date.now();private syncTick=performance.now();private timers:any[]=[];
 summary=signal<any>(null);tenders=signal<any[]>([]);bids=signal<any[]>([]);received=signal<any[]>([]);recommendation=signal<any>(null);
 selected=signal<any>(null);bid=signal<any>(null);tracking=signal<any>(null);register=signal<any>(null);clarifications=signal<any[]>([]);
 notifications=signal<any>({unread:0,items:[]});conversations=signal<any[]>([]);conversation=signal<any>(null);contacts=signal<any>({network:[],graph8:[]});account=signal<any>(null);
 busy=signal(false);error=signal('');notice=signal('');
 tab:Tab='overview';tenderTab='overview';bidTab='proposal';showBell=false;dialog='';
 search='';category='';country='';matched=false;history=false;focusId='';
 form:any={};profile:any={};companyId='';edit:any={};technical=0;commercial=0;evaluation='';awardReason='';awardCandidate=signal<any>(null);
 question='';answers:Record<string,string>={};noticeForm={title:'',body:''};docForm={category:'Specification',description:''};amendment='';
 compose:any={channel:'message',body:'',subject:'',outcome:'connected',minutes:5};editingId='';
 unreadMessages=computed(()=>this.conversations().reduce((n,c)=>n+(c.unread||0),0));

 ngOnInit(){this.tab=this.user.role==='issuer'?'tenders':'overview';void this.load();
  this.timers.push(setInterval(()=>this.clock.set(this.serverEpoch+performance.now()-this.syncTick),1000));
  this.timers.push(setInterval(()=>{if(!this.busy()&&!this.dialog)void this.poll();},20000));}
 ngOnDestroy(){this.timers.forEach(clearInterval);}

 // ── API ─────────────────────────────────────────────────────────────────────
 headers(){return {'Content-Type':'application/json','X-Tender-Session':sessionStorage.getItem('tender-session')||'',...(sessionStorage.getItem('g8-access')?{Authorization:`Bearer ${sessionStorage.getItem('g8-access')}`}:{})};}
 async api(path:string,method='GET',body?:any){const r=await fetch('/api/tender/market/'+path,{method,headers:this.headers(),body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error+(d.requestId?' · Reference '+d.requestId:''));return d;}
 async run(fn:()=>Promise<any>,notice=''){if(this.busy())return;this.busy.set(true);this.error.set('');try{await fn();await this.load(false);if(notice)this.notice.set(notice);}catch(e:any){this.error.set(e.message);}finally{this.busy.set(false);}}
 async load(show=true){if(show)this.busy.set(true);try{const [s,t,b]=await Promise.all([this.api('summary'),this.api('tenders'),this.api('bids')]);this.summary.set(s);if(Number.isFinite(Date.parse(s.serverTime))){this.serverEpoch=Date.parse(s.serverTime);this.syncTick=performance.now();}this.tenders.set(t);this.bids.set(b);
  const sel=this.selected();if(sel){const fresh=t.find((x:any)=>x.id===sel.id);if(fresh){this.selected.set(fresh);await this.loadTenderPanels(fresh);}}
  const bd=this.bid();if(bd){const fresh=b.find((x:any)=>x.id===bd.id)||this.received().find(x=>x.id===bd.id);if(fresh)this.bid.set(fresh);}
  await this.poll();}catch(e:any){this.error.set(e.message);}finally{if(show)this.busy.set(false);}}
 async poll(){try{const [n,c]=await Promise.all([this.api('notifications'),this.api('conversations')]);this.notifications.set(n);this.conversations.set(c);const open=this.conversation();if(open){const fresh=c.find((x:any)=>x.id===open.id);if(fresh&&fresh.messages.length!==open.messages.length)this.conversation.set(fresh);}}catch{}}

 // ── Helpers ─────────────────────────────────────────────────────────────────
 own(t:any){return t?.issuerId===this.user.id;}
 closed(t:any){return !t||Date.parse(t.deadline)<=this.clock()||t.status!=='published';}
 tender(id:string){return this.tenders().find(t=>t.id===id);}
 money(n:number,c:string){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c||'USD',maximumFractionDigits:0}).format(n||0);}catch{return `${c} ${n}`;}}
 date(d:string){return d?new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(d)):'';}
 day(d:string){return d?new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric'}).format(new Date(d)):'';}
 ago(d:string){if(!d)return '';const s=Math.round((this.clock()-Date.parse(d))/1000);return s<60?'just now':s<3600?Math.round(s/60)+' min ago':s<86400?Math.round(s/3600)+' h ago':Math.round(s/86400)+' d ago';}
 remaining(t:any){const s=Math.max(0,Math.floor((Date.parse(t.deadline)-this.clock())/1000));if(!s)return 'Closed';const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?`${d}d ${h}h left`:h?`${h}h ${m}m left`:`${m}m ${s%60}s left`;}
 size(n:number){return !n?'':n>1e6?(n/1e6).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';}
 eventLabel(t:string){return EVENT_LABELS[t]||t.replace(/_/g,' ');}
 stageIndex(key:string){return this.stages.findIndex(s=>s.key===key);}
 bidFor(t:any){return this.bids().find(b=>b.tenderId===t.id);}
 statusTone(s:string){return ({draft:'muted',published:'ok',submitted:'info',shortlisted:'info',awarded:'ok',rejected:'bad',cancelled:'bad'} as any)[s]||'muted';}

 // ── Lists ───────────────────────────────────────────────────────────────────
 opportunities(){return this.tenders().filter(t=>!this.own(t)&&(this.history?this.closed(t):!this.closed(t))&&(!this.category||t.category===this.category)&&(!this.country||`${t.country} ${t.region||''}`.toLowerCase().includes(this.country.toLowerCase()))&&(!this.matched||t.match?.eligibleForMatch||t.engaged)&&`${t.title} ${t.description} ${t.issuer}`.toLowerCase().includes(this.search.toLowerCase())).sort((a,b)=>(b.invited?1:0)-(a.invited?1:0)||(this.history?Date.parse(b.deadline)-Date.parse(a.deadline):(b.match?.score||0)-(a.match?.score||0)));}
 myTenders(){return this.tenders().filter(t=>this.own(t));}
 attention(){const items:any[]=[];for(const n of this.notifications().items.filter((n:any)=>!n.read).slice(0,5))items.push({kind:'notice',text:n.title,sub:n.body,at:n.at,n});
  for(const b of this.bids().filter(b=>b.status==='draft')){const t=this.tender(b.tenderId);if(t&&!this.closed(t)&&Date.parse(t.deadline)-this.clock()<3*864e5)items.push({kind:'deadline',text:`Draft bid closes soon: ${t.title}`,sub:this.remaining(t),bid:b});}
  return items.slice(0,8);}

 // ── Tender detail ───────────────────────────────────────────────────────────
 async openTender(t:any,tab='overview'){this.selected.set(t);this.bid.set(null);this.tenderTab=tab;this.recommendation.set(null);this.received.set([]);this.awardCandidate.set(null);this.awardReason='';if(!this.own(t))this.api(`tenders/${t.id}/viewed`,'POST',{}).catch(()=>{});await this.loadTenderPanels(t);}
 async loadTenderPanels(t:any){try{const [reg,cl]=await Promise.all([this.api(`tenders/${t.id}/register`),this.api(`tenders/${t.id}/clarifications`)]);this.register.set(reg);this.clarifications.set(cl);if(this.own(t)&&t.status!=='draft'){const [r,rec]=await Promise.all([this.api(`tenders/${t.id}/bids`),this.api(`tenders/${t.id}/recommendations`)]);this.received.set(r);this.recommendation.set(rec);}}catch(e:any){this.error.set(e.message);}}
 back(){this.selected.set(null);this.bid.set(null);this.conversation.set(null);}
 async tenderAction(action:string,data:any={},notice=''){const t=this.selected();await this.run(()=>this.api(`tenders/${t.id}/${action}`,'POST',{revision:t.revision,...data}),notice);}
 newTender(){this.editingId='';this.form={currency:'USD',budget:0,category:this.summary()?.categories?.[0]||'Construction',sourceUrl:'',country:''};this.dialog='tender';}
 local(iso:string){if(!iso)return '';const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
 editTender(t:any){this.editingId=t.id;this.form={title:t.title,description:t.description,category:t.category,country:t.country,currency:t.currency,budget:t.budget,deadline:this.local(t.deadline),clarificationDeadline:this.local(t.clarificationDeadline),sourceUrl:t.sourceUrl||'',note:''};this.dialog='tender';}
 async saveTender(){const body={...this.form,deadline:new Date(this.form.deadline).toISOString(),clarificationDeadline:this.form.clarificationDeadline?new Date(this.form.clarificationDeadline).toISOString():null};
  if(this.editingId){const cur=this.tender(this.editingId);await this.run(async()=>{const t=await this.api('tenders/'+this.editingId,'PATCH',{...body,revision:cur.revision});this.dialog='';this.tab='tenders';await this.openTender(t);},cur.status==='published'?'Tender updated. An addendum was published and bidders were notified.':'Draft updated.');return;}
  await this.run(async()=>{const t=await this.api('tenders','POST',body);this.dialog='';this.tab='tenders';await this.openTender(t,'documents');},'Draft created. Attach documents, then publish.');}
 async uploadTenderDoc(ev:Event){const file=(ev.target as HTMLInputElement).files?.[0];if(!file)return;if(file.size>6*1024*1024){this.error.set('Maximum document size is 6 MB.');return;}const base64=await this.b64(file);await this.tenderAction('document',{name:file.name,base64,category:this.docForm.category,description:this.docForm.description},this.selected().status==='published'?'Document published as an addendum. Bidders were notified.':'Document attached.');this.docForm.description='';(ev.target as HTMLInputElement).value='';}
 async removeDocument(d:any){const t=this.selected();if(!confirm(`Remove ${d.name}?`))return;await this.run(()=>this.api(`tenders/${t.id}/document/${d.id}`,'DELETE',{revision:t.revision}),'Document removed.');}
 async publish(){await this.tenderAction('publish',{},'Tender published. Matching suppliers were notified and BidFlow started contractor matching.');}
 async closeBidding(t:any){if(!confirm(`Close bidding on "${t.title}" now? Bidders can no longer submit or revise.`))return;await this.run(()=>this.api(`tenders/${t.id}/close`,'POST',{revision:t.revision,approved:true}),'Bidding closed. Choose the winning bid.');}
 async cancelTender(){const reason=prompt('Reason for cancelling this tender (shared with bidders):');if(!reason)return;await this.tenderAction('cancel',{reason},'Tender cancelled. Bidders were notified.');}
 async confirmAward(){const c=this.awardCandidate();if(!c)return;await this.tenderAction('award',{bidId:c.id,bidRevision:c.revision,reason:this.awardReason,approved:true},'Tender awarded. All bidders were notified and a Closed Won deal is being recorded in Graph8.');this.awardCandidate.set(null);}
 async ask(){const t=this.selected();await this.run(async()=>{await this.api(`tenders/${t.id}/clarifications`,'POST',{question:this.question});this.question='';},'Question sent. The buyer will publish an official answer to all bidders.');}
 async answer(c:any){const t=this.selected();await this.run(async()=>{await this.api(`tenders/${t.id}/clarifications/${c.id}/answer`,'POST',{answer:this.answers[c.id]});},`${c.ref} answered and published to bidders.`);}
 async issueNotice(){const t=this.selected();await this.run(async()=>{await this.api(`tenders/${t.id}/clarifications/notice`,'POST',this.noticeForm);this.noticeForm={title:'',body:''};},'Official clarification issued to all bidders.');}
 async download(path:string,name:string){await this.run(async()=>{const r=await fetch('/api/tender/market/'+path,{headers:this.headers()});if(!r.ok)throw Error((await r.json()).error);const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});}
 b64(file:File){return new Promise<string>((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=rej;r.readAsDataURL(file);});}

 // ── Bids ────────────────────────────────────────────────────────────────────
 async prepare(t:any){await this.run(async()=>{const b=await this.api(`tenders/${t.id}/draft`,'POST',{});this.tab='bids';this.selected.set(null);await this.openBid(b);},'Draft created from your supplier profile. Complete it before submitting.');}
 async openBid(b:any,tab='proposal'){this.bid.set(b);this.bidTab=tab;this.technical=b.evaluation?.technical??0;this.commercial=b.evaluation?.commercial??0;this.evaluation=b.evaluation?.note||'';this.edit={proposal:b.proposal,amount:b.amount,deliveryDays:b.deliveryDays,evidence:b.evidence};this.conversation.set(null);
  try{const t=this.tender(b.tenderId);if(t&&this.own(t)&&b.status!=='draft')this.tracking.set(await this.api(`bids/${b.id}/opened`,'POST',{}));else this.tracking.set(await this.api(`bids/${b.id}/tracking`));}catch{}}
 submissionIssues(){const b=this.edit,i:string[]=[];if(typeof b.proposal!=='string'||b.proposal.trim().length<80)i.push('Proposal needs at least 80 characters.');if(/\[(NEEDS|TODO|VERIFY)|\bTBD\b/i.test(b.proposal||''))i.push('Replace NEEDS / TODO / VERIFY / TBD placeholders.');if(!(Number(b.amount)>0))i.push('Enter an offer amount.');if(!(Number(b.deliveryDays)>0))i.push('Enter a delivery duration.');if(!String(b.evidence||'').trim())i.push('Add supporting evidence.');return i;}
 async saveBid(){const b=this.bid();await this.run(async()=>{const x=await this.api('bids/'+b.id,'PATCH',{...this.edit,amount:Number(this.edit.amount),deliveryDays:Number(this.edit.deliveryDays),revision:b.revision});await this.openBid(x);},'Bid saved.');}
 async submitBid(){const issues=this.submissionIssues();if(issues.length){this.error.set(issues.join(' '));return;}if(!confirm('Submit this bid to the buyer? You can withdraw and revise it until the tender closes.'))return;
  await this.run(async()=>{let cur=this.bid();const t=this.tender(cur.tenderId);if(t&&cur.tenderRevision!==t.revision||['proposal','amount','deliveryDays','evidence'].some(k=>this.edit[k]!==cur[k]))cur=await this.api('bids/'+cur.id,'PATCH',{...this.edit,amount:Number(this.edit.amount),deliveryDays:Number(this.edit.deliveryDays),revision:cur.revision});await this.openBid(await this.api('bids/'+cur.id+'/submit','POST',{revision:cur.revision,approved:true}),'tracking');},'Bid submitted. You can follow its status under Tracking.');}
 async bidAction(action:string,data:any={},notice=''){const b=this.bid();await this.run(async()=>{const x=await this.api(`bids/${b.id}/${action}`,'POST',{revision:b.revision,...data});await this.openBid(x,this.bidTab);},notice);}
 async uploadBidDoc(ev:Event){const file=(ev.target as HTMLInputElement).files?.[0];if(!file)return;if(file.size>6*1024*1024){this.error.set('Maximum attachment size is 6 MB.');return;}const edits={...this.edit};await this.bidAction('document',{name:file.name,base64:await this.b64(file)},'Attachment added.');this.edit=edits;(ev.target as HTMLInputElement).value='';}
 async aiDraft(){const edits={...this.edit};await this.bidAction('ai-draft',{approved:true},'Graph8 AI suggestion ready for review.');this.edit=edits;}
 async awardFromBid(b:any){const t=this.tender(b.tenderId);if(!t)return;await this.run(async()=>{await this.api(`tenders/${t.id}/award`,'POST',{revision:t.revision,bidId:b.id,bidRevision:b.revision,reason:this.awardReason,approved:true});this.awardReason='';this.bid.set(null);this.tab='tenders';await this.openTender(this.tender(t.id)||t,'bids');},'Tender awarded. Bidders were notified.');}
 async matchNow(){await this.run(async()=>{const r=await this.api('agent','POST',{});this.notice.set(`${r.matched} tenders match your profile; ${r.created} new drafts prepared.`);});}

 // ── Messages & contacts ─────────────────────────────────────────────────────
 async openMessages(conv?:any){this.tab='messages';this.selected.set(null);this.bid.set(null);if(conv)await this.openConversation(conv);}
 async openConversation(c:any){this.conversation.set(c);this.compose={channel:'message',body:'',subject:c.subject,outcome:'connected',minutes:5};if(c.unread)try{this.conversation.set(await this.api(`conversations/${c.id}/read`,'POST',{}));await this.poll();}catch{}}
 async startConversation(target:{tenderId?:string,bidId?:string,toUserId?:string}){await this.run(async()=>{const r=await this.api('conversations','POST',target);await this.poll();this.tab='messages';this.selected.set(null);this.bid.set(null);await this.openConversation(r.conversation);});}
 async send(){const c=this.conversation();if(!c||!this.compose.body.trim())return;const channel=this.compose.channel;
  await this.run(async()=>{const r=await this.api(`conversations/${c.id}/messages`,'POST',this.compose);this.conversation.set(r.conversation);
   if(channel==='email'&&r.meta?.delivery==='mail_client'){window.open(`mailto:${encodeURIComponent(r.meta.to)}?subject=${encodeURIComponent(r.meta.subject)}&body=${encodeURIComponent(this.compose.body)}`,'_blank');}
   this.compose={...this.compose,body:''};},channel==='email'?'Email recorded. It opens in your mail app unless a Graph8 mailbox is connected.':channel==='call'?'Call logged and shared with the other party.':channel==='note'?'Private note saved.':'');}
 async loadContacts(){this.tab='contacts';this.selected.set(null);this.bid.set(null);await this.run(async()=>this.contacts.set(await this.api('contacts')));}
 async graph8Note(c:any){const body=prompt(`Note for ${c.name} (saved on the Graph8 contact):`);if(!body)return;await this.run(()=>this.api('graph8-note','POST',{contactId:c.graph8ContactId,channel:'Note',body}),'Note saved to Graph8.');}

 // ── Cold outreach (Graph8 enrichment, verification, sequences) ───────────────
 ob=signal<any>(null);obLists=signal<any[]>([]);obMembers=signal<any[]>([]);obSeqs=signal<any[]>([]);obJobs=signal<any[]>([]);obList='';obPick:Record<number,boolean>={};obStats:Record<string,any>={};
 seqForm:any={name:'',steps:[]};
 async loadOutreach(){try{const [s,l,q,j]=await Promise.all([this.api('outreach/status'),this.api('outreach/lists'),this.api('outreach/sequences'),this.api('outreach/jobs')]);this.ob.set(s);this.obLists.set(l);this.obSeqs.set(q);this.obJobs.set(j);if(!this.obList&&l.length){this.obList=String((l.find((x:any)=>x.total>0)||l[0]).id);await this.loadMembers();}}catch(e:any){this.error.set(e.message);}}
 async loadMembers(){this.obPick={};if(!this.obList){this.obMembers.set([]);return;}await this.run(async()=>this.obMembers.set(await this.api('outreach/lists/'+this.obList+'/members')));}
 obSelected(){return this.obMembers().filter(m=>this.obPick[m.id]);}
 obAll(on:boolean){for(const m of this.obMembers())this.obPick[m.id]=on;}
 async enrich(){const sel=this.obSelected().filter(m=>!m.email||!m.phone);if(!sel.length){this.error.set('Select contacts that are missing an email or phone.');return;}const c=this.ob()?.credits?.available;
  if(!confirm(`Find work emails and phone numbers for ${sel.length} contact(s) with Graph8 enrichment?\n\nThis charges Graph8 credits per contact for each data provider that returns a result. Available: ${c??'unknown'} credits. The exact charge is shown when the job finishes.`))return;
  await this.run(async()=>{const j=await this.api('outreach/enrich','POST',{listId:Number(this.obList),contactIds:sel.map(m=>m.id),approved:true});this.obJobs.set([j,...this.obJobs()]);await this.loadMembers();this.notice.set(`Enrichment finished: ${j.successful} of ${j.total} contacts updated in Graph8${j.creditsUsed!=null?' · '+j.creditsUsed+' credits used':''}.`);});}
 pollJob(id:string){const timer=setInterval(async()=>{try{const j=await this.api('outreach/jobs/'+id);this.obJobs.set(this.obJobs().map(x=>x.id===id?j:x));if(j.finishedAt){clearInterval(timer);await this.loadMembers();await this.loadOutreach();}}catch{clearInterval(timer);}},5000);this.timers.push(timer);}
 async verify(){const sel=this.obSelected().filter(m=>m.email);if(!sel.length){this.error.set('Select contacts that have a work email.');return;}if(!confirm(`Verify ${sel.length} work email(s) with Graph8? Verification uses Graph8 credits (about one per email).`))return;
  await this.run(async()=>{await this.api('outreach/verify','POST',{contactIds:sel.map(m=>m.id),approved:true});await this.loadMembers();},'Emails verified. Invalid addresses are excluded from sequences.');}
 newSequence(){const list=this.obLists().find(l=>String(l.id)===this.obList);const tenderTitle=(list?.title||'').replace(/^BidFlow · /,'');
  const from=this.summary()?.profile?.company||this.user.name;
  this.seqForm={name:`Outreach · ${list?.title||'Suppliers'}`.slice(0,120),steps:[{day:0,subject:`Invitation to bid: ${tenderTitle}`,body:`Hi {{first_name}},\n\nWe have published a tender that matches {{company_name}}'s work: ${tenderTitle}.\n\nThe scope, documents and closing date are on our procurement portal. Would you like us to send you the link?\n\nRegards,\n${from}`},{day:3,subject:'Re: invitation to bid',body:'Hi {{first_name}}, following up in case the tender is relevant to {{company_name}}. Happy to answer questions.'},{day:8,subject:'Closing soon',body:'Hi {{first_name}}, the tender closes soon. Should I send the documents to someone else at {{company_name}}?'}]};this.dialog='sequence';}
 async createSequence(){await this.run(async()=>{const s=await this.api('outreach/sequences','POST',{name:this.seqForm.name,steps:this.seqForm.steps,listId:Number(this.obList)});this.obSeqs.set([s,...this.obSeqs()]);this.dialog='';},'Sequence created in Graph8. No emails are sent until you enroll contacts.');}
 async enroll(s:any){const sel=this.obSelected().filter(m=>m.email&&m.verification!=='invalid');if(!sel.length){this.error.set('Select contacts with a usable work email (enrich and verify first).');return;}
  if(!confirm(`Enroll ${sel.length} contact(s) in "${s.name}"?\n\nGraph8 will send these ${s.steps.length} emails from your connected mailbox to real people. A reply stops the sequence for that person.`))return;
  await this.run(async()=>{const x=await this.api('outreach/sequences/'+s.id+'/enroll','POST',{contactIds:sel.map(m=>m.id),listId:Number(this.obList),approved:true});this.obSeqs.set(this.obSeqs().map(q=>q.id===x.id?x:q));},'Contacts enrolled. Graph8 is sending the sequence.');}
 async seqStats(s:any){try{this.obStats={...this.obStats,[s.id]:await this.api('outreach/sequences/'+s.id+'/stats')};}catch(e:any){this.error.set(e.message);}}
 statLine(v:any){if(!v)return '';if(v.error)return v.error;const f:any={};(function w(o:any,p=''){for(const [k,x] of Object.entries(o||{})){if(typeof x==='number')f[p+k]=x;else if(x&&typeof x==='object'&&!Array.isArray(x))w(x,p+k+'.');}})(v);return Object.entries(f).slice(0,8).map(([k,x])=>k.replace(/_/g,' ')+': '+x).join(' · ')||'No activity yet';}

 // ── Notifications & account ─────────────────────────────────────────────────
 async openNotification(n:any){this.showBell=false;if(!n.read)this.api('notifications/read','POST',{ids:[n.id]}).then(()=>this.poll()).catch(()=>{});const l=n.link||{};
  if(l.conversationId){const c=this.conversations().find(x=>x.id===l.conversationId);if(c)return this.openMessages(c);}
  if(l.bidId){const b=this.bids().find(x=>x.id===l.bidId);if(b){this.tab='bids';this.selected.set(null);return this.openBid(b,'tracking');}const t=this.tender(l.tenderId);if(t){this.tab='tenders';return this.openTender(t,'bids');}}
  if(l.tenderId){const t=this.tender(l.tenderId);if(t){this.tab=this.own(t)?'tenders':'discover';return this.openTender(t,l.tab||'overview');}}}
 async readAll(){await this.api('notifications/read','POST',{}).catch(()=>{});await this.poll();}
 async openAccount(){this.account.set(await this.api('me'));const p=this.summary()?.profile||{};this.profile={...p,categories:(p.categories||[]).join(', '),countries:(p.countries||[]).join(', ')};this.dialog='account';}
 async saveAccount(){const a=this.account();await this.run(async()=>{await this.api('me','PATCH',a);const sv=String(this.profile.services||'').trim(),ct=String(this.profile.categories||'').trim();if(sv||ct){if(!sv||!ct||!String(this.profile.company||'').trim())throw Error('To bid, the supplier profile needs a company name, at least one category and your services.');await this.api('profile','PATCH',this.profile);}this.dialog='';},'Account and supplier profile saved.');}
 async importCompany(){await this.run(async()=>{const p=await this.api('graph8-profile','POST',{companyId:this.companyId});this.profile.company=p.company;this.profile.services=p.services;},'Graph8 company details copied into the form. Save to apply.');}
 openAgent(id=''){this.focusId=id;this.tab='agent';this.selected.set(null);this.bid.set(null);}
 openFromInvite(id:string){const t=this.tender(id);if(t){this.tab='discover';void this.openTender(t);}}
 go(tab:Tab){this.tab=tab;this.selected.set(null);this.bid.set(null);this.conversation.set(null);if(tab==='contacts'){void this.loadContacts();void this.loadOutreach();}}
}
