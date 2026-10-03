import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ruleValue, requireRule } from './rulevalue.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { STATES, REFS } from '../config/visits.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Visits (matrix: Visits tab for district nursing and hospice): a visit to a person where they are is
// planned for a day and time, then recorded as done, not done with a reason, or cancelled. It can be
// moved while it is still planned. SHIFT sets no visit frequency or response time (RR-VISITS-001).

type Row = Record<string, string | number | null>;
type Reason = { code: string; label: string };
const LOG: Record<string, string> = { PLANNED: 'Planned', MOVED: 'Moved', DONE: 'Done', NOT_DONE: 'Not done', CANCELLED: 'Cancelled' };

const Q = `
  SELECT v.id, v.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, v.service_id AS serviceId, v.state, v.planned_for AS plannedFor,
         v.purpose, v.place, v.assigned_to AS assignedToId, aw.display_name AS assignedTo, pb.display_name AS plannedBy, v.planned_at AS plannedAt,
         eb.display_name AS endedBy, v.ended_at AS endedAt, v.ended_reason AS endedReason, v.ended_note AS endedNote
    FROM visit v
    JOIN person p ON p.id = v.person_id
    JOIN workforce_person pb ON pb.id = v.planned_by
    LEFT JOIN workforce_person aw ON aw.id = v.assigned_to
    LEFT JOIN workforce_person eb ON eb.id = v.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: 'visit.plan' | 'visit.record') =>
  evaluate(store, ctx, { op: 'VISIT', personId, cap }).decision === 'ALLOW';
const dayOf = (iso: string) => todayLocal(new Date(iso));

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'visit', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('visit_step', { id: newId(), visit_id: id, kind, body, by_id: ctx.workerId, at: now() });

const reasons = (store: Store, ctx: WorkContext) => (ctx.organisationId ? ruleValue<Reason[]>(store, ctx.organisationId, 'visit.not_done_reasons') ?? [] : []);

// Colleagues in this service who record visits, for "who is going".
function goers(store: Store, ctx: WorkContext) {
  const today = todayLocal();
  const roles = new Set([...ROLE_BY_KEY.values()].filter((r) => r.capabilities.includes('visit.record')).map((r) => r.roleKey));
  const seen = new Set<string>();
  return store.all<{ id: string; name: string; roleKey: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name, pos.role_key AS roleKey FROM position pos JOIN employment em ON em.id = pos.employment_id JOIN workforce_person w ON w.id = em.workforce_person_id
      WHERE pos.service_id = ? AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE' ORDER BY w.display_name`, ctx.serviceId, today, today)
    .filter((r) => roles.has(r.roleKey) && !seen.has(r.id) && seen.add(r.id)).map((r) => ({ id: r.id, name: r.name }));
}

function shape(store: Store, ctx: WorkContext, r: Row, canRecord: boolean, canPlan: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const planned = state === 'PLANNED';
  const at = String(r.plannedFor);
  const actions: string[] = [];
  if (planned && canRecord) actions.push('done', 'notdone');
  if (planned && canPlan) actions.push('reschedule', 'cancel');
  const labels = Object.fromEntries(reasons(store, ctx).map((x) => [x.code, x.label]));
  return {
    ...r, id, state, stateLabel: STATES[state], day: dayOf(at), overdue: planned && new Date(at).getTime() < Date.now(),
    endedReasonLabel: r.endedReason ? labels[String(r.endedReason)] ?? String(r.endedReason) : null,
    actions,
    log: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM visit_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.visit_id = ? ORDER BY s.at, s.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'visit', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE v.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That visit is no longer in SHIFT.');
  return r;
};

const when = (v: unknown) => {
  const t = Date.parse(String(v ?? ''));
  if (Number.isNaN(t) || t < Date.now() - 86_400_000 || t > Date.now() + 365 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose the day and time of the visit, from today to a year ahead.');
  return new Date(t).toISOString();
};

export function plan(store: Store, ctx: WorkContext, personId: string, b: { when?: string; purpose?: string; place?: string; assignedTo?: string }) {
  enforce(store, ctx, { op: 'VISIT', personId, cap: 'visit.plan' }, personId);
  const at = when(b.when);
  const purpose = text(b.purpose, 300);
  if (purpose.length < 3) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Say what the visit is for, e.g. "Wound dressing change".');
  const place = text(b.place, 300);
  if (place.length < 3) throw new HttpError(400, 'PLACE_REQUIRED', 'Say where, e.g. "At home, 14 Rata Street".');
  const assignedTo = text(b.assignedTo, 80);
  if (assignedTo && !goers(store, ctx).some((g) => g.id === assignedTo)) throw new HttpError(400, 'GOER_UNKNOWN', 'Choose someone in this service who records visits.');
  const id = newId();
  store.tx(() => {
    store.insert('visit', { id, person_id: personId, service_id: ctx.serviceId, state: 'PLANNED', planned_for: at, purpose, place, assigned_to: assignedTo || null, planned_by: ctx.workerId, planned_at: now() });
    recordInitial(store, 'visit', id, 'PLANNED', { actorId: ctx.workerId, workContextId: ctx.id }, purpose.slice(0, 200));
    addStep(store, ctx, id, 'PLANNED', `${purpose}. ${place}.`);
    logged(store, ctx, 'VISIT_PLAN', personId, id, purpose.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; reason?: string; when?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const cap = action === 'reschedule' || action === 'cancel' ? 'visit.plan' : 'visit.record';
  enforce(store, ctx, { op: 'VISIT', personId, cap }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that planned this visit can record it.');
  if (r.state !== 'PLANNED') throw new HttpError(409, 'WRONG_STATE', `This visit is ${STATES[String(r.state)].toLowerCase()}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const end = (to: string, kind: string, body: string, reason: string | null) => store.tx(() => {
    transition(store, 'visit', id, to, who, body.slice(0, 200));
    store.run('UPDATE visit SET ended_by = ?, ended_at = ?, ended_reason = ?, ended_note = ? WHERE id = ?', ctx.workerId, now(), reason, note || null, id);
    addStep(store, ctx, id, kind, body);
    logged(store, ctx, `VISIT_${kind}`, personId, id, body.slice(0, 200));
  });
  switch (action) {
    case 'done':
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what was done and how they were, e.g. "Dressing changed; wound clean and dry".');
      end('DONE', 'DONE', note, null);
      break;
    case 'notdone': {
      const list = ctx.organisationId ? requireRule<Reason[]>(store, ctx.organisationId, 'visit.not_done_reasons') : [];
      const reason = list.find((x) => x.code === b.reason);
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why the visit was not done.');
      if (reason.code === 'OTHER' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why the visit was not done.');
      end('NOT_DONE', 'NOT_DONE', `${reason.label}.${note ? ` ${note}` : ''}`, reason.code);
      break;
    }
    case 'cancel':
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why the visit is no longer needed.');
      end('CANCELLED', 'CANCELLED', note, null);
      break;
    case 'reschedule': {
      const at = when(b.when);
      store.tx(() => {
        store.run('UPDATE visit SET planned_for = ? WHERE id = ?', at, id);
        const body = `Moved from ${String(r.plannedFor).slice(0, 16).replace('T', ' ')} to ${at.slice(0, 16).replace('T', ' ')} (UTC).${note ? ` ${note}` : ''}`;
        addStep(store, ctx, id, 'MOVED', body);
        logged(store, ctx, 'VISIT_MOVED', personId, id, body.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Visits view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canPlan = may(store, ctx, personId, 'visit.plan');
  const canRecord = may(store, ctx, personId, 'visit.record');
  const all = store.all<Row>(`${Q} WHERE v.person_id = ? AND v.service_id = ? ORDER BY v.planned_for`, personId, ctx.serviceId).map((r) => shape(store, ctx, r, canRecord, canPlan));
  return {
    planned: all.filter((x) => x.state === 'PLANNED'),
    ended: all.filter((x) => x.state !== 'PLANNED').reverse(),
    canPlan,
    options: { goers: canPlan ? goers(store, ctx) : [], reasons: reasons(store, ctx) },
  };
}

// Home → Visits: this service's planned visits, and those done in the last week.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('visit.record') && !ctx.role.capabilities.includes('visit.plan')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include visits`);
  }
  const today = todayLocal();
  const week = addDays(today, 7);
  const rows = store.all<Row>(`${Q} WHERE v.service_id = ? AND (v.state = 'PLANNED' OR v.ended_at >= ?) ORDER BY v.planned_for`, ctx.serviceId, `${addDays(today, -7)}T00:00:00.000Z`)
    .map((r) => shape(store, ctx, r, true, ctx.role.capabilities.includes('visit.plan')));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_VISITS', decision: 'ALLOW', outcome: 'VIEWED' });
  const open = rows.filter((x) => x.state === 'PLANNED');
  return {
    overdue: open.filter((x) => x.overdue),
    today: open.filter((x) => !x.overdue && x.day === today),
    coming: open.filter((x) => x.day > today && x.day <= week),
    later: open.filter((x) => x.day > week),
    recent: rows.filter((x) => x.state !== 'PLANNED').reverse(),
  };
}
