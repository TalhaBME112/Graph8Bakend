import { createHash, randomUUID } from 'node:crypto';

export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function text(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${name} is required (up to ${max} characters).`);
  return value.trim();
}
export function number(value, name, min = 0, max = 1000000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new AppError(`${name} must be between ${min} and ${max}.`);
  return value;
}
export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new AppError('Choose a valid date.');
  return value;
}
export function safeUrl(value) {
  let url;try{url=new URL(text(value, 'Document URL', 2000));}catch{throw new AppError('Enter a valid HTTPS document link.');}
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError('Documents require an HTTPS URL without credentials.');
  return url.href;
}
export function assignment(experimentId, contactId) {
  return createHash('sha256').update(`${experimentId}:${contactId}`).digest()[0] % 2 === 0 ? 'A' : 'B';
}
export function experimentResult(experiment) {
  const counts = { A: { enrolled: 0, observed: 0, converted: 0 }, B: { enrolled: 0, observed: 0, converted: 0 } };
  for (const p of experiment.participants) {
    counts[p.variant].enrolled++;
    if (typeof p.converted === 'boolean') { counts[p.variant].observed++; if (p.converted) counts[p.variant].converted++; }
  }
  const interval = ({ observed: n, converted: x }) => {
    if (!n) return { rate: 0, low: 0, high: 1 };
    const z = 1.96, p = x / n, d = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return { rate: p, low: center - half, high: center + half };
  };
  const A = { ...counts.A, ...interval(counts.A) }, B = { ...counts.B, ...interval(counts.B) };
  let verdict = 'Collect outcomes for both variants.';
  if (A.observed || B.observed) verdict = 'Directional results only. Finish the experiment before deciding.';
  if (experiment.status === 'completed') {
    verdict = 'Inconclusive. Keep the hypothesis open.';
    if (Math.min(A.observed, B.observed) >= experiment.minimum && A.observed === A.enrolled && B.observed === B.enrolled) {
      if (A.low > B.high) verdict = 'Variant A leads with non-overlapping 95% Wilson intervals.';
      if (B.low > A.high) verdict = 'Variant B leads with non-overlapping 95% Wilson intervals.';
    }
  }
  return { A, B, verdict };
}
export function createRoom(body) {
  return { id: id(), name: text(body.name, 'Room name'), company: text(body.company, 'Company'), summary: text(body.summary, 'Summary', 4000), dealId: body.dealId || '', createdAt: now(), milestones: [], documents: [], questions: [], shareToken: null, shareExpiresAt: null, views: 0 };
}
export function createExperiment(body) {
  const minimum = number(body.minimum ?? 30, 'Minimum outcomes per variant', 30, 100000);
  if (!Number.isInteger(minimum)) throw new AppError('Minimum sample size must be a whole number.');
  return { id: id(), name: text(body.name, 'Experiment name'), hypothesis: text(body.hypothesis, 'Hypothesis', 2000), metric: text(body.metric, 'Success metric'), variantA: text(body.variantA, 'Variant A'), variantB: text(body.variantB, 'Variant B'), minimum, status: 'draft', participants: [], campaignA: '', campaignB: '', lesson: '', createdAt: now() };
}
export function createGoal(body) {
  const target = number(body.target, 'Target', 1, 100000);
  if (!Number.isInteger(target)) throw new AppError('Target must be a whole number.');
  return { id: id(), name: text(body.name, 'Goal'), audience: text(body.audience, 'Audience', 2000), target, metric: text(body.metric, 'Metric'), budget: number(body.budget, 'Planning budget', 0, 1000000), deadline: date(body.deadline), achieved: 0, status: 'draft', createdAt: now(), receipts: [], steps: [
    { id: id(), title: 'Create a learning experiment', detail: 'Compare a problem-led message with an outcome-led message.', action: 'experiment', status: 'pending' },
    { id: id(), title: 'Prepare a buyer room', detail: 'Create a reusable room and mutual action plan for this audience.', action: 'room', status: 'pending' },
    { id: id(), title: 'Create a Graph8 campaign draft', detail: 'Creates one real campaign with document generation disabled. Does not launch outreach.', action: 'campaign', status: 'pending' },
  ] };
}
export function publicRoom(room) {
  return { id: room.id, name: room.name, company: room.company, summary: room.summary, milestones: room.milestones.map(({id,title,owner,due,done,buyerEditable,why,completedBy})=>({id,title,owner,due,done,buyerEditable,why,completedBy})), documents: room.documents, questions: room.questions, faq: room.faq || [], proposal: room.intel ? { amount: room.intel.deal?.amount, currency: room.intel.deal?.currency, lineItems: room.intel.lineItems || [], quotes: (room.intel.quotes || []).filter(q => q.url).map(({ title, number, status, total, currency, url }) => ({ title, number, status, total, currency, url })) } : null };
}
