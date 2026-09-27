import {TenderWorkspace} from './tender/tender';
import {RoomStudio} from './growth/room-studio';
import {LabStudio} from './growth/lab-studio';
import {GoalStudio} from './growth/goal-studio';
import { Component, computed, signal, OnDestroy, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Experiment, Room, Workspace } from './models';

@Component({ selector: 'app-root', imports: [CommonModule, FormsModule, TenderWorkspace, RoomStudio, LabStudio, GoalStudio], templateUrl: './app.html', styleUrl: './app.scss' })
export class App implements OnDestroy, AfterViewChecked {
  readonly nav = [{key:'tenders',name:'Tender Workspace',icon:'◇'}, { key: 'overview', name: 'Overview', icon: '◈' }, { key: 'rooms', name: 'Buyer Deal Rooms', icon: '▣' }, { key: 'lab', name: 'Campaign Learning Lab', icon: '◫' }, { key: 'goals', name: 'Run My Goal', icon: '◎' }];
  page = signal(location.pathname.startsWith('/buyer/') ? 'buyer' : ['overview','rooms','lab','goals','tenders'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
  workspace = signal<Workspace>({ rooms: [], experiments: [], goals: [] });
  status = signal({ configured: false, mode: 'Checking connection', sdkVersion: '' });
  loading = signal(true); busy = signal(false); error = signal(''); notice = signal(''); search = signal(''); modal = signal(''); selected = signal('');
  buyerRoom = signal<Room | null>(null);
  room = computed(() => this.workspace().rooms.find(x => x.id === this.selected()));
  experiment = computed(() => this.workspace().experiments.find(x => x.id === this.selected()));
  goal = computed(() => this.workspace().goals.find(x => x.id === this.selected()));
  rooms = computed(() => this.workspace().rooms.filter(x => (this.showArchived() || !x.archived) && `${x.name} ${x.company}`.toLowerCase().includes(this.search().toLowerCase())));
  experiments = computed(() => this.workspace().experiments.filter(x => x.name.toLowerCase().includes(this.search().toLowerCase())));
  goals = computed(() => this.workspace().goals.filter(x => x.name.toLowerCase().includes(this.search().toLowerCase())));
  openMilestones = computed(() => this.workspace().rooms.filter(r=>!r.archived).flatMap(r => r.milestones.map(m => ({ ...m, room: r.name, roomId: r.id }))).filter(m => !m.done).sort((a,b) => a.due.localeCompare(b.due)));
  readonly today = new Date().toISOString().slice(0,10);
  form: Record<string, any> = {};
  milestone = { title: '', owner: '', due: this.today, buyerEditable:false }; document = { title: '', url: '' }; question = { author: '', question: '' };
  showArchived=signal(false); importText=''; sourceExperiment=''; graphPage=1; hasMoreGraph=false; revealEventKey=false;
  private lastModal=''; private previousFocus:HTMLElement|null=null;
  private readonly onHash=()=>{const p=location.hash.slice(1);if(this.nav.some(n=>n.key===p)&&p!==this.page()){this.page.set(p);this.selected.set('');}};
  private poll=window.setInterval(()=>{if(!this.busy()&&!this.modal()&&this.page()==='goals'&&this.goal()?.autopilotLocal&&this.goal()?.status==='active')void this.refresh();},6000);
  participants = ''; lesson = ''; progress = 0; accessToken = sessionStorage.getItem('g8-access') || '';
  graphRows = signal<Record<string, any>[]>([]); graphResource = ''; connectionVerified = signal(false); connection=signal<{orgId?:string;orgName?:string;keyMode?:string;verifiedAt?:string}>({});
  constructor() { void this.refresh().then(ok=>{if(ok && this.status().configured)void this.verifyConnection();}); window.addEventListener('hashchange',this.onHash); }
  ngOnDestroy(){clearInterval(this.poll);window.removeEventListener('hashchange',this.onHash);}
  ngAfterViewChecked(){const m=this.modal();if(m!==this.lastModal){if(m){this.previousFocus=document.activeElement as HTMLElement;setTimeout(()=>document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus());}else this.previousFocus?.focus();this.lastModal=m;}}
  trapFocus(event:KeyboardEvent){if(event.key!=='Tab')return;const nodes=Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled),[role="dialog"] input,[role="dialog"] textarea,[role="dialog"] select,[role="dialog"] a[href]'));if(!nodes.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  async api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const token = sessionStorage.getItem('g8-access');
    const response = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Client': 'growth-ui', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    let result;try{result=await response.json();}catch{throw new Error('The workspace server is unavailable. Start npm run server and try again.');} if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`); return result;
  }
  async refresh() {
    this.loading.set(true); this.error.set('');
    try {
      if (this.page() === 'buyer') { this.buyerRoom.set(await this.api<Room>('public/' + this.buyerToken())); return true; }
      const [state, status] = await Promise.all([this.api<Workspace>('workspace'), this.api<any>('status')]); this.workspace.set(state); this.status.set(status);return true;
    } catch (e) { this.error.set(this.message(e));return false; } finally { this.loading.set(false); }
  }
  message(e: unknown) { return e instanceof Error ? e.message : 'Something went wrong. Please try again.'; }
  go(page: string) { this.page.set(page); location.hash = page; this.selected.set(''); this.search.set(''); this.error.set(''); }
  pick(id: string) { this.selected.set(id); this.participants = ''; this.lesson = this.experiment()?.lesson || ''; this.progress = this.goal()?.achieved || 0;this.sourceExperiment=this.goal()?.progressExperimentId||'';this.revealEventKey=false; }
  open(kind: string) {
    this.form = kind === 'room' ? { name: '', company: '', summary: '', dealId: '' } : kind === 'experiment' ? { name: '', hypothesis: '', metric: 'Qualified reply', variantA: '', variantB: '', minimum: 30 } : { name: '', audience: '', target: 10, metric: 'Qualified meetings', budget: 500, deadline: new Date(Date.now()+30*86400000).toISOString().slice(0,10) };
    this.modal.set(kind); this.error.set('');
  }
  async mutate(path: string, method: string, data: unknown, success = 'Saved') {
    if (this.busy()) return false; this.busy.set(true); this.error.set(''); this.notice.set('');
    try { await this.api(path, method, data); const refreshed=await this.refresh(); if(!refreshed){this.notice.set('The change was saved, but the refreshed data could not be loaded. Refresh before continuing.');return false;}this.notice.set(success); return true; }
    catch (e) { this.error.set(this.message(e)); return false; } finally { this.busy.set(false); }
  }
  async create() {
    const kind = this.modal(), collection = kind === 'room' ? 'rooms' : kind === 'experiment' ? 'experiments' : 'goals';
    if (await this.mutate(collection, 'POST', this.form, 'Created successfully')) { this.modal.set(''); this.go(kind === 'room' ? 'rooms' : kind === 'experiment' ? 'lab' : 'goals'); this.pick(this.workspace()[collection][0].id); }
  }
  percent(a: number, b: number) { return b ? Math.min(100, Math.round(a / b * 100)) : 0; }
  done(room: Room) { return room.milestones.filter(m => m.done).length; }
  async addMilestone() { if (await this.mutate(`rooms/${this.selected()}/milestones`, 'POST', this.milestone)) this.milestone = { title: '', owner: '', due: this.today,buyerEditable:false }; }
  async addDocument() { if (await this.mutate(`rooms/${this.selected()}/documents`, 'POST', this.document)) this.document = { title: '', url: '' }; }
  async toggleMilestone(room: Room, id: string, done: boolean) { await this.mutate(`rooms/${room.id}/milestones/${id}`, 'PATCH', { done }); }
  async share(enabled: boolean) { await this.mutate(`rooms/${this.selected()}/share`, 'POST', { enabled }, enabled ? 'Buyer link created. It expires in seven days.' : 'Buyer access revoked.'); }
  shareUrl(room: Room) { return `${location.origin}/buyer/${room.shareToken}`; }
  async copyLink(room: Room) { try { await navigator.clipboard.writeText(this.shareUrl(room)); this.notice.set('Buyer link copied'); } catch { this.error.set('Copy the displayed buyer link manually.'); } }
  async answer(id: string, answer: string) { await this.mutate(`rooms/${this.selected()}/questions/${id}`, 'PATCH', { answer }); }
  async assignParticipants() { if (await this.mutate(`experiments/${this.selected()}/participants`, 'POST', { contacts: this.participants.split(/[\n,]+/).map(x => x.trim()).filter(Boolean) }, 'Participants assigned. No outreach was sent.')) this.participants = ''; }
  async outcome(contactId: string, value: string) { await this.mutate(`experiments/${this.selected()}/outcomes`, 'PATCH', { contactId, converted: value === 'pending' ? null : value === 'yes' }); }
  async experimentStatus(status: string) { await this.mutate(`experiments/${this.selected()}`, 'PATCH', { status }); }
  async saveLesson() { await this.mutate(`experiments/${this.selected()}`, 'PATCH', { lesson: this.lesson }); }
  async goalStatus(status: string) { await this.mutate(`goals/${this.selected()}`, 'PATCH', { status }); }
  async saveProgress() { await this.mutate(`goals/${this.selected()}`, 'PATCH', { achieved: Number(this.progress) }, 'Outcome count updated (manually reported).'); }
  reviewStep(step: any) { this.form = { ...step }; this.modal.set('approve'); }
  async execute() { if (await this.mutate(`goals/${this.selected()}/execute`, 'POST', { stepId: this.form['id'], approved: true }, 'Action completed. See its receipt below.')) this.modal.set(''); }
  buyerToken() { return location.pathname.split('/')[2] || ''; }
  studio = '';
  async studioCreated(page: string, entityId: string) { this.studio = ''; await this.refresh(); this.go(page); this.pick(entityId); this.notice.set('Created with live Graph8 data.'); }
  async openEntity(target: { page: string; id: string }) { await this.refresh(); this.go(target.page); this.pick(target.id); }
  async askQuestion() { if (await this.mutate(`public/${this.buyerToken()}/questions`, 'POST', this.question, 'Your question has been added.')) this.question.question = ''; }
  saveAccess() { sessionStorage.setItem('g8-access', this.accessToken.trim()); this.modal.set(''); void this.refresh().then(ok=>{if(ok && this.status().configured)void this.verifyConnection();}); }
  async loadGraph(resource: string, page=1) {
    this.graphResource = resource; this.graphRows.set([]); this.busy.set(true); this.error.set('');
    try {
      const result = await this.api<any>('graph8/' + resource+'?page='+page);
      const candidates = [result, result.data, result[resource], result.data?.[resource], result.data?.items, result.items];
      const rows = candidates.find(Array.isArray); if (!rows) throw new Error('Graph8 returned an unrecognized response shape. No records were imported.');
      this.graphRows.set(rows);this.graphPage=page;this.hasMoreGraph=Boolean(result.pagination?.has_next || rows.length===100); this.connectionVerified.set(true); this.modal.set('graph');
    } catch (e) { this.error.set(this.message(e)); } finally { this.busy.set(false); }
  }
  importDeal(row: any) { this.open('room'); this.form = { name: row.name || row.title || 'Buyer workspace', company: row.company_name || '', summary: 'A shared place for our evaluation, documents and next steps.', dealId: String(row.id) }; }
  async useContact(row: any) { await this.mutate(`experiments/${this.selected()}/participants`, 'POST', { contacts: [String(row.id)] }, 'Graph8 contact assigned to a variant.'); }
  async linkCampaign(row: any, variant: 'A' | 'B') { await this.mutate(`experiments/${this.selected()}`, 'PATCH', { [variant === 'A' ? 'campaignA' : 'campaignB']: String(row.id) }, `Variant ${variant} linked. Record outcomes manually, import CSV, or connect the event API.`); }
  exportAssignments(e: Experiment) {
    const quote = (v: string) => '"' + v.replace(/"/g, '""') + '"';
    const csv = ['contact_id,variant,outcome', ...e.participants.map(p => [p.contactId, p.variant, p.converted === null ? 'pending' : String(p.converted)].map(v => quote(/^[=+@\-]/.test(v) ? "'"+v : v)).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], {type:'text/csv'})); const a = document.createElement('a'); a.href = url; a.download = 'experiment-assignments.csv'; a.click(); URL.revokeObjectURL(url);
  }
  edit(kind:string,row:any){this.form=structuredClone(row);this.modal.set('edit-'+kind);}
  async saveEdit(){const kind=this.modal().replace('edit-','');let path='';if(kind==='room')path=`rooms/${this.selected()}`;if(kind==='experiment')path=`experiments/${this.selected()}/details`;if(kind==='goal')path=`goals/${this.selected()}/details`;if(kind==='milestone')path=`rooms/${this.selected()}/milestones/${this.form['id']}`;if(kind==='step')path=`goals/${this.selected()}/steps/${this.form['id']}`;if(await this.mutate(path,'PATCH',this.form))this.modal.set('');}
  editStep(step:any){this.form={...structuredClone(step),config:{name:step.config?.name||step.title,hypothesis:step.config?.hypothesis||'',variantA:step.config?.variantA||'',variantB:step.config?.variantB||''}};this.modal.set('edit-step');}
  confirmAction(title:string,path:string,method:string,data:unknown){this.form={title,path,method,data};this.modal.set('confirm');}
  async confirmed(){if(await this.mutate(this.form['path'],this.form['method'],this.form['data']))this.modal.set('');}
  async cloneExperiment(){const old=this.selected();if(await this.mutate(`experiments/${old}/clone`,'POST',{})){this.pick(this.workspace().experiments[0].id);}}
  async importOutcomes(){try{const lines=this.importText.trim().split(/\r?\n/).filter(Boolean);const rows=lines.map((line,i)=>{const parts=line.split(',').map(x=>x.trim());if(i===0&&parts[0]==='contactId')return null;if(parts.length!==2||!['true','false'].includes(parts[1]))throw new Error('Use contactId,true or contactId,false on each line.');return {contactId:parts[0],converted:parts[1]==='true'};}).filter(Boolean);if(await this.mutate(`experiments/${this.selected()}/import-outcomes`,'POST',{rows},'Outcomes imported atomically.')){this.modal.set('');this.importText='';}}catch(e){this.error.set(this.message(e));}}
  async syncCampaigns(){await this.mutate(`experiments/${this.selected()}/sync`,'POST',{},'Campaign metrics refreshed from Graph8.');}
  metricKeys(e:Experiment){return [...new Set([...Object.keys(e.campaignMetrics?.A||{}),...Object.keys(e.campaignMetrics?.B||{})])];}
  async linkProgress(){await this.mutate(`goals/${this.selected()}/link-progress`,'POST',{experimentId:this.sourceExperiment},'Progress source updated.');}
  async automation(enabled:boolean){await this.mutate(`goals/${this.selected()}/automation`,'POST',{enabled},enabled?'Local steps will run automatically while the goal is active. Campaign creation still requires review.':'Local automation paused.');}
  async buyerComplete(m:any){if(!this.question.author.trim()){this.error.set('Enter your name in the question form before updating a shared milestone.');return;}await this.mutate(`public/${this.buyerToken()}/milestones/${m.id}`,'PATCH',{done:!m.done,author:this.question.author});}
  async downloadBackup(){try{const data=await this.api('export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='graph8-workspace-backup.json';a.click();URL.revokeObjectURL(url);}catch(e){this.error.set(this.message(e));}}
  async reconcile(){if(await this.mutate(`goals/${this.selected()}/reconcile`,'POST',this.form,'Campaign reconciled'))this.modal.set('');}
  async verifyConnection(){this.busy.set(true);this.error.set('');try{this.connection.set(await this.api('connection'));this.connectionVerified.set(true);this.notice.set('Graph8 organization verified.');}catch(e){this.connectionVerified.set(false);this.error.set(this.message(e));}finally{this.busy.set(false);}}
  eventEndpoint(e:Experiment){return `${location.origin}/api/events/experiments/${e.id}`;}
}
