import {Component,Input,Output,EventEmitter,signal,computed,OnInit,OnDestroy,OnChanges,SimpleChanges} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';

// BidFlow command center: runs the Graph8-powered agent graphs, visualises every node,
// and hosts the human-approval steps for issuers (contractor invitations) and bidders (bids).
@Component({selector:'app-bidflow',standalone:true,imports:[CommonModule,FormsModule],templateUrl:'./bidflow.html',styleUrl:'./bidflow.scss'})
export class BidFlow implements OnInit,OnDestroy,OnChanges{
 @Input() user:any;@Input() tenders:any[]=[];@Input() focus='';@Input() profile:any=null;
 @Output() changed=new EventEmitter<void>();@Output() openTender=new EventEmitter<string>();
 status=signal<any>(null);runs=signal<any[]>([]);run=signal<any>(null);feeds=signal<any[]>([]);invites=signal<any[]>([]);
 busy=signal(false);error=signal('');notice=signal('');view='runs';expanded=new Set<string>();query='';onlyExternal=false;
 // approval working copies
 picks:Record<string,boolean>={};people:Record<string,Record<string,boolean>>={};edits:Record<string,{subject:string,body:string}>={};openInvite='';
 proposal='';amount=0;deliveryDays=0;
 companyQuery='';companyResults=signal<any[]>([]);
 private poll:any;private loadedRun='';

 readonly kinds:Record<string,string>={llm:'AI',graph8:'Graph8',rule:'Rule',human:'Approval',condition:'Decision'};
 issuer(){return ['issuer','contributor','administrator'].includes(this.user?.role);}bidder(){return this.issuer();}
 graph=computed(()=>{const r=this.run();return this.status()?.graphs?.find((g:any)=>g.id===(r?.graphId||(this.issuer()&&!this.bidder()?'contractor_match':'bid_pursuit')));});

 ngOnInit(){void this.refresh();this.poll=setInterval(()=>{const r=this.run();if(r&&['running'].includes(r.status))void this.openRun(r.id,false);else if(this.runs().some(x=>x.status==='running'))void this.loadRuns();},2000);}
 ngOnDestroy(){clearInterval(this.poll);}
 ngOnChanges(c:SimpleChanges){if(c['focus']&&this.focus&&this.status())void this.focusTender(this.focus);}

 headers(){return {'Content-Type':'application/json','X-Tender-Session':sessionStorage.getItem('tender-session')||'',...(sessionStorage.getItem('g8-access')?{Authorization:`Bearer ${sessionStorage.getItem('g8-access')}`}:{})};}
 async api(path:string,method='GET',body?:any){const r=await fetch('/api/tender/bidflow/'+path,{method,headers:this.headers(),body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
 async act(fn:()=>Promise<any>,notice=''){if(this.busy())return;this.busy.set(true);this.error.set('');try{await fn();if(notice)this.notice.set(notice);}catch(e:any){this.error.set(e.message);}finally{this.busy.set(false);}}

 async refresh(){await this.act(async()=>{const [s,f]=await Promise.all([this.api('status'),this.api('feeds')]);this.status.set(s);this.feeds.set(f);if(this.bidder())this.invites.set(await this.api('invites'));await this.loadRuns();if(this.focus)await this.focusTender(this.focus);else if(!this.run()&&this.runs()[0])await this.openRun(this.runs()[0].id);});}
 async loadRuns(){this.runs.set(await this.api('runs'));}
 async focusTender(id:string){const existing=this.runs().find(r=>r.tenderId===id);if(existing)await this.openRun(existing.id);else{this.run.set(null);this.loadedRun='';}}
 async openRun(id:string,reset=true){const r=await this.api('runs/'+id);const fresh=this.loadedRun!==id;this.run.set(r);if(fresh||r.status==='awaiting_approval'&&this.loadedRun!==id+':approval')this.prepareApproval(r);this.loadedRun=r.status==='awaiting_approval'?id+':approval':id;if(!['running'].includes(r.status)){const i=this.runs().findIndex(x=>x.id===id);if(i>=0&&this.runs()[i].status!==r.status){await this.loadRuns();if(r.status==='completed')this.changed.emit();}}}

 prepareApproval(r:any){
  if(r.graphId==='contractor_match'){this.picks={};this.people={};this.edits={};for(const m of r.state.matches||[]){this.picks[m.domain]=m.score>=65&&!!m.invitation;this.people[m.domain]=Object.fromEntries((m.contacts||[]).map((p:any,i:number)=>[p.key,i<2]));if(m.invitation)this.edits[m.domain]={subject:m.invitation.subject,body:m.invitation.body};}}
  else{this.proposal=r.state.draft?.proposal||'';this.amount=r.state.estimate?.price||0;this.deliveryDays=r.state.estimate?.delivery_days||0;}
 }

 // Tender lists for starting runs
 myTenders(){return this.tenders.filter(t=>t.issuerId===this.user.id&&t.status!=='cancelled');}
 opportunities(){const q=this.query.toLowerCase();return this.tenders.filter(t=>t.issuerId!==this.user.id&&t.status==='published'&&Date.parse(t.deadline)>Date.now()&&(!this.onlyExternal||t.external)&&(!q||`${t.title} ${t.description} ${t.country} ${t.category}`.toLowerCase().includes(q))).sort((a,b)=>(b.invited?1:0)-(a.invited?1:0)||(b.match?.score||0)-(a.match?.score||0)).slice(0,40);}
 runFor(t:any){return this.runs().find(r=>r.tenderId===t.id);}
 finished(r:any){return ['completed','failed','cancelled'].includes(r.status);}
 tender(id:string){return this.tenders.find(t=>t.id===id);}
 async startMatch(t:any){await this.act(async()=>{const r=await this.api('match','POST',{tenderId:t.id});await this.loadRuns();await this.openRun(r.id);this.view='runs';},'Contractor Match started — BidFlow is working through the graph.');}
 async startPursuit(t:any){await this.act(async()=>{const r=await this.api('pursue','POST',{tenderId:t.id});await this.loadRuns();await this.openRun(r.id);this.view='runs';},'Bid Pursuit started — BidFlow is evaluating this opportunity.');}

 // Graph canvas helpers
 stepsFor(node:string){return (this.run()?.steps||[]).filter((s:any)=>s.node===node);}
 nodeState(node:string){const r=this.run();if(!r)return 'idle';const steps=this.stepsFor(node);const last=steps.at(-1);if(!last)return r.status==='completed'||r.status==='failed'||r.status==='cancelled'?'skipped':'pending';return last.status;}
 loops(){const g=this.graph();if(!g)return [];const order=g.nodes.map((n:any)=>n.id);return g.edges.filter((e:any)=>order.indexOf(e.to)>=0&&order.indexOf(e.to)<order.indexOf(e.from)).map((e:any)=>({...e,fromLabel:g.nodes.find((n:any)=>n.id===e.from)?.label,toLabel:g.nodes.find((n:any)=>n.id===e.to)?.label,count:(this.run()?.steps||[]).filter((s:any)=>s.node===e.from&&s.to===e.to).length}));}
 branches(node:string){return (this.graph()?.edges||[]).filter((e:any)=>e.from===node&&e.label);}
 taken(node:string){return this.stepsFor(node).map((s:any)=>s.branch).filter(Boolean);}
 toggle(id:string){this.expanded.has(id)?this.expanded.delete(id):this.expanded.add(id);}
 json(v:any){return JSON.stringify(v,null,2);}
 duration(ms:number){return ms==null?'':ms<1000?ms+' ms':(ms/1000).toFixed(1)+' s';}
 totalMs(){return (this.run()?.steps||[]).reduce((n:number,s:any)=>n+(s.ms||0),0);}
 llmCalls(){return (this.run()?.steps||[]).flatMap((s:any)=>s.llm||[]).filter((l:any)=>l.engine==='Graph8 LLM skill');}
 g8Calls(){return (this.run()?.steps||[]).flatMap((s:any)=>s.ops||[]).filter((o:any)=>!o.op.startsWith('execute_skill')&&!o.op.startsWith('get_execution'));}
 tokens(){return this.llmCalls().reduce((n:number,l:any)=>n+(l.tokens||0),0);}
 opName(op:string){return op.replace(/_(post|get|put|patch)$/,'').split('_').slice(0,3).join(' ');}
 ago(iso:string){if(!iso)return '';const s=Math.round((Date.now()-Date.parse(iso))/1000);return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':s<86400?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago';}
 createdContacts(x:any){return (x.companies||[]).reduce((n:number,c:any)=>n+c.contacts.length,0);}
 contactList(c:any){return c.contacts.map((p:any)=>p.name+' #'+p.contactId).join(', ')||'no contacts';}
 place(...parts:any[]){return parts.filter(p=>p!==null&&p!==undefined&&p!=='').join(', ');}
 money(n:number,c:string){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c||'USD',maximumFractionDigits:0}).format(n||0);}catch{return `${c} ${n}`;}}
 date(d:string){return d?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(d)):'';}
 ring(score:number){const c=2*Math.PI*18;return `${(score/100)*c} ${c}`;}
 tone(score:number){return score>=75?'high':score>=60?'mid':'low';}

 // Contractor approval
 matches(){return this.run()?.state?.matches||[];}
 selectedCount(){return Object.values(this.picks).filter(Boolean).length;}
 contactCount(){return this.matches().filter((m:any)=>this.picks[m.domain]).reduce((n:number,m:any)=>n+Object.values(this.people[m.domain]||{}).filter(Boolean).length,0);}
 async approveMatch(decision:'approve'|'reject'){const r=this.run();const selected=Object.keys(this.picks).filter(k=>this.picks[k]);const contacts=Object.fromEntries(selected.map(d=>[d,Object.keys(this.people[d]||{}).filter(k=>this.people[d][k])]));
  await this.act(async()=>{this.run.set(await this.api(`runs/${r.id}/approve`,'POST',{decision,selected,contacts,edits:this.edits}));await this.loadRuns();},decision==='approve'?`Approved ${selected.length} contractors — BidFlow is writing them into Graph8.`:'Suggestions rejected. Nothing was written to Graph8.');}
 // Bid approval
 async approveBid(decision:'approve'|'reject',submit=false){const r=this.run();await this.act(async()=>{this.run.set(await this.api(`runs/${r.id}/approve`,'POST',{decision,submit,proposal:this.proposal,amount:Number(this.amount),deliveryDays:Number(this.deliveryDays)}));await this.loadRuns();},decision==='reject'?'Bid discarded.':submit?'Approved — BidFlow is submitting your bid.':'Approved — BidFlow is saving your bid draft.');}
 async resume(){const r=this.run();await this.act(async()=>{this.run.set(await this.api(`runs/${r.id}/resume`,'POST',{}));},'Run resumed from its last completed node.');}
 async cancel(){const r=this.run();await this.act(async()=>{this.run.set(await this.api(`runs/${r.id}/cancel`,'POST',{}));await this.loadRuns();},'Run cancelled.');}
 factors(){const f=this.run()?.state?.bidDecision?.factors||{};return Object.entries(f).map(([k,v])=>({k,v:Number(v)||0}));}

 // Feeds
 async syncFeed(f:any){await this.act(async()=>{const r=await this.api(`feeds/${f.id}/sync`,'POST',{});this.feeds.set(await this.api('feeds'));this.changed.emit();this.notice.set(`${f.name}: ${r.added} new open tenders ingested (${r.fetched} fetched).`);});}
 async toggleFeed(f:any){await this.act(async()=>{await this.api(`feeds/${f.id}`,'PATCH',{enabled:!f.enabled});this.feeds.set(await this.api('feeds'));});}
 externalCount(){return this.tenders.filter(t=>t.external&&t.status==='published'&&Date.parse(t.deadline)>Date.now()).length;}

 // Supplier identity (bidder) — link the account to a real Graph8 company record
 async searchCompany(){await this.act(async()=>this.companyResults.set(await this.api('graph8/companies?q='+encodeURIComponent(this.companyQuery))));}
 async linkCompany(c:any){await this.act(async()=>{await this.api('profile/graph8','POST',{company:c});this.companyResults.set([]);this.changed.emit();},`Linked to ${c.name} in Graph8. BidFlow will use its firmographics in every pursuit.`);}
 async autopilot(enabled:boolean){await this.act(async()=>{await this.api('profile/autopilot','POST',{enabled});this.changed.emit();},enabled?'Autopilot on: BidFlow will start pursuits for strong new matches and pause at approval.':'Autopilot off.');}
}
