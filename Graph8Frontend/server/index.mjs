import {graph8ConnectionError} from './connection-error.mjs';
import {createRequestLogger} from './tender/logging.mjs';
import {createTenderApi} from './tender/api.mjs';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, id, now, text, number, date, safeUrl, assignment, experimentResult, createRoom, createExperiment, createGoal, publicRoom } from './domain.mjs';
import { openStore } from './store.mjs';
import { graph8Read, draftCampaign, graph8Client } from './graph8.mjs';
import { featureRoute, ingestOutcome, refreshGoalProgress } from './features.mjs';
import { createGrowth } from './growth/routes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const logTenderRequest=createRequestLogger(root);
const port = Number(process.env.PORT || 4301);
const store = await openStore(process.env.G8_WORKSPACE_FILE || resolve(root, 'server/data/workspace.json'));
const frontend = resolve(root, 'dist/graph8-frontend/browser');
const growth = createGrowth({ store, root });
const bindHost = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1','localhost','::1'].includes(bindHost) && (!process.env.ADMIN_TOKEN || !process.env.APP_ORIGIN?.startsWith('https://'))) throw new Error('Remote hosting requires ADMIN_TOKEN and an HTTPS APP_ORIGIN.');
const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, 'http://localhost:4200', 'http://127.0.0.1:4200', process.env.APP_ORIGIN].filter(Boolean));
const token = () => randomBytes(32).toString('hex');
function find(state, collection, target) { const item = state[collection].find(x => x.id === target); if (!item) throw new AppError('Item not found.', 404); return item; }
function publicFind(state, target) { const room = state.rooms.find(x => !x.archived && x.shareToken === target && Date.parse(x.shareExpiresAt) > Date.now()); if (!room) throw new AppError('This room link has expired or been revoked.', 404); return room; }
function checkAdmin(req) {
  if (process.env.ADMIN_TOKEN) {
    const a = Buffer.from(req.headers.authorization || ''), b = Buffer.from(`Bearer ${process.env.ADMIN_TOKEN}`);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError('Enter your workspace access token in Connection settings.', 401);
  } else if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new AppError('Remote administration requires ADMIN_TOKEN.', 403);
}
async function body(req) {
  let data = '';const max=req.url.startsWith('/api/tender/')?12*1024*1024:1024*1024; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > max) throw new AppError('Request too large.', 413); }
  try { const parsed=data ? JSON.parse(data) : {}; if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error();return parsed; } catch { throw new AppError('Supply a JSON object.'); }
}
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
const busy = new Set();
let tenderApi;
async function executeGoal(goalId, stepId, approved) {
  if (!approved) throw new AppError('Review and approve this action first.');
  if (busy.has(goalId)) throw new AppError('An action is already running for this goal.', 409);
  busy.add(goalId);
  try {
    const goal = find(store.read(), 'goals', goalId);
    if (goal.status !== 'active') throw new AppError('Activate this goal before running a step.');
    const step = goal.steps.find(x => x.id === stepId);
    if (!step) throw new AppError('Step not found.', 404);
    if (step.status === 'completed') return { alreadyCompleted: true };
    if (step.status === 'running' || step.status === 'uncertain') throw new AppError('This external action needs reconciliation in Graph8 before retrying. Create no duplicate campaign.', 409);
    if (goal.steps.some(x => x.status !== 'completed' && goal.steps.indexOf(x) < goal.steps.indexOf(step))) throw new AppError('Complete the earlier steps first.');
    if (step.action === 'campaign') {
      if (!process.env.G8_API_KEY) throw new AppError('Connect Graph8 before creating the campaign draft.', 503);
      await store.update(s => { const g = find(s, 'goals', goalId); g.steps.find(x => x.id === stepId).status = 'running'; });
      try {
        const response = await draftCampaign({...goal,stepId:step.id,name:step.config?.name || goal.name});
        await store.update(s => { const g = find(s, 'goals', goalId), st = g.steps.find(x => x.id === stepId); st.status = 'completed'; g.receipts.unshift({ id: id(), at: now(), action: step.title, detail: 'Graph8 accepted campaign creation. No outreach launched.', response }); });
      } catch (error) {
        await store.update(s => { const g = find(s, 'goals', goalId); g.steps.find(x => x.id === stepId).status = 'uncertain'; g.receipts.unshift({ id: id(), at: now(), action: step.title, detail: 'Outcome uncertain. Check Graph8 campaigns before further action.' }); });
        throw new AppError('Graph8 did not confirm the outcome. Inspect campaigns before retrying to prevent duplicates.', 502);
      }
    } else await store.update(s => {
      const g = find(s, 'goals', goalId); let entity;
      if (step.action === 'experiment') {
        entity = createExperiment({ name: step.config?.name || `${g.name} · message test`, hypothesis: step.config?.hypothesis || `For ${g.audience}, an outcome-led message increases ${g.metric.toLowerCase()} compared with a problem-led message.`, metric: g.metric, variantA: step.config?.variantA || 'Lead with the customer problem', variantB: step.config?.variantB || 'Lead with the desired outcome', minimum: 30 }); s.experiments.unshift(entity);
      } else {
        entity = createRoom({ name: step.config?.name || `${g.name} · buyer workspace`, company: g.audience, summary: `Working together toward ${g.target} ${g.metric}. Use this space to agree on next steps.` }); entity.milestones.push({id:id(),title:'Agree on evaluation criteria',owner:'Buyer and account team',due:g.deadline,done:false,buyerEditable:true}); s.rooms.unshift(entity);
      }
      const st = g.steps.find(x => x.id === stepId); st.status = 'completed'; st.entityId = entity.id;
      g.receipts.unshift({ id: id(), at: now(), action: step.title, detail: `Created ${entity.name}.`, entityId: entity.id });
    });
    return { success: true };
  } finally { busy.delete(goalId); }
}

export const server = createServer(async (req, res) => {
  const requestId=randomUUID(),started=Date.now();res.setHeader('X-Request-ID',requestId);res.on('finish',()=>{if(req.url.startsWith('/api/tender/'))logTenderRequest({type:'tender-request',requestId,method:req.method,path:req.url.split('?')[0],status:res.statusCode,durationMs:Date.now()-started,at:new Date().toISOString()});});
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const requestHost=new URL('http://'+(req.headers.host || 'invalid')).hostname;
    const validHosts=new Set(['localhost','127.0.0.1','[::1]',process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).hostname : '']);
    if(!validHosts.has(requestHost))throw new AppError('Unknown host.',403);
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new AppError('Origin not allowed.', 403);
    if (!['GET', 'HEAD'].includes(req.method) && !origin && !req.headers['x-workspace-client']) throw new AppError('Missing request origin.', 403);
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Workspace-Client, X-Tender-Session', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE' }); return res.end(); }
    const url = new URL(req.url, 'http://localhost'), p = url.pathname.split('/').filter(Boolean), method = req.method;
    if (p[0] !== 'api') {
      const candidate = resolve(frontend, '.' + url.pathname);
      if (!candidate.startsWith(frontend + sep) && candidate !== frontend) throw new AppError('Not found.', 404);
      let file = candidate;
      if (!extname(file)) file = resolve(frontend, 'index.html');
      try { const data = await readFile(file); res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); return res.end(data); }
      catch { throw new AppError('Build the frontend with npm run build, or start npm start.', 404); }
    }
    if(p[1]==='events' && p[2]==='experiments' && method==='POST')return send(res,200,await ingestOutcome(store,p[3],req.headers['x-experiment-key'],await body(req)));
    if (p[1] === 'public') {
      if(method==='PATCH' && p[3]==='milestones') {
        const b=await body(req); const info=await store.update(s=>{const r=publicFind(s,p[2]),m=r.milestones.find(x=>x.id===p[4]);if(!m||!m.buyerEditable)throw new AppError('This milestone is managed by the room owner.',403);if(typeof b.done!=='boolean')throw new AppError('Supply completion status.');m.done=b.done;m.completedBy=text(b.author,'Your name',100);m.completedAt=now();return {roomId:r.id,title:m.title,done:m.done,who:m.completedBy};});void growth.track(info.roomId,'milestone',`${info.done?'completed':'reopened'} milestone "${info.title}"`,info.who);return send(res,200,{success:true});
      }
      if (method === 'GET') {
        if(p[3]==='open'&&p[4]){const target=await store.update(s=>{const r=publicFind(s,p[2]),d=r.documents.find(x=>x.id===p[4]);if(!d)throw new AppError('Document not found.',404);return {roomId:r.id,url:d.url,title:d.title};});void growth.track(target.roomId,'document',`opened "${target.title}"`,url.searchParams.get('who')||'Buyer');res.writeHead(302,{Location:target.url,'Cache-Control':'no-store'});return res.end();}
        const room = await store.update(s => { const r = publicFind(s, p[2]); r.views++; return {...publicRoom(r),_id:r.id}; }); void growth.track(room._id,'view','opened the deal room'); delete room._id; return send(res, 200, room);
      }
      if (method === 'POST' && p[3] === 'questions') {
        const b = await body(req); await store.update(s => { const r = publicFind(s, p[2]); if (r.questions.length >= 100) throw new AppError('Question limit reached. Contact the room owner.'); r.questions.push({ id: id(), author: text(b.author, 'Your name', 100), question: text(b.question, 'Question', 2000), answer: '', at: now() }); return {roomId:r.id,author:b.author,question:b.question}; }).then(q=>{void growth.track(q.roomId,'question',`asked: "${String(q.question).slice(0,300)}"`,q.author);}); return send(res, 201, { success: true });
      }
      throw new AppError('Not found.', 404);
    }
    // Tender routes have their own session login and rate limits; the admin token gates the growth workspace.
    if(p[1]==='tender'){tenderApi??=createTenderApi(root);return await tenderApi.route(req,res,url,await body(req));}
    checkAdmin(req);
    if(p[1]==='connection' && method==='GET') {
      try {const response=await graph8Client().call('describe_current_key_me_get',{}),data=response.data||response;return send(res,200,{orgId:data.org_id,orgName:data.org_name,keyMode:data.key_mode,verifiedAt:now()});}
      catch (error) {throw graph8ConnectionError(error);}
    }
    if (p[1] === 'status' && method === 'GET') return send(res, 200, { configured: Boolean(process.env.G8_API_KEY), sdkVersion: '0.245.0', mode: process.env.G8_API_KEY ? 'Credentials configured · not yet verified' : 'Local workspace', storage: 'Server JSON file', auth: Boolean(process.env.ADMIN_TOKEN) });
    if (p[1] === 'workspace' && method === 'GET') { const s = store.read(); return send(res, 200, { ...s, experiments: s.experiments.map(e => ({ ...e, result: experimentResult(e) })) }); }
    if (p[1] === 'graph8' && method === 'GET') {
      try { const page=Number(url.searchParams.get('page')||1);if(!Number.isInteger(page)||page<1||page>10000)throw new AppError('Invalid page.');return send(res, 200, await graph8Read(p[2],page)); } catch (e) { if (e instanceof AppError) throw e; throw new AppError('Graph8 request failed. Check server credentials, scope and connection; no local data was changed.', 502); }
    }
    const b = await body(req);
    const grown=await growth.route({p,method,b,url});
    if(grown!==undefined)return send(res,200,grown);
    const extra=await featureRoute({store,p,method,b,url,busy});
    if(extra!==undefined)return send(res,200,extra);
    if (p[1] === 'rooms') {
      if (method === 'POST' && p.length === 2) { const room = createRoom(b); await store.update(s => s.rooms.unshift(room)); return send(res, 201, room); }
      await store.update(s => {
        const r = find(s, 'rooms', p[2]);
        if(r.archived)throw new AppError('Restore the room before changing it.',409);
        if (method === 'POST' && p[3] === 'share') { r.shareToken = b.enabled ? token() : null; r.shareExpiresAt = b.enabled ? new Date(Date.now() + 7 * 86400000).toISOString() : null; }
        else if (method === 'POST' && p[3] === 'milestones') r.milestones.push({ id: id(), title: text(b.title, 'Milestone'), owner: text(b.owner, 'Owner'), due: date(b.due), done: false, buyerEditable:b.buyerEditable===true });
        else if (method === 'PATCH' && p[3] === 'milestones') { const m = r.milestones.find(x => x.id === p[4]); if (!m) throw new AppError('Milestone not found.', 404); if (typeof b.done !== 'boolean') throw new AppError('Completion must be true or false.'); m.done = b.done; }
        else if (method === 'POST' && p[3] === 'documents') r.documents.push({ id: id(), title: text(b.title, 'Document title'), url: safeUrl(b.url) });
        else if (method === 'PATCH' && p[3] === 'questions') { const q = r.questions.find(x => x.id === p[4]); if (!q) throw new AppError('Question not found.', 404); q.answer = text(b.answer, 'Answer', 4000); }
        else throw new AppError('Unknown room action.', 404);
      }); return send(res, 200, { success: true });
    }
    if (p[1] === 'experiments') {
      if (method === 'POST' && p.length === 2) { const e = createExperiment(b); await store.update(s => s.experiments.unshift(e)); return send(res, 201, e); }
      await store.update(s => {
        const e = find(s, 'experiments', p[2]);
        if (method === 'POST' && p[3] === 'participants') {
          if (e.status !== 'draft') throw new AppError('Audience is locked after tracking starts. Clone the experiment for a new cohort.');
          if (!Array.isArray(b.contacts) || b.contacts.length > 1000) throw new AppError('Supply up to 1,000 contact identifiers.');
          for (const raw of b.contacts) { const contactId = text(raw, 'Contact identifier', 200); if (!e.participants.some(x => x.contactId === contactId)) e.participants.push({ contactId, variant: assignment(e.id, contactId), converted: null }); }
        } else if (method === 'PATCH' && p[3] === 'outcomes') {
          if (e.status !== 'running') throw new AppError('Start the experiment before recording outcomes.');
          const person = e.participants.find(x => x.contactId === b.contactId); if (!person) throw new AppError('Participant not found.', 404);
          if (typeof b.converted !== 'boolean' && b.converted !== null) throw new AppError('Choose success, no conversion or pending.'); person.converted = b.converted; person.outcomeAt=now();person.source='manual';refreshGoalProgress(s);
        } else if (method === 'PATCH' && p.length === 3) {
          if (b.status) {
            if (!({ draft: ['running'], running: ['completed'], completed: [] })[e.status].includes(b.status)) throw new AppError('Invalid experiment transition.');
            if (b.status === 'running' && e.participants.length < 2) throw new AppError('Assign at least two participants first.');
            if (b.status === 'completed' && e.participants.some(x => x.converted === null)) throw new AppError('Record outcomes for every participant before completing.');
            e.status = b.status;
          }
          if (b.lesson !== undefined) e.lesson = text(b.lesson, 'Learning', 4000);
          if (b.campaignA !== undefined || b.campaignB !== undefined) {
            if (e.status !== 'draft') throw new AppError('Link campaigns before starting.');
            e.campaignA = typeof b.campaignA === 'string' ? b.campaignA.slice(0,200) : e.campaignA;
            e.campaignB = typeof b.campaignB === 'string' ? b.campaignB.slice(0,200) : e.campaignB;
            if (e.campaignA && e.campaignA === e.campaignB) throw new AppError('Choose distinct campaigns for the variants.');
          }
        } else throw new AppError('Unknown experiment action.', 404);
      }); return send(res, 200, { success: true });
    }
    if (p[1] === 'goals') {
      if (method === 'POST' && p.length === 2) { const g = createGoal(b); await store.update(s => s.goals.unshift(g)); return send(res, 201, g); }
      if (method === 'POST' && p[3] === 'execute') return send(res, 200, await executeGoal(p[2], b.stepId, b.approved === true));
      if (method === 'PATCH' && p.length === 3) {
        if (busy.has(p[2])) throw new AppError('Wait for the running step before editing this goal.', 409);
        await store.update(s => {
          const g = find(s, 'goals', p[2]);
          if (b.status) { if (!({ draft: ['active'], active: ['paused', 'completed'], paused: ['active'], completed: [] })[g.status].includes(b.status)) throw new AppError('Invalid goal transition.'); if (b.status === 'completed' && g.achieved < g.target) throw new AppError('Record the target outcome before completing.'); g.status = b.status; }
          if (b.achieved !== undefined) {if(g.progressExperimentId)throw new AppError('Disconnect the experiment before reporting manual progress.'); if(g.status==='completed')throw new AppError('Completed goals are read-only.'); g.achieved = number(b.achieved, 'Achieved outcomes', 0, 1000000);}
        }); return send(res, 200, { success: true });
      }
    }
    throw new AppError('Not found.', 404);
  } catch (error) { send(res, error.status || 500, { error: error.status ? error.message : 'Could not complete the request. Check the server and try again.', requestId }); }
});
// Local automation only. External campaign creation always waits for an explicit review.
const scheduler=setInterval(async()=>{
  for(const g of store.read().goals){if(g.status!=='active'||!g.autopilotLocal||busy.has(g.id))continue;const step=g.steps.find(x=>x.status!=='completed');if(!step||step.action==='campaign')continue;try{await executeGoal(g.id,step.id,true);}catch{/* surfaced by goal state; no external retries */}}
},5000);
scheduler.unref();server.on('close',()=>clearInterval(scheduler));
server.listen(port, bindHost, () => console.log(`Graph8 Growth workspace: http://localhost:${port}`));
