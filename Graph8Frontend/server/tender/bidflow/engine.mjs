// A small LangGraph-style state machine. A graph is a set of nodes (async functions that
// read and patch a shared state), edges that are either fixed or conditional routers, and
// human nodes that interrupt the run until someone approves. Every step is persisted
// (encrypted SQLite + hash-chained audit), so a run can be inspected, resumed after a
// restart, or replayed in the UI node by node.
import {AppError} from '../../domain.mjs';
import {uid,stamp} from '../model.mjs';
import {think} from './llm.mjs';

export const END='__end__';
const MAX_STEPS=60,MAX_VISITS=4;

export function defineGraph(g){
 for(const [from,edge] of Object.entries(g.edges)){const targets=typeof edge==='string'?[edge]:Object.values(edge.branches);for(const t of targets)if(t!==END&&!g.nodes[t])throw new Error(`${g.id}: edge ${from} → unknown node ${t}`);}
 return g;
}
// Serializable shape for the UI graph canvas.
export function describeGraph(g){return {id:g.id,name:g.name,description:g.description,start:g.start,nodes:Object.entries(g.nodes).map(([id,n])=>({id,label:n.label,kind:n.kind,about:n.about})),edges:Object.entries(g.edges).flatMap(([from,e])=>typeof e==='string'?[{from,to:e}]:Object.entries(e.branches).map(([label,to])=>({from,to,label})))};}

export function createEngine(db,graphs){
 const active=new Set();
 const kind='bidflow-run';
 const save=(org,run,action,fn)=>db.update(org,kind,run.id,run.actor||'bidflow',action,r=>{fn(r);});

 function next(graph,node,state){const e=graph.edges[node];if(!e)return {to:END};if(typeof e==='string')return {to:e};const label=e.route(state);const to=e.branches[label];if(to===undefined)throw new Error(`Router at ${node} returned unknown branch ${label}`);return {to,label};}

 async function execute(org,id){
  if(active.has(id))return;active.add(id);
  try{
   for(let guard=0;guard<MAX_STEPS;guard++){
    const run=db.get(org,kind,id);if(run.status!=='running')return;
    const graph=graphs[run.graphId],node=run.current;
    if(node===END){save(org,run,'bidflow:completed',r=>{r.status='completed';r.finishedAt=stamp();});return;}
    const def=graph.nodes[node];const visits=(run.visits[node]||0)+1;
    if(visits>MAX_VISITS)throw new Error(`Loop guard: ${def.label} visited ${visits} times`);
    const step={id:uid(),node,label:def.label,kind:def.kind,status:'running',startedAt:stamp(),iteration:visits};
    save(org,run,'bidflow:step-started',r=>{r.steps.push(step);r.visits[node]=visits;});
    const trace=[],llm=[];const started=Date.now();
    const ctx={org,db,run,trace,iteration:visits,
     think:async(task,payload,opts)=>{const out=await think(task,payload,{trace,...opts});llm.push(out.meta);return out.data;},
     tryThink:async(task,payload,fallback,opts)=>{try{const out=await think(task,payload,{trace,...opts});llm.push(out.meta);return {data:out.data,engine:'llm'};}catch(e){llm.push({engine:'rules fallback',error:String(e.message).slice(0,200)});return {data:await fallback(),engine:'rules'};}}};
    let result;
    try{result=await def.run(structuredClone(run.state),ctx)||{};}
    catch(e){save(org,run,'bidflow:failed',r=>{const s=r.steps.at(-1);Object.assign(s,{status:'failed',ms:Date.now()-started,summary:String(e.message||e).slice(0,500),ops:trace,llm});r.status='failed';r.error=`${def.label}: ${String(e.message||e).slice(0,500)}`;r.finishedAt=stamp();});return;}
    const fresh=db.get(org,kind,id);if(fresh.status==='cancelled')return;
    const state={...fresh.state,...(result.patch||{})};
    if(result.interrupt){save(org,fresh,'bidflow:awaiting-approval',r=>{r.state=state;const s=r.steps.at(-1);Object.assign(s,{status:'waiting',ms:Date.now()-started,summary:result.summary||'Waiting for approval',detail:result.detail,ops:trace,llm});r.status='awaiting_approval';r.interrupt=result.interrupt;});return;}
    const route=next(graph,node,state);
    save(org,fresh,'bidflow:step-completed',r=>{r.state=state;const s=r.steps.at(-1);Object.assign(s,{status:'done',ms:Date.now()-started,summary:result.summary||'',detail:result.detail,ops:trace,llm,branch:route.label||null,to:route.to});r.current=route.to;});
   }
   throw new Error('Step limit reached');
  }catch(e){try{const run=db.get(org,kind,id);save(org,run,'bidflow:failed',r=>{r.status='failed';r.error=String(e.message||e).slice(0,500);r.finishedAt=stamp();});}catch{}}
  finally{active.delete(id);}
 }

 return {
  start(org,graphId,{actor,tenderId,userId,input,trigger='manual'}){
   const graph=graphs[graphId];if(!graph)throw new AppError('Unknown BidFlow graph.',404);
   const running=db.list(org,kind).find(r=>r.graphId===graphId&&r.tenderId===tenderId&&r.userId===userId&&['running','awaiting_approval'].includes(r.status));
   if(running)return running;
   const run=db.create(org,kind,{id:uid(),graphId,graphName:graph.name,tenderId,userId,actor,trigger,status:'running',current:graph.start,state:input,steps:[],visits:{},createdAt:stamp()},actor);
   setImmediate(()=>execute(org,run.id));return run;
  },
  // Human-in-the-loop: records the decision on the waiting node, then follows its edge.
  resume(org,id,actor,approval){
   const run=db.get(org,kind,id);
   if(run.status==='running'&&!active.has(id)){setImmediate(()=>execute(org,id));return run;}
   if(run.status!=='awaiting_approval')throw new AppError('This run is not waiting for approval.',409);
   const graph=graphs[run.graphId],state={...run.state,approval:{...approval,by:actor,at:stamp()}},route=next(graph,run.current,state);
   const updated=save(org,run,'bidflow:approved',r=>{r.state=state;const s=r.steps.at(-1);Object.assign(s,{status:'done',summary:approval.decision==='reject'?`Rejected by reviewer`:`Approved by reviewer`,branch:route.label||null,to:route.to,approvedBy:actor});r.interrupt=null;r.status='running';r.current=route.to;});
   setImmediate(()=>execute(org,id));return updated;
  },
  cancel(org,id,actor){const run=db.get(org,kind,id);if(!['running','awaiting_approval'].includes(run.status))throw new AppError('Run already finished.',409);return save(org,run,'bidflow:cancelled',r=>{r.status='cancelled';r.finishedAt=stamp();r.cancelledBy=actor;});},
  // A run marked running but not active in this process was interrupted by a restart.
  view(run){return {...run,live:active.has(run.id),stale:run.status==='running'&&!active.has(run.id)};},
  list(org,filter=()=>true){return db.list(org,kind).filter(filter);},
  get(org,id){return db.get(org,kind,id);},
 };
}
