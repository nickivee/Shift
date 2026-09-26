import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Monitoring plan (Shared Lifecycle Object 242):
//   requirement → parameter → method → frequency → limits or target → responsible →
//   monitoring events → result → review → action → continue / change / stop.
// Monitoring events are ordinary record entries made with the parameter's .key; the plan
// only says what is expected and shows whether it is happening. Limits and targets are
// what the clinician wrote. SHIFT displays them and never applies thresholds of its own.

type Row = Record<string, string | number | null>;
export const PARAMETERS: Record<string, { label: string; key: string; view: string }> = {
  OBS: { label: 'Observations', key: '.obs', view: 'obs' },
  BGL: { label: 'Blood glucose', key: '.bgl', view: 'bgl' },
  WEIGHT: { label: 'Weight', key: '.weight', view: 'weight' },
  PAIN: { label: 'Pain', key: '.pain', view: 'pain' },
  INTAKE: { label: 'Intake and output', key: '.intake', view: 'intake' },
};
const RESPONSIBLE = ['Registered nurses', 'Caregivers', 'All staff', 'Doctors'];
const OUTCOMES: Record<string, string> = { CONTINUE: 'Continue as planned', CHANGED: 'Changed', STOPPED: 'Stopped' };

const SELECT = `
  SELECT m.id, m.state, m.parameter, m.reason, m.method, m.frequency_hours AS frequency, m.limits, m.target, m.responsible,
         m.review_date AS reviewDate, m.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = m.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         m.service_id AS serviceId, s.name AS service, sb.display_name AS startedBy, m.started_at AS startedAt, m.supersedes_id AS supersedesId,
         cb.display_name AS closedBy, m.closed_at AS closedAt, m.close_reason AS closeReason
    FROM monitoring_plan m
    JOIN person p ON p.id = m.person_id
    JOIN service s ON s.id = m.service_id
    JOIN workforce_person sb ON sb.id = m.started_by
    LEFT JOIN workforce_person cb ON cb.id = m.closed_by`;

// The recorded entries for this parameter, newest first.
function events(store: Store, personId: string, parameter: string, limit = 5) {
  const p = PARAMETERS[parameter];
  return store.all<{ id: string; text: string; at: string; author: string | null }>(
    `SELECT e.id, e.rendered_text AS text, e.effective_at AS at, w.display_name AS author FROM clinical_event e
       LEFT JOIN workforce_person w ON w.id = e.author_id
      WHERE e.person_id = ? AND e.key_code = ? AND e.state = 'CURRENT' ORDER BY e.effective_at DESC LIMIT ?`, personId, p.key, limit,
  );
}

// Next due: one interval after the latest entry, or after the plan started if none since.
export function dueState(store: Store, m: Row) {
  const last = events(store, String(m.personId), String(m.parameter), 1)[0];
  const from = Math.max(Date.parse(String(m.startedAt)), last ? Date.parse(last.at) : 0);
  const due = new Date(from + Number(m.frequency) * 3_600_000);
  const ms = due.getTime() - Date.now();
  return { nextDue: due.toISOString(), status: ms < 0 ? 'OVERDUE' : ms < 3_600_000 ? 'DUE_SOON' : 'ON_TRACK' };
}

function reviews(store: Store, planId: string) {
  const out: Row[] = [];
  let id: string | null = planId;
  for (let guard = 0; id && guard < 20; guard++) {
    out.push(...store.all<Row>(
      `SELECT r.reviewed_at AS at, w.display_name AS by, r.outcome, r.finding, r.action FROM monitoring_review r
         JOIN workforce_person w ON w.id = r.reviewed_by WHERE r.plan_id = ? ORDER BY r.reviewed_at DESC`, id,
    ));
    id = store.get<{ s: string | null }>('SELECT supersedes_id AS s FROM monitoring_plan WHERE id = ?', id)?.s ?? null;
  }
  return out.map((r) => ({ ...r, outcomeLabel: OUTCOMES[String(r.outcome)] }));
}

function shape(store: Store, ctx: WorkContext, m: Row) {
  const p = PARAMETERS[String(m.parameter)];
  const plan = m.state === 'ACTIVE' && m.serviceId === ctx.serviceId && evaluate(store, ctx, { op: 'MONITORING_PLAN', personId: String(m.personId) }).decision === 'ALLOW';
  const canRecord = m.state === 'ACTIVE' && ctx.role.keys.includes(p.key) && ctx.role.views.includes(p.view);
  return {
    ...m, parameterLabel: p.label, view: p.view, ...(m.state === 'ACTIVE' ? dueState(store, m) : { nextDue: null, status: null }),
    reviewDue: m.state === 'ACTIVE' && m.reviewDate ? String(m.reviewDate) <= new Date().toLocaleDateString('en-CA') : false,
    recent: events(store, String(m.personId), String(m.parameter)), reviews: reviews(store, String(m.id)),
    canPlan: plan, canRecord, history: history(store, 'monitoring', String(m.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'monitoring_plan', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [42],
  });
}

const options = () => ({ parameters: Object.fromEntries(Object.entries(PARAMETERS).map(([k, v]) => [k, v.label])), responsible: RESPONSIBLE, outcomes: OUTCOMES });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const active = store.all<Row>(`${SELECT} WHERE m.person_id = ? AND m.state = 'ACTIVE' ORDER BY m.started_at`, personId);
  const past = store.all<Row>(`${SELECT} WHERE m.person_id = ? AND m.state = 'CEASED' ORDER BY m.closed_at DESC LIMIT 10`, personId);
  const canPlan = evaluate(store, ctx, { op: 'MONITORING_PLAN', personId }).decision === 'ALLOW';
  return { plans: active.map((m) => shape(store, ctx, m)), past: past.map((m) => shape(store, ctx, m)), canPlan, options: options() };
}

interface Fields { parameter?: string; reason?: string; method?: string; frequency?: string | number; limits?: string; target?: string; responsible?: string; reviewDate?: string }

function clean(b: Fields) {
  const parameter = String(b.parameter);
  if (!PARAMETERS[parameter]) throw new HttpError(400, 'PARAMETER_REQUIRED', 'Choose what to monitor.');
  const reason = (b.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why this monitoring is needed.');
  const frequency = Math.round(Number(b.frequency));
  if (!(frequency >= 1 && frequency <= 168)) throw new HttpError(400, 'FREQUENCY_REQUIRED', 'Choose how often, between every hour and once a week.');
  const responsible = RESPONSIBLE.includes(String(b.responsible)) ? String(b.responsible) : RESPONSIBLE[0];
  const reviewDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null;
  const t = (v?: string) => (v ?? '').trim().slice(0, 500) || null;
  return { parameter, reason, method: t(b.method), frequency_hours: frequency, limits: t(b.limits), target: t(b.target), responsible, review_date: reviewDate };
}

export function start(store: Store, ctx: WorkContext, personId: string, b: Fields) {
  enforce(store, ctx, { op: 'MONITORING_PLAN', personId }, personId);
  const v = clean(b);
  if (store.get("SELECT 1 FROM monitoring_plan WHERE person_id = ? AND service_id = ? AND parameter = ? AND state = 'ACTIVE'", personId, ctx.serviceId, v.parameter)) {
    throw new HttpError(409, 'ALREADY_ACTIVE', `${PARAMETERS[v.parameter].label} monitoring is already planned. Change that plan instead.`);
  }
  const id = newId();
  store.tx(() => {
    store.insert('monitoring_plan', { id, person_id: personId, service_id: ctx.serviceId, ...v, state: 'ACTIVE', started_by: ctx.workerId, started_at: now() });
    recordInitial(store, 'monitoring', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, `${PARAMETERS[v.parameter].label} every ${v.frequency_hours} h`);
    logged(store, ctx, 'MONITORING_START', personId, id, `${PARAMETERS[v.parameter].label} every ${v.frequency_hours} h`);
  });
  return { id };
}

const load = (store: Store, id: string) => {
  const m = store.get<Row>(`${SELECT} WHERE m.id = ?`, id);
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'That monitoring plan no longer exists.');
  return m;
};

// Review: what the monitoring shows, and what is being done. Changing the plan supersedes it
// with a new one that links back; stopping it ceases it.
export function review(store: Store, ctx: WorkContext, id: string, b: Fields & { outcome?: string; finding?: string; action?: string }) {
  const m = load(store, id);
  const personId = String(m.personId);
  if (m.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'This monitoring plan belongs to another service.');
  enforce(store, ctx, { op: 'MONITORING_PLAN', personId }, personId);
  if (m.state !== 'ACTIVE') throw new HttpError(409, 'NOT_ACTIVE', 'This monitoring plan is no longer active.');
  const outcome = String(b.outcome);
  if (!OUTCOMES[outcome]) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose continue, change or stop.');
  const finding = (b.finding ?? '').trim().slice(0, 1000);
  if (finding.length < 3) throw new HttpError(400, 'FINDING_REQUIRED', 'Write what the monitoring shows.');
  const action = (b.action ?? '').trim().slice(0, 1000) || null;
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  let result = id;
  store.tx(() => {
    store.insert('monitoring_review', { id: newId(), plan_id: id, reviewed_by: ctx.workerId, reviewed_at: now(), outcome, finding, action });
    if (outcome === 'CONTINUE') {
      const reviewDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null;
      store.run('UPDATE monitoring_plan SET review_date = ? WHERE id = ?', reviewDate, id);
    } else if (outcome === 'CHANGED') {
      const v = clean({ ...b, parameter: String(m.parameter) });
      transition(store, 'monitoring', id, 'SUPERSEDED', who, finding);
      store.run('UPDATE monitoring_plan SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), 'Changed', id);
      result = newId();
      store.insert('monitoring_plan', { id: result, person_id: personId, service_id: ctx.serviceId, ...v, state: 'ACTIVE', started_by: ctx.workerId, started_at: now(), supersedes_id: id });
      recordInitial(store, 'monitoring', result, 'ACTIVE', who, `Changed to every ${v.frequency_hours} h`);
    } else {
      transition(store, 'monitoring', id, 'CEASED', who, finding);
      store.run('UPDATE monitoring_plan SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), finding, id);
    }
    logged(store, ctx, `MONITORING_${outcome}`, personId, id, finding);
  });
  return shape(store, ctx, load(store, result));
}

// Home → Monitoring due: this service's active plans, most overdue first.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('monitoring.record') && !ctx.role.capabilities.includes('monitoring.plan')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include monitoring`);
  }
  const rows = store.all<Row>(`${SELECT} WHERE m.service_id = ? AND m.state = 'ACTIVE'`, ctx.serviceId).map((m) => shape(store, ctx, m));
  const rank = { OVERDUE: 0, DUE_SOON: 1, ON_TRACK: 2 } as Record<string, number>;
  rows.sort((a, b) => rank[String(a.status)] - rank[String(b.status)] || String(a.nextDue).localeCompare(String(b.nextDue)));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_MONITORING', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return { plans: rows, options: options() };
}

// For the alert engine: this service's plans that are overdue now.
export function overdue(store: Store, serviceId: string) {
  return store.all<Row>(`${SELECT} WHERE m.service_id = ? AND m.state = 'ACTIVE'`, serviceId)
    .map((m) => ({ m, d: dueState(store, m) }))
    .filter((x) => x.d.status === 'OVERDUE')
    .map(({ m }) => ({ personId: String(m.personId), objectId: String(m.id), title: `${PARAMETERS[String(m.parameter)].label} overdue`, detail: `Planned every ${m.frequency} hours by ${String(m.responsible).toLowerCase()}` }));
}
