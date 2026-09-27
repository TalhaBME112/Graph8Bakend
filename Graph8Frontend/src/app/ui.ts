import {Injectable,Component,signal,effect,inject,untracked,WritableSignal} from '@angular/core';

// ── Toasts ────────────────────────────────────────────────────────────────────
export type ToastKind='success'|'error'|'info';
export interface Toast{id:number;text:string;kind:ToastKind;paused:boolean}
const DURATION=4000;

@Injectable({providedIn:'root'})
export class ToastService{
 readonly items=signal<Toast[]>([]);private seq=0;private timers=new Map<number,any>();
 show(text:string,kind:ToastKind='success'){
  const t=String(text||'').trim();if(!t)return;
  // Collapse identical messages that fire twice in a row.
  if(this.items().some(x=>x.text===t&&x.kind===kind))return;
  const id=++this.seq;this.items.update(list=>[...list.slice(-3),{id,text:t,kind,paused:false}]);this.arm(id);
 }
 dismiss(id:number){clearTimeout(this.timers.get(id));this.timers.delete(id);this.items.update(list=>list.filter(x=>x.id!==id));}
 pause(id:number,paused:boolean){this.items.update(list=>list.map(x=>x.id===id?{...x,paused}:x));if(paused)clearTimeout(this.timers.get(id));else this.arm(id);}
 private arm(id:number){clearTimeout(this.timers.get(id));this.timers.set(id,setTimeout(()=>this.dismiss(id),DURATION));}
}

// Forwards a component's existing notice/error signals into toasts, so components keep
// calling notice.set(...) / error.set(...) and every message renders the same way.
export function toastSignals(notice:WritableSignal<string>,error:WritableSignal<string>){
 const toasts=inject(ToastService);
 effect(()=>{const n=notice();if(n)untracked(()=>{toasts.show(n,'success');notice.set('');});});
 effect(()=>{const e=error();if(e)untracked(()=>{toasts.show(e,'error');error.set('');});});
 return true;
}

@Component({selector:'app-toasts',standalone:true,template:`
<div class="toasts" aria-live="polite">
 @for(t of toasts.items();track t.id){
  <div class="toast" [attr.data-kind]="t.kind" [attr.role]="t.kind==='error'?'alert':'status'" (mouseenter)="toasts.pause(t.id,true)" (mouseleave)="toasts.pause(t.id,false)">
   <span class="toast-icon" aria-hidden="true">{{t.kind==='error'?'!':t.kind==='info'?'i':'✓'}}</span>
   <p>{{t.text}}</p>
   <button type="button" (click)="toasts.dismiss(t.id)" aria-label="Dismiss">×</button>
   <i class="toast-timer" [class.paused]="t.paused"></i>
  </div>}
</div>`,styles:[`
.toasts{position:fixed;right:20px;bottom:20px;z-index:1000;display:flex;flex-direction:column;gap:10px;width:min(380px,calc(100vw - 32px));pointer-events:none}
.toast{pointer-events:auto;position:relative;overflow:hidden;display:flex;gap:10px;align-items:flex-start;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:10px;padding:12px 12px 14px;box-shadow:0 8px 24px -6px #0000002e,0 1px 3px #0000001a;animation:toast-in .18s ease-out}
.toast p{margin:1px 0 0;flex:1;font-size:13.5px;line-height:1.45;color:var(--ink)}
.toast-icon{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;background:var(--ok-soft);color:var(--ok)}
.toast[data-kind=error] .toast-icon{background:var(--bad-soft);color:var(--bad)}.toast[data-kind=info] .toast-icon{background:var(--info-soft);color:var(--info)}
.toast button{flex:none;border:0;background:none;color:var(--muted);font-size:18px;line-height:1;padding:0 2px;cursor:pointer}.toast button:hover{color:var(--ink)}
.toast-timer{position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--ok);transform-origin:left;animation:toast-timer 4s linear forwards}
.toast[data-kind=error] .toast-timer{background:var(--bad)}.toast[data-kind=info] .toast-timer{background:var(--info)}.toast-timer.paused{animation-play-state:paused}
@keyframes toast-in{from{opacity:0;transform:translateY(8px)}}@keyframes toast-timer{to{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){.toast{animation:none}}`]})
export class Toasts{readonly toasts=inject(ToastService);}

// ── Theme ─────────────────────────────────────────────────────────────────────
export type Theme='light'|'dark';
@Injectable({providedIn:'root'})
export class ThemeService{
 readonly theme=signal<Theme>(this.initial());
 constructor(){
  effect(()=>{const t=this.theme();document.documentElement.dataset['theme']=t;});
  // Follow the operating system until the user picks a theme explicitly.
  try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',e=>{if(!this.stored())this.theme.set(e.matches?'dark':'light');});}catch{}
 }
 toggle(){const next:Theme=this.theme()==='dark'?'light':'dark';this.theme.set(next);try{localStorage.setItem('g8-theme',next);}catch{}}
 private stored():Theme|null{try{const v=localStorage.getItem('g8-theme');return v==='dark'||v==='light'?v:null;}catch{return null;}}
 private initial():Theme{const s=this.stored();if(s)return s;try{return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch{return 'light';}}
}
