import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Care plan (Shared Lifecycle Object 216):
//   need → goal → interventions → responsible → review date → reassessment →
//   continue / modify / achieved / ceased.
// A change never overwrites an item: the old one is SUPERSEDED and the new one links back
// to it, so the plan that was in force at any time can be shown. Everyone who can open the
// record reads the plan; roles with careplan.manage write and review it.

type Row = Record<string, string | number | null>;
export const RESPONSIBLE = ['All staff', 'Caregivers', 'Registered nurses', 'Doctors', 'Physiotherapy', 'Whānau with staff'];

const SELECT = `
  SELECT c.id, c.need, c.goal, c.intervention, c.responsible, c.review_date AS reviewDate, c.state, c.created_at AS createdAt,
         c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, a.display_name AS author, c.supersedes_id AS supersedesId,
         cb.display_name AS closedBy, c.closed_at AS closedAt, c.close_reason AS closeReason,
         (SELECT location FROM encounter e WHERE e.person_id = c.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location
    FROM care_plan_item c
    JOIN person p ON p.id = c.person_id
    LEFT JOIN workforce_person a ON a.id = c.author_id
    LEFT JOIN workforce_person cb ON cb.id = c.closed_by`;

function reviews(store: Store, itemId: string) {
  return store.all<Row>(
    `SELECT r.reviewed_at AS at, w.display_name AS by, r.outcome, r.evaluation, r.next_review AS nextReview
       FROM care_plan_review r JOIN workforce_person w ON w.id = r.reviewed_by WHERE r.item_id = ? ORDER BY r.reviewed_at DESC`, itemId,
  );
}

// Reviews of the items this item replaced carry forward, so the evaluation trail is unbroken.
function lineageReviews(store: Store, c: Row) {
  const out: Row[] = [];
  let cur: Row | undefined = c;
  let guard = 0;
  while (cur && guard++ < 20) {
    out.push(...reviews(store, String(cur.id)));
    cur = cur.supersedesId ? store.get<Row>('SELECT id, supersedes_id AS supersedesId FROM care_plan_item WHERE id = ?', cur.supersedesId) : undefined;
  }
  return out;
}

function shape(store: Store, c: Row, manage: boolean) {
  const due = c.state === 'ACTIVE' && c.reviewDate ? String(c.reviewDate) <= todayLocal() : false;
  return { ...c, due, overdue: due && String(c.reviewDate) < todayLocal(), canManage: manage && c.state === 'ACTIVE', reviews: lineageReviews(store, c), history: history(store, 'careplan', String(c.id)) };
}

const canManage = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'CAREPLAN', personId }).decision === 'ALLOW';

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = canManage(store, ctx, personId);
  const active = store.all<Row>(`${SELECT} WHERE c.person_id = ? AND c.state = 'ACTIVE' ORDER BY c.created_at`, personId);
  const past = store.all<Row>(`${SELECT} WHERE c.person_id = ? AND c.state IN ('ACHIEVED', 'CEASED') ORDER BY c.closed_at DESC LIMIT 20`, personId);
  return {
    items: active.map((r) => shape(store, r, manage)),
    past: past.map((r) => shape(store, r, false)),
    canManage: manage,
    responsible: RESPONSIBLE,
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'care_plan_item', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [216],
  });
}

type ItemInput = { need?: string; goal?: string; intervention?: string; responsible?: string; reviewDate?: string };
function clean(b: ItemInput) {
  const need = (b.need ?? '').trim().slice(0, 200);
  const goal = (b.goal ?? '').trim().slice(0, 500);
  const intervention = (b.intervention ?? '').trim().slice(0, 1500);
  if (need.length < 2) throw new HttpError(400, 'NEED_REQUIRED', 'Name the need.');
  if (goal.length < 3) throw new HttpError(400, 'GOAL_REQUIRED', 'Write the goal, in the person’s terms where possible.');
  if (intervention.length < 5) throw new HttpError(400, 'CARE_REQUIRED', 'Write the care that meets this need.');
  const responsible = RESPONSIBLE.includes(b.responsible ?? '') ? b.responsible! : 'All staff';
  const reviewDate = /^\d{4}-\d{2}-\d{2}$/.test(b.reviewDate ?? '') ? b.reviewDate! : null;
  if (!reviewDate) throw new HttpError(400, 'REVIEW_REQUIRED', 'Set a review date.');
  if (reviewDate < todayLocal()) throw new HttpError(400, 'INVALID_DATE', 'The review date cannot be in the past.');
  return { need, goal, intervention, responsible, reviewDate };
}

function serviceFor(store: Store, ctx: WorkContext, personId: string) {
  return store.get<{ service_id: string }>("SELECT service_id FROM encounter WHERE person_id = ? AND state = 'ACTIVE' ORDER BY started_at DESC LIMIT 1", personId)?.service_id ?? ctx.serviceId;
}

function insertItem(store: Store, ctx: WorkContext, personId: string, v: ReturnType<typeof clean>, supersedesId: string | null) {
  const id = newId();
  store.insert('care_plan_item', {
    id, person_id: personId, need: v.need, goal: v.goal, intervention: v.intervention, responsible: v.responsible, review_date: v.reviewDate,
    state: 'ACTIVE', created_at: now(), data_source: 'SHIFT', service_id: serviceFor(store, ctx, personId), author_id: ctx.workerId, supersedes_id: supersedesId,
  });
  recordInitial(store, 'careplan', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, supersedesId ? 'Plan changed' : `New need: ${v.need}`);
  return id;
}

export function add(store: Store, ctx: WorkContext, personId: string, b: ItemInput) {
  enforce(store, ctx, { op: 'CAREPLAN', personId }, personId);
  const v = clean(b);
  return store.tx(() => {
    const id = insertItem(store, ctx, personId, v, null);
    logged(store, ctx, 'CAREPLAN_ADD', personId, id, v.need);
    return { id };
  });
}

const load = (store: Store, id: string) => {
  const c = store.get<Row>(`${SELECT} WHERE c.id = ?`, id);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'That care plan item no longer exists.');
  return c;
};

// Reassessment: every review records an evaluation, then continues, modifies, or ends the item.
export function review(store: Store, ctx: WorkContext, id: string, b: ItemInput & { outcome?: string; evaluation?: string }) {
  const c = load(store, id);
  const personId = String(c.personId);
  enforce(store, ctx, { op: 'CAREPLAN', personId }, personId);
  if (c.state !== 'ACTIVE') throw new HttpError(409, 'NOT_ACTIVE', 'This care plan item is no longer active.');
  const evaluation = (b.evaluation ?? '').trim().slice(0, 1500);
  if (evaluation.length < 5) throw new HttpError(400, 'EVALUATION_REQUIRED', 'Write how the person is going against the goal.');
  const outcome = ['CONTINUE', 'MODIFIED', 'ACHIEVED', 'CEASED'].includes(b.outcome ?? '') ? b.outcome! : null;
  if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose the outcome of this review.');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  return store.tx(() => {
    let next: string | null = null;
    let current = id;
    if (outcome === 'CONTINUE') {
      next = /^\d{4}-\d{2}-\d{2}$/.test(b.reviewDate ?? '') ? b.reviewDate! : null;
      if (!next || next <= todayLocal()) throw new HttpError(400, 'REVIEW_REQUIRED', 'Set the next review date, after today.');
      store.run('UPDATE care_plan_item SET review_date = ? WHERE id = ?', next, id);
    } else if (outcome === 'MODIFIED') {
      const v = clean({ need: b.need ?? String(c.need), goal: b.goal, intervention: b.intervention, responsible: b.responsible, reviewDate: b.reviewDate });
      if (v.reviewDate <= todayLocal()) throw new HttpError(400, 'REVIEW_REQUIRED', 'Set the next review date, after today.');
      transition(store, 'careplan', id, 'SUPERSEDED', who, evaluation);
      store.run('UPDATE care_plan_item SET closed_by = ?, closed_at = ? WHERE id = ?', ctx.workerId, now(), id);
      current = insertItem(store, ctx, personId, v, id);
      next = v.reviewDate;
    } else {
      transition(store, 'careplan', id, outcome, who, evaluation);
      store.run('UPDATE care_plan_item SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), evaluation, id);
    }
    store.insert('care_plan_review', { id: newId(), item_id: id, reviewed_by: ctx.workerId, reviewed_at: now(), outcome, evaluation, next_review: next });
    logged(store, ctx, `CAREPLAN_${outcome}`, personId, id, evaluation);
    return { id: current, outcome };
  });
}

// Care plan reviews due in this service.
export function due(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('careplan.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include care planning`);
  const rows = store.all<Row>(
    `${SELECT} WHERE c.state = 'ACTIVE' AND c.review_date <= ? AND c.service_id = ?
       AND EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = c.person_id AND e.service_id = ? AND e.state = 'ACTIVE')
      ORDER BY c.review_date, p.family_name`,
    todayLocal(), ctx.serviceId, ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_CAREPLAN_REVIEWS', decision: 'ALLOW', outcome: 'VIEWED', engines: [216] });
  return rows.map((r) => shape(store, r, canManage(store, ctx, String(r.personId))));
}
