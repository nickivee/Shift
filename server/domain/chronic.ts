import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { STATES, REFS } from '../config/chronic.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Chronic care (matrix: Chronic Care tab for general practice): a long-term condition plan with goals, the next
// review date the clinician chooses, and each review. SHIFT sets no interval or standard (RR-CHRONIC-001).

type Row = Record<string, string | number | null>;
const LOG: Record<string, string> = { STARTED: 'Plan started', REVIEW: 'Review', ENDED: 'Plan ended', ERROR: 'Entered in error' };

const Q = `
  SELECT c.id, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, c.service_id AS serviceId, c.state, c.condition, c.goals,
         c.review_due AS reviewDue, c.last_reviewed_at AS lastReviewedAt, sb.display_name AS startedBy, c.started_at AS startedAt,
         eb.display_name AS endedBy, c.ended_at AS endedAt, c.ended_note AS endedNote
    FROM chronic_plan c
    JOIN person p ON p.id = c.person_id
    JOIN workforce_person sb ON sb.id = c.started_by
    LEFT JOIN workforce_person eb ON eb.id = c.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'CHRONIC', personId }).decision === 'ALLOW';
const dateOk = (v: unknown) => {
  const d = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < todayLocal() || d > addDays(todayLocal(), 365 * 3)) throw new HttpError(400, 'DATE', 'Choose the next review date, from today to three years ahead.');
  return d;
};

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'chronic', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('chronic_step', { id: newId(), plan_id: id, kind, body, by_id: ctx.workerId, at: now() });

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const active = state === 'ACTIVE';
  const today = todayLocal();
  const due = String(r.reviewDue);
  return {
    ...r, id, state, stateLabel: STATES[state], overdue: active && due < today, dueSoon: active && due >= today && due <= addDays(today, 30),
    actions: active && can && r.serviceId === ctx.serviceId ? ['review', 'end', 'error'] : [],
    log: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM chronic_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.plan_id = ? ORDER BY s.at, s.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'chronic', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That plan is no longer in SHIFT.');
  return r;
};

export function start(store: Store, ctx: WorkContext, personId: string, b: { condition?: string; goals?: string; reviewDue?: string }) {
  enforce(store, ctx, { op: 'CHRONIC', personId }, personId);
  const condition = text(b.condition, 300);
  if (condition.length < 3) throw new HttpError(400, 'CONDITION_REQUIRED', 'Say the condition, e.g. "Type 2 diabetes".');
  const goals = text(b.goals, 1000);
  if (goals.length < 5) throw new HttpError(400, 'GOALS_REQUIRED', 'Write the goals in your own words, e.g. "Keep blood sugar steady; check feet daily".');
  const due = dateOk(b.reviewDue);
  if (store.get("SELECT 1 FROM chronic_plan WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE' AND lower(condition) = lower(?)", personId, ctx.serviceId, condition)) {
    throw new HttpError(409, 'ALREADY_OPEN', 'This person already has an active plan for that condition in this service.');
  }
  const id = newId();
  store.tx(() => {
    store.insert('chronic_plan', { id, person_id: personId, service_id: ctx.serviceId, state: 'ACTIVE', condition, goals, review_due: due, started_by: ctx.workerId, started_at: now() });
    recordInitial(store, 'chronic', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, condition.slice(0, 200));
    addStep(store, ctx, id, 'STARTED', `${condition}. Goals: ${goals} Next review ${due}.`);
    logged(store, ctx, 'CHRONIC_START', personId, id, condition.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; reviewDue?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'CHRONIC', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that started this plan can record on it.');
  if (r.state !== 'ACTIVE') throw new HttpError(409, 'WRONG_STATE', `This plan is ${STATES[String(r.state)].toLowerCase()}.`);
  const note = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  if (action === 'review') {
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how the review went and what was decided, e.g. "Blood sugar steady; no change to medicines".');
    const due = dateOk(b.reviewDue);
    store.tx(() => {
      store.run('UPDATE chronic_plan SET last_reviewed_at = ?, review_due = ? WHERE id = ?', now(), due, id);
      addStep(store, ctx, id, 'REVIEW', `${note} Next review ${due}.`);
      logged(store, ctx, 'CHRONIC_REVIEW', personId, id, note.slice(0, 200));
    });
  } else if (action === 'end' || action === 'error') {
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', action === 'end' ? 'Say why the plan ends, e.g. "Condition resolved".' : 'Say why, e.g. "Recorded on the wrong person".');
    const to = action === 'end' ? 'ENDED' : 'ENTERED_IN_ERROR';
    store.tx(() => {
      transition(store, 'chronic', id, to, who, note.slice(0, 200));
      store.run('UPDATE chronic_plan SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
      addStep(store, ctx, id, action === 'end' ? 'ENDED' : 'ERROR', note);
      logged(store, ctx, action === 'end' ? 'CHRONIC_END' : 'CHRONIC_ERROR', personId, id, note.slice(0, 200));
    });
  } else {
    throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Chronic Care view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE c.person_id = ? AND c.service_id = ? ORDER BY c.started_at DESC`, personId, ctx.serviceId).map((r) => shape(store, ctx, r, can));
  return { active: all.filter((x) => x.state === 'ACTIVE'), past: all.filter((x) => x.state !== 'ACTIVE'), canRecord: can };
}

// Home → Chronic care: reviews overdue, due in the next 30 days, and the rest.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('chronic.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include chronic care`);
  const rows = store.all<Row>(`${Q} WHERE c.service_id = ? AND c.state = 'ACTIVE' ORDER BY c.review_due`, ctx.serviceId).map((r) => shape(store, ctx, r, false));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_CHRONIC', decision: 'ALLOW', outcome: 'VIEWED' });
  return { overdue: rows.filter((x) => x.overdue), soon: rows.filter((x) => x.dueSoon), later: rows.filter((x) => !x.overdue && !x.dueSoon) };
}
