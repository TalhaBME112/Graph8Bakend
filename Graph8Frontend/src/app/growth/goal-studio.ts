import {Component,Input,Output,EventEmitter,signal,OnChanges,OnDestroy} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {growthApi,ago,money} from './api';

// Run My Goal orchestration layer: a goal becomes a live agent run over Graph8 primitives
// (GTM context → market sizing → funnel → plan → approval → lists, contacts, A/B campaigns,
// Lab experiment, buyer-room template), then progress is tracked from Graph8 metrics.
@Component({selector:'app-goal-studio',standalone:true,imports:[CommonModule,FormsModule],styleUrl:'./studio.scss',template:`
<div class="studio">
 @if(mode==='wizard'){
  <div class="bar"><div><p class="eyebrow">PLAN WITH THE GRAPH8 GOAL AGENT</p><h3>State the outcome. The agent sizes, plans and builds it on Graph8.</h3></div><button (click)="closed.emit()">Close</button></div>
  <div class="body">
   @if(error()){<div class="alert error">{{error()}}<button (click)="error.set('')">✕</button></div>}
   <label>What do you want to achieve?<input [(ngModel)]="f.name" placeholder="e.g. Book 20 meetings with logistics operations leaders"></label>
   <label>Who is the audience?<textarea rows="2" [(ngModel)]="f.audience" placeholder="e.g. VP / Director of Operations at US logistics and freight companies, 200–2000 employees"></textarea></label>
   <div class="row"><label>Target<input type="number" min="1" [(ngModel)]="f.target"></label><label>Outcome<select [(ngModel)]="f.metric"><option>Qualified meetings</option><option>Qualified replies</option><option>New opportunities</option></select></label><label>Deadline<input type="date" [(ngModel)]="f.deadline"></label><label>Planning budget (USD)<input type="number" min="0" [(ngModel)]="f.budget"></label></div>
   <div class="acts"><button class="primary" (click)="start()" [disabled]="busy()||!f.name||!f.audience">{{busy()?'Starting agent…':'Start goal agent'}}</button></div>
   <small style="margin-top:8px">The agent reads your Graph8 GTM context, audits pipeline and campaigns, sizes the reachable market in Graph8’s contact graph, models the funnel, and drafts a plan. Nothing is created in Graph8 until you approve.</small>
  </div>
 }@else if(goal){
  <div class="bar"><div><p class="eyebrow">GOAL ORCHESTRATOR · GRAPH8</p><h3>{{run()?statusText(run()):'Not orchestrated yet'}}</h3>@if(goal.pace){<small>Pace: {{goal.pace.status.replace('_',' ')}} · {{goal.achieved}} achieved vs {{goal.pace.expectedByNow}} expected by now · {{goal.pace.sent}} sent · synced {{ago(goal.pace.at)}}</small>}</div>
   <div class="acts" style="margin:0">@if(!run()||['completed','failed','cancelled'].includes(run().status)){<button class="primary" (click)="orchestrate()" [disabled]="busy()">{{run()?'↻ Re-plan':'Run goal agent'}}</button>}@if(goal.orchestration?.campaigns){<button (click)="sync()" [disabled]="busy()">Sync progress from Graph8</button>}@if(run()?.stale||run()?.status==='failed'){<button (click)="resume()" [disabled]="busy()">Resume</button>}</div></div>
  <div class="body">
   @if(error()){<div class="alert error">{{error()}}<button (click)="error.set('')">✕</button></div>}
   @if(notice()){<div class="alert">{{notice()}}<button (click)="notice.set('')">✕</button></div>}
   @if(run();as r){
    @if(graph();as g){<div class="canvas">@for(n of g.nodes;track n.id;let last=$last){<div class="node" [attr.data-s]="state(n.id)" [title]="n.about"><span class="k">{{kind[n.kind]}}</span><b>{{n.label}}</b>@if(steps(n.id).length>1){<em class="iter">×{{steps(n.id).length}}</em>}</div>@if(!last){<span class="arrow">→</span>}}</div>}
    @if(r.state?.funnel;as fu){<div class="kpis"><div><span>Reachable in Graph8</span><b>{{r.state.market?.tam|number}}</b></div><div><span>Contacts needed</span><b>{{fu.contactsNeeded|number}}</b><small>{{fu.conversion*100|number:'1.2-2'}}% → {{goal.metric}}</small></div><div><span>Weekly pace</span><b>{{fu.contactsPerWeek|number}}</b><small>over {{fu.weeks}} weeks</small></div><div><span>A/B sample / arm</span><b>{{fu.abSamplePerArm|number}}</b></div><div><span>Feasible</span><b>{{fu.feasible?'Yes':'Stretch'}}</b></div></div>}
    @if(r.status==='awaiting_approval'){<div class="card"><h4>Approve the plan</h4>
     @if(r.state.plan;as pl){<div class="grid"><div><p class="eyebrow">Sequence</p>@for(s of pl.sequence;track $index){<div class="item"><span class="pill">Day {{s.day}}</span><span><b>{{s.subject}}</b><small>{{s.body}}</small></span></div>}</div>
      <div><p class="eyebrow">A/B experiment</p><small>{{pl.experiment?.hypothesis}}</small><div class="item"><span class="pill">A</span>{{pl.experiment?.variant_a}}</div><div class="item"><span class="pill">B</span>{{pl.experiment?.variant_b}}</div>
       <p class="eyebrow" style="margin-top:10px">Prospects from Graph8</p>@for(p of r.state.market.prospects.slice(0,6);track $index){<small>{{p.first_name}} {{p.last_name}} — {{p.job_title}} @ {{p.company_name}}</small>}</div></div>}
     <div class="row" style="margin-top:10px"><label>Prospects to import (max 50)<input type="number" min="0" max="50" [(ngModel)]="contacts"></label><label style="flex-direction:row;align-items:center"><input type="checkbox" style="width:auto" [(ngModel)]="opt.campaigns">A/B campaign drafts</label><label style="flex-direction:row;align-items:center"><input type="checkbox" style="width:auto" [(ngModel)]="opt.experiment">Lab experiment</label><label style="flex-direction:row;align-items:center"><input type="checkbox" style="width:auto" [(ngModel)]="opt.room">Buyer-room template</label></div>
     <div class="acts"><button (click)="approve('reject')" [disabled]="busy()">Reject</button><button class="primary" (click)="approve('approve')" [disabled]="busy()">Approve & build on Graph8</button></div></div>}
    @if(r.state?.execution;as x){<div class="card"><h4>✓ Built on Graph8</h4><div class="item"><span>Lists A #{{x.lists.A}} · B #{{x.lists.B}} · {{x.contacts}} contacts</span></div><div class="item"><span>Campaign drafts: A {{x.campaigns.A||'—'}} · B {{x.campaigns.B||'—'}}</span></div>
     <div class="acts">@if(x.experimentId){<button (click)="open.emit({page:'lab',id:x.experimentId})">Open Lab experiment →</button>}@if(x.roomId){<button (click)="open.emit({page:'rooms',id:x.roomId})">Open buyer-room template →</button>}</div>@for(w of x.errors;track $index){<small>⚠ {{w}}</small>}</div>}
    <p class="eyebrow" style="margin-top:14px">Execution trace</p>
    @for(s of r.steps;track s.id){<div class="step" [attr.data-s]="s.status"><header><span>{{kind[s.kind]}} {{s.label}}{{s.iteration>1?' · pass '+s.iteration:''}}</span><small>{{s.ms==null?'…':s.ms<1000?s.ms+' ms':(s.ms/1000|number:'1.1-1')+' s'}}{{s.branch?' → '+s.branch:''}}</small></header><p>{{s.summary}}</p>@for(l of s.llm||[];track $index){<span class="tag llm">{{l.engine==='Graph8 LLM skill'?'Graph8 skill · '+l.model:'rules fallback'}}</span>}@for(o of s.ops||[];track $index){@if(!o.op.startsWith('get_execution')&&!o.op.startsWith('execute_skill')){<span class="tag">◆ {{o.op.split('_').slice(0,3).join(' ')}}</span>}}</div>}
   }@else{<p class="muted">Run the goal agent to turn this goal into a sized plan and real Graph8 assets.</p>}
  </div>
 }
</div>`})
export class GoalStudio implements OnChanges,OnDestroy{
 @Input() mode:'wizard'|'detail'='detail';@Input() goal:any;
 @Output() changed=new EventEmitter<void>();@Output() created=new EventEmitter<string>();@Output() closed=new EventEmitter<void>();@Output() open=new EventEmitter<{page:string,id:string}>();
 busy=signal(false);error=signal('');notice=signal('');run=signal<any>(null);graph=signal<any>(null);
 f:any={target:20,metric:'Qualified meetings',budget:5000,deadline:new Date(Date.now()+60*864e5).toISOString().slice(0,10)};contacts=20;opt={campaigns:true,experiment:true,room:true};
 kind:Record<string,string>={llm:'AI',graph8:'Graph8',rule:'Rule',human:'Approval',condition:'Decision'};ago=ago;money=money;private timer:any;private loaded='';
 ngOnChanges(){if(this.mode==='detail'&&this.goal&&this.loaded!==this.goal.id){this.loaded=this.goal.id;this.run.set(null);void this.load();}}
 ngOnDestroy(){clearInterval(this.timer);}
 async run$(fn:()=>Promise<any>,ok=''){if(this.busy())return;this.busy.set(true);this.error.set('');try{await fn();if(ok)this.notice.set(ok);}catch(e:any){this.error.set(e.message);}finally{this.busy.set(false);}}
 async load(){try{if(!this.graph())this.graph.set((await growthApi<any[]>('graphs')).find(g=>g.id==='goal_run'));const runs=await growthApi<any[]>(`goals/${this.goal.id}/runs`);const latest=runs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];this.run.set(latest||null);this.poll();}catch(e:any){this.error.set(e.message);}}
 poll(){clearInterval(this.timer);const r=this.run();if(r&&r.status==='running')this.timer=setInterval(async()=>{const x=await growthApi(`runs/${this.run().id}`);this.run.set(x);if(x.status!=='running'){clearInterval(this.timer);if(x.status==='awaiting_approval')this.contacts=Math.min(20,x.state.market?.prospects?.length||20);this.changed.emit();}},2000);}
 steps(n:string){return (this.run()?.steps||[]).filter((s:any)=>s.node===n);}
 state(n:string){const r=this.run(),last=this.steps(n).at(-1);if(last)return last.status;return ['completed','failed','cancelled'].includes(r?.status)?'skipped':'pending';}
 statusText(r:any){return r.status==='awaiting_approval'?'Plan ready — waiting for your approval':r.status==='running'?`Working: ${r.steps.at(-1)?.label||'starting'}…`:r.status==='completed'?(r.state?.execution?'Plan executed on Graph8':'Run ended (plan rejected)'):r.status;}
 async start(){await this.run$(async()=>{const r=await growthApi('goals/quick','POST',{...this.f,target:Number(this.f.target),budget:Number(this.f.budget)});this.created.emit(r.goal.id);});}
 async orchestrate(){await this.run$(async()=>{this.run.set(await growthApi(`goals/${this.goal.id}/orchestrate`,'POST',{}));this.poll();});}
 async approve(decision:string){await this.run$(async()=>{this.run.set(await growthApi(`runs/${this.run().id}/approve`,'POST',{decision,contacts:Number(this.contacts),...this.opt}));this.poll();},decision==='approve'?'Approved — building on Graph8…':'Plan rejected.');}
 async resume(){await this.run$(async()=>{this.run.set(await growthApi(`runs/${this.run().id}/resume`,'POST',{}));this.poll();});}
 async sync(){await this.run$(async()=>{await growthApi(`goals/${this.goal.id}/sync`,'POST',{});this.changed.emit();},'Progress synced from Graph8 campaign metrics.');}
}
