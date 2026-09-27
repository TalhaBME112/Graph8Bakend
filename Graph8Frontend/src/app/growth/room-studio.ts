import {Component,Input,Output,EventEmitter,signal} from '@angular/core';
import {toastSignals} from '../ui';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {growthApi,money,ago} from './api';

// Deal Room Studio: builds rooms from live Graph8 companies/people/deals, keeps them synced with
// the Graph8 deal (stage readiness, stakeholders, line items, quotes, notes) and shows buyer engagement.
@Component({selector:'app-room-studio',standalone:true,imports:[CommonModule,FormsModule],styleUrl:'./studio.scss',template:`
<div class="studio">
 @if(mode==='wizard'){
  <div class="bar"><div><p class="eyebrow">NEW ROOM FROM GRAPH8</p><h3>Real account · real stakeholders · live Graph8 deal</h3></div><button (click)="closed.emit()">Close</button></div>
  <div class="body">
   
   <div class="split"><div>
    <p class="eyebrow">1 · Buyer company (Graph8 open index)</p>
    <div class="row"><input placeholder="Company name or domain, e.g. stellar.net" [(ngModel)]="q" (keydown.enter)="search()"><button class="primary" style="flex:0" (click)="search()" [disabled]="busy()||q.length<2">Search</button></div>
    <div class="list" style="margin-top:8px">@for(c of companies();track $index){<div class="pick" [class.on]="company?.domain===c.domain" (click)="choose(c)"><span><b>{{c.name}}</b><small>{{c.domain}} · {{c.industry}} · {{c.employee_count}} · {{c.city}} {{c.country}}</small></span><span class="pill">Select</span></div>}</div>
    @if(company){<p class="eyebrow" style="margin-top:14px">2 · Stakeholders at {{company.name}} (Graph8 contact graph)</p>
     <div class="list">@for(p of people();track $index){<label class="item" style="flex-direction:row;margin:0;font-weight:400"><input type="checkbox" [(ngModel)]="chosen[$index]"><span><b>{{p.first_name}} {{p.last_name}}</b><small>{{p.job_title}}{{p.state?' · '+p.state:''}}</small></span></label>}@empty{<small>{{busy()?'Loading people…':'No people found for this domain.'}}</small>}</div>}
   </div><div>
    <p class="eyebrow">3 · Deal</p>
    <label>Deal / room name<input [(ngModel)]="dealName" [placeholder]="company?company.name+' · evaluation':'Choose a company'"></label>
    <div class="row"><label>Amount<input type="number" [(ngModel)]="amount"></label><label>Currency<input [(ngModel)]="currency" maxlength="3"></label></div>
    <div class="card"><small>On create, BidFlow will: upsert the company and {{picked().length}} stakeholders in Graph8, open a deal in your default pipeline (Discovery stage), pull the deal’s stage-readiness requirements, and have the Graph8 LLM draft a buyer-facing welcome and mutual action plan. A note is logged on the Graph8 deal.</small></div>
    <div class="acts"><button class="primary" (click)="create()" [disabled]="busy()||!company||!picked().length">{{busy()?'Building room…':'Create deal room in Graph8'}}</button></div>
   </div></div>
  </div>
 }@else if(room){
  <div class="bar"><div><p class="eyebrow">GRAPH8 DEAL SYNC</p><h3>{{room.intel?.deal?.name||'Not linked to a Graph8 deal'}}</h3>@if(room.intel){<small>Synced {{ago(room.intel.syncedAt)}} · {{room.intel.deal.stage}} · {{money(room.intel.deal.amount,room.intel.deal.currency)}}</small>}</div>
   <div class="acts" style="margin:0">@if(room.dealId){<button (click)="act('intel','Deal intelligence refreshed from Graph8')" [disabled]="busy()">↻ Sync</button><button (click)="plan()" [disabled]="busy()">AI mutual plan</button><button (click)="act('push','Mutual plan written to the Graph8 deal as a note')" [disabled]="busy()">Push plan to Graph8</button><button (click)="nextStep()" [disabled]="busy()">Graph8 next best step</button><button class="primary" (click)="advance()" [disabled]="busy()">Advance stage →</button>}</div></div>
  <div class="body">
   
   
   @if(!room.dealId){<p class="muted">Link this room to a Graph8 deal to sync stakeholders, stage readiness, pricing and to log buyer activity on the deal.</p><div class="row"><select [(ngModel)]="dealId"><option value="">Choose a Graph8 deal…</option>@for(d of deals();track d.id){<option [value]="d.id">{{d.name}} · {{d.stage}}</option>}</select><button class="primary" style="flex:0" (click)="link()" [disabled]="busy()||!dealId">Link deal</button><button style="flex:0" (click)="loadDeals()" [disabled]="busy()">Load deals</button></div>}
   @if(room.intel;as i){
    <div class="kpis"><div><span>Stage</span><b>{{i.deal.stage}}</b></div><div><span>Value</span><b>{{money(i.deal.amount,i.deal.currency)}}</b></div><div><span>Stage readiness</span><b>{{i.readiness?.coverage??0}}%</b></div><div><span>Stakeholders</span><b>{{i.stakeholders.length}}</b></div><div><span>Buyer engagement</span><b>{{score()}}</b><small>{{(room.engagement||[]).length}} events{{room.lastBuyerActivityAt?' · last '+ago(room.lastBuyerActivityAt):''}}</small></div></div>
    <div class="grid">
     <div class="card"><h4>To advance to {{i.readiness?.next||'next stage'}}</h4><div class="meter"><span [style.width.%]="i.readiness?.coverage||0"></span></div>@for(m of i.readiness?.missing||[];track m){<div class="item"><span class="pill warn">missing</span>{{m}}</div>}@empty{<small>{{i.readiness?.ready?'Ready to advance.':'No stage requirements returned.'}}</small>}</div>
     <div class="card"><h4>Buying committee</h4>@for(s of i.stakeholders;track $index){<div class="item"><span><b>{{s.name}}</b><small>{{s.title}}{{s.role?' · '+s.role:''}}{{s.primary?' · primary':''}}</small></span></div>}@empty{<small>No contacts on the deal.</small>}</div>
     <div class="card"><h4>Commercials</h4>@for(l of i.lineItems;track $index){<div class="item">{{l.name}} × {{l.quantity}} — {{money(l.amount,l.currency||i.deal.currency)}}</div>}@for(q of i.quotes;track q.id){<div class="item"><span><b>Quote {{q.number||q.title}}</b><small>{{q.status}} · {{money(q.total,q.currency)}}{{q.viewedAt?' · viewed':''}}{{q.signedAt?' · signed':''}}</small></span></div>}@if(!i.lineItems.length&&!i.quotes.length){<small>No line items or quotes on the Graph8 deal yet.</small>}</div>
    </div>
    @if(room.nextStep){<div class="card" style="margin-top:12px"><h4>Graph8 next best step · {{ago(room.nextStep.at)}}</h4><pre>{{fmt(room.nextStep.value)}}</pre></div>}
   }
   @if(proposal();as pl){<div class="card" style="margin-top:12px"><h4>Proposed mutual action plan · {{pl._engine}}</h4><label>Welcome summary (buyer-facing)<textarea rows="3" [(ngModel)]="pl.summary"></textarea></label>
    @for(m of pl.milestones;track $index){<div class="item"><input type="checkbox" [(ngModel)]="m.keep"><span><b>{{m.title}}</b><small>{{m.owner==='buyer'?'Buyer':'Our team'}} · due in {{m.due_in_days}} days · {{m.why}}</small></span></div>}
    <div class="acts"><button class="primary" (click)="apply()" [disabled]="busy()">Apply to room</button><button (click)="proposal.set(null)">Discard</button></div></div>}
   <div class="card timeline" style="margin-top:12px"><h4>Buyer activity {{room.dealId?'(mirrored to the Graph8 deal as notes)':''}}</h4><div class="list">@for(e of (room.engagement||[]).slice(0,12);track e.id){<div class="item"><i class="dot" [class]="'dot '+e.type"></i><span><b>{{e.who}}</b> {{e.detail}}<small>{{ago(e.at)}}</small></span></div>}@empty{<small>Share the room link: views, document opens, questions and milestone updates appear here.</small>}</div></div>
  </div>
 }
</div>`})
export class RoomStudio{
 @Input() mode:'wizard'|'detail'='detail';@Input() room:any;
 @Output() changed=new EventEmitter<void>();@Output() created=new EventEmitter<string>();@Output() closed=new EventEmitter<void>();
 busy=signal(false);error=signal('');notice=signal('');companies=signal<any[]>([]);people=signal<any[]>([]);deals=signal<any[]>([]);proposal=signal<any>(null);
 q='';company:any=null;chosen:Record<number,boolean>={};dealName='';amount=50000;currency='USD';dealId='';
 money=money;ago=ago;
 picked(){return this.people().filter((_,i)=>this.chosen[i]);}
 async run(fn:()=>Promise<any>,ok=''){if(this.busy())return;this.busy.set(true);this.error.set('');try{await fn();if(ok)this.notice.set(ok);}catch(e:any){this.error.set(e.message);}finally{this.busy.set(false);}}
 async search(){await this.run(async()=>this.companies.set(await growthApi('graph8/companies?q='+encodeURIComponent(this.q))));}
 async choose(c:any){this.company=c;this.dealName=`${c.name} · evaluation`;this.people.set([]);this.chosen={};await this.run(async()=>{const p=await growthApi<any[]>('graph8/people?domain='+encodeURIComponent(c.domain));this.people.set(p);p.slice(0,3).forEach((_,i)=>this.chosen[i]=true);});}
 async create(){await this.run(async()=>{const r=await growthApi('rooms/from-graph8','POST',{company:this.company,people:this.picked(),dealName:this.dealName,amount:Number(this.amount),currency:this.currency.toUpperCase()});this.created.emit(r.id);});}
 async act(action:string,ok:string){await this.run(async()=>{await growthApi(`rooms/${this.room.id}/${action}`,'POST',{});this.changed.emit();},ok);}
 async plan(){await this.run(async()=>{const p=await growthApi(`rooms/${this.room.id}/ai-plan`,'POST',{});p.milestones=(p.milestones||[]).map((m:any)=>({...m,keep:true}));this.proposal.set(p);});}
 async apply(){const p=this.proposal();await this.run(async()=>{await growthApi(`rooms/${this.room.id}/apply-plan`,'POST',{summary:p.summary,milestones:p.milestones.filter((m:any)=>m.keep),faq:p.faq});this.proposal.set(null);this.changed.emit();},'Mutual action plan applied. Share the room so the buyer can work through it.');}
 async advance(){if(!confirm('Move this Graph8 deal to its next pipeline stage?'))return;await this.run(async()=>{await growthApi(`rooms/${this.room.id}/advance`,'POST',{approved:true});this.changed.emit();},'Graph8 deal advanced to the next stage.');}
 async nextStep(){await this.run(async()=>{await growthApi(`rooms/${this.room.id}/next-step`,'POST',{});this.changed.emit();});}
 async loadDeals(){await this.run(async()=>this.deals.set(await growthApi('graph8/deals')));}
 async link(){await this.run(async()=>{await growthApi(`rooms/${this.room.id}/link-deal`,'POST',{dealId:this.dealId});this.changed.emit();},'Linked to the Graph8 deal.');}
 score(){const w:any={view:1,document:3,question:5,milestone:6};return (this.room.engagement||[]).reduce((n:number,e:any)=>n+(w[e.type]||1),0);}
 fmt(v:any){if(typeof v==='string')return v;const x=v?.suggestion||v?.next_best_step||v?.step||v;return typeof x==='string'?x:JSON.stringify(x,null,2);}
 private readonly toastBridge=toastSignals(this.notice,this.error);
}
