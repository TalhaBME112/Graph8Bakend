import {Component,Input,Output,EventEmitter,signal,OnChanges} from '@angular/core';
import {toastSignals} from '../ui';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {growthApi,ago} from './api';

// Experimentation platform on top of Graph8 campaigns: AI-designed single-variable tests,
// pre-registered power analysis, audiences from Graph8 lists, A/B arms as Graph8 campaign
// drafts, and a decision framework that reads live Graph8 metrics.
@Component({selector:'app-lab-studio',standalone:true,imports:[CommonModule,FormsModule],styleUrl:'./studio.scss',template:`
<div class="studio">
 @if(mode==='wizard'){
  <div class="bar"><div><p class="eyebrow">DESIGN AN EXPERIMENT WITH GRAPH8</p><h3>Question → hypothesis → pre-registered A/B test</h3></div><button (click)="closed.emit()">Close</button></div>
  <div class="body">
   
   <div class="split"><div>
    <label>What do you want to learn?<textarea rows="3" [(ngModel)]="topic" placeholder="e.g. Does naming a peer customer in the subject line lift replies from logistics ops leaders?"></textarea></label>
    <div class="row"><label>Primary metric<select [(ngModel)]="metric"><option value="reply">Reply rate</option><option value="open">Open rate</option><option value="click">Click rate</option><option value="meeting">Meeting rate</option></select></label>
     <label>Base on a Graph8 campaign (optional)<select [(ngModel)]="campaignId"><option value="">None</option>@for(c of campaigns();track c.id){<option [value]="c.id">{{c.name}} · {{c.status}}</option>}</select></label></div>
    <div class="acts"><button class="primary" (click)="design()" [disabled]="busy()||topic.length<8">{{busy()?'Designing…':'Design test'}}</button></div>
    <small style="margin-top:10px">Graph8’s LLM uses your Studio global context (messaging, personas) and the chosen campaign to propose one single-variable test.</small>
   </div><div>
    @if(d();as x){<p class="eyebrow">Proposed design · {{x._engine}}</p>
     <label>Name<input [(ngModel)]="x.name"></label><label>Hypothesis<textarea rows="3" [(ngModel)]="x.hypothesis"></textarea></label>
     <div class="grid"><div class="card"><h4>A · {{x.variant_a.label}}</h4><label>Subject<input [(ngModel)]="x.variant_a.subject"></label><label>Body<textarea rows="4" [(ngModel)]="x.variant_a.body"></textarea></label></div>
      <div class="card"><h4>B · {{x.variant_b.label}}</h4><label>Subject<input [(ngModel)]="x.variant_b.subject"></label><label>Body<textarea rows="4" [(ngModel)]="x.variant_b.body"></textarea></label></div></div>
     <div class="row"><label>Baseline rate<input type="number" step="0.005" [(ngModel)]="x.baseline"></label><label>MDE (absolute)<input type="number" step="0.005" [(ngModel)]="x.mde"></label><label>Required per arm<input [value]="required(x.baseline,x.mde)" disabled></label></div>
     <small>Guardrail: {{x.guardrail}}</small>
     <div class="acts"><button class="primary" (click)="create()" [disabled]="busy()">Create & pre-register</button></div>}
    @else{<div class="card"><small>The design appears here: hypothesis in “We believe … because … we will know when …” form, variant copy, baseline, minimum detectable effect and the sample each arm needs.</small></div>}
   </div></div>
  </div>
 }@else if(e){
  <div class="bar"><div><p class="eyebrow">EXPERIMENT ENGINE · GRAPH8</p><h3>{{e.plan?'Pre-registered: '+(e.plan.requiredPerArm|number)+' per arm · α '+e.plan.alpha+' · power '+(e.plan.power*100)+'%':'Pre-register this test before it starts'}}</h3><small>{{e.plan?.metricSource==='graph8'?'Outcomes read live from Graph8 campaign metrics':'Outcomes from contact-level results'}}{{e.decision?' · evaluated '+ago(e.decision.at):''}}</small></div>
   <div class="acts" style="margin:0"><button class="primary" (click)="evaluate()" [disabled]="busy()">Evaluate now</button>@if(e.status==='completed'||e.decision){<button (click)="learn()" [disabled]="busy()">Summarise learning</button>}</div></div>
  <div class="body">
   
   
   @if(e.decision;as v){<div class="verdict" [attr.data-d]="v.decision"><p class="eyebrow">Decision framework · {{v.source}}</p><h4>{{v.label}}</h4>
    <div class="kpis" style="margin:10px 0 0"><div><span>A</span><b>{{v.rateA*100|number:'1.1-2'}}%</b><small>{{v.A.x}} / {{v.A.n}}</small></div><div><span>B</span><b>{{v.rateB*100|number:'1.1-2'}}%</b><small>{{v.B.x}} / {{v.B.n}}</small></div><div><span>P(B beats A)</span><b>{{v.probBBeats*100|number:'1.0-1'}}%</b></div><div><span>p-value</span><b>{{v.pValue|number:'1.3-3'}}</b></div><div><span>Sample</span><b>{{v.progress*100|number:'1.0-0'}}%</b><div class="meter"><span [style.width.%]="v.progress*100>100?100:v.progress*100"></span></div></div></div>
    <ul>@for(r of v.reasons;track $index){<li>{{r}}</li>}</ul></div>}
   @if(e.learning;as l){<div class="card" style="margin-top:12px"><h4>Learning · {{l.headline}}</h4><p class="muted">{{l.what_we_learned}}</p><small><b>Next test:</b> {{l.next_test}}</small></div>}
   <div class="grid" style="margin-top:14px">
    <div class="card"><h4>1 · Pre-registration</h4>
     @if(e.status==='draft'){<div class="row"><label>Baseline<input type="number" step="0.005" [(ngModel)]="plan.baseline"></label><label>MDE<input type="number" step="0.005" [(ngModel)]="plan.mde"></label></div><div class="row"><label>α<input type="number" step="0.01" [(ngModel)]="plan.alpha"></label><label>Power<input type="number" step="0.05" [(ngModel)]="plan.power"></label></div>
      <div class="row"><label>Metric<select [(ngModel)]="plan.metric"><option value="reply">Reply</option><option value="open">Open</option><option value="click">Click</option><option value="meeting">Meeting</option></select></label><label>Outcome source<select [(ngModel)]="plan.metricSource"><option value="graph8">Graph8 campaign metrics</option><option value="contacts">Contact outcomes</option></select></label></div>
      <small>Needs <b>{{required(plan.baseline,plan.mde)}}</b> contacts per arm. Rule: ship only when P(better) ≥ 95%, p &lt; α and expected loss ≤ MDE/10 at full sample; early stop at ≥ 99.5%.</small>
      <div class="acts"><button class="primary" (click)="register()" [disabled]="busy()">Register plan</button></div>}
     @else{<small>Locked at start: baseline {{e.plan?.baseline}}, MDE {{e.plan?.mde}}, {{e.plan?.requiredPerArm}} per arm.</small>}</div>
    <div class="card"><h4>2 · Variant copy</h4>
     @if(e.status==='draft'){<label>A subject<input [(ngModel)]="copy.A.subject"></label><label>A body<textarea rows="3" [(ngModel)]="copy.A.body"></textarea></label><label>B subject<input [(ngModel)]="copy.B.subject"></label><label>B body<textarea rows="3" [(ngModel)]="copy.B.body"></textarea></label><div class="acts"><button (click)="saveCopy()" [disabled]="busy()">Save copy</button></div>}
     @else{@if(e.copy){<small><b>A:</b> {{e.copy.A.subject}}</small><small><b>B:</b> {{e.copy.B.subject}}</small>}}</div>
    <div class="card"><h4>3 · Audience & arms in Graph8</h4>
     <small>{{e.participants.length}} participants{{e.audienceListId?' from Graph8 list #'+e.audienceListId:''}} · A {{count('A')}} / B {{count('B')}}</small>
     @if(e.status==='draft'&&!e.campaignA){<div class="row" style="margin-top:6px"><select [(ngModel)]="listId"><option value="">Import from a Graph8 list…</option>@for(l of lists();track l.id){<option [value]="l.id">{{l.title}} ({{l.total}})</option>}</select><button style="flex:0" (click)="importList()" [disabled]="busy()||!listId">Import</button></div>
      <div class="acts"><button class="primary" (click)="launch()" [disabled]="busy()||!e.copy||e.participants.length<2">Create A/B arms in Graph8</button></div><small>Creates one list and one campaign draft per arm with the variant copy. Launch from Graph8 once a mailbox is connected.</small>}
     @if(e.graph8Arms;as g){@for(v of ['A','B'];track v){<div class="item"><span class="pill">{{v}}</span><span>List #{{g[v].listId}} · {{g[v].contacts}} contacts<small>Campaign draft {{g[v].campaignId}}</small></span></div>}}
     @else if(e.campaignA){<small>Linked campaigns: A {{e.campaignA}} · B {{e.campaignB}}</small>}</div>
   </div>
  </div>
 }
</div>`})
export class LabStudio implements OnChanges{
 @Input() mode:'wizard'|'detail'='detail';@Input() e:any;
 @Output() changed=new EventEmitter<void>();@Output() created=new EventEmitter<string>();@Output() closed=new EventEmitter<void>();
 busy=signal(false);error=signal('');notice=signal('');d=signal<any>(null);campaigns=signal<any[]>([]);lists=signal<any[]>([]);
 topic='';metric='reply';campaignId='';listId='';ago=ago;
 plan:any={baseline:0.03,mde:0.015,alpha:0.05,power:0.8,metric:'reply',metricSource:'graph8'};copy:any={A:{subject:'',body:''},B:{subject:'',body:''}};
 ngOnChanges(){if(this.mode==='wizard'&&!this.campaigns().length)void this.run(async()=>this.campaigns.set(await growthApi('graph8/campaigns')));
  if(this.e){if(this.e.plan)this.plan={...this.plan,...this.e.plan};if(this.e.copy)this.copy=structuredClone(this.e.copy);if(this.e.status==='draft'&&!this.lists().length)void this.run(async()=>this.lists.set(await growthApi('graph8/lists')));}}
 async run(fn:()=>Promise<any>,ok=''){if(this.busy())return;this.busy.set(true);this.error.set('');try{await fn();if(ok)this.notice.set(ok);}catch(e:any){this.error.set(e.message);}finally{this.busy.set(false);}}
 // Two-proportion sample size (normal approximation), mirrors the server.
 required(b:number,m:number){b=Number(b);m=Number(m);if(!(b>0&&b<1&&m>0))return '—';const p2=Math.min(0.999,b+m),pb=(b+p2)/2,za=1.959964,zb=0.841621;return Math.ceil((za*Math.sqrt(2*pb*(1-pb))+zb*Math.sqrt(b*(1-b)+p2*(1-p2)))**2/(p2-b)**2).toLocaleString();}
 count(v:string){return (this.e?.participants||[]).filter((p:any)=>p.variant===v).length;}
 async design(){await this.run(async()=>this.d.set(await growthApi('experiments/design','POST',{topic:this.topic,metric:this.metric,campaignId:this.campaignId||undefined})));}
 async create(){const x=this.d();await this.run(async()=>{const token=sessionStorage.getItem('g8-access');const r=await fetch('/api/experiments',{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Client':'growth-ui',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({name:x.name,hypothesis:x.hypothesis,metric:`${x.metric||this.metric} rate`,variantA:`${x.variant_a.label}: ${x.variant_a.subject}`.slice(0,480),variantB:`${x.variant_b.label}: ${x.variant_b.subject}`.slice(0,480),minimum:30})});const exp=await r.json();if(!r.ok)throw Error(exp.error);
  await growthApi(`experiments/${exp.id}/copy`,'POST',{A:{subject:x.variant_a.subject,body:x.variant_a.body},B:{subject:x.variant_b.subject,body:x.variant_b.body}});
  await growthApi(`experiments/${exp.id}/plan`,'POST',{baseline:Number(x.baseline)||0.03,mde:Number(x.mde)||0.015,alpha:0.05,power:0.8,metric:this.metric,metricSource:'graph8',guardrail:x.guardrail});this.created.emit(exp.id);});}
 async register(){await this.run(async()=>{await growthApi(`experiments/${this.e.id}/plan`,'POST',this.plan);this.changed.emit();},'Plan pre-registered. The minimum sample per arm was updated.');}
 async saveCopy(){await this.run(async()=>{await growthApi(`experiments/${this.e.id}/copy`,'POST',this.copy);this.changed.emit();},'Variant copy saved.');}
 async importList(){await this.run(async()=>{const r=await growthApi(`experiments/${this.e.id}/audience`,'POST',{listId:Number(this.listId)});this.changed.emit();this.notice.set(`${r.added} Graph8 contacts assigned (stable 50/50 split).`);});}
 async launch(){if(!confirm('Create one Graph8 list and one campaign draft per arm? Nothing is sent.'))return;await this.run(async()=>{await growthApi(`experiments/${this.e.id}/launch`,'POST',{});this.changed.emit();},'A/B arms created in Graph8 as campaign drafts.');}
 async evaluate(){await this.run(async()=>{await growthApi(`experiments/${this.e.id}/decision`,'POST',{});this.changed.emit();});}
 async learn(){await this.run(async()=>{await growthApi(`experiments/${this.e.id}/learning`,'POST',{});this.changed.emit();},'Learning summarised and saved to the experiment.');}
 private readonly toastBridge=toastSignals(this.notice,this.error);
}
