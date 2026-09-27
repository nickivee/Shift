import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ROLES, ROLE_BY_KEY } from '../config/workstations.ts';
import { SOURCES, PRIORITIES, DEFER_REASONS, OUTCOMES } from '../config/requirements.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Requirement (the requirement lifecycle listed under Shared Lifecycle Object 278):
//   requirement generated → pending → assigned → actioned OR deferred OR cancelled → outcome → closed.
// A requirement is something a service has to do for a person. It is generated when the
// service accepts a recommendation, or added by the team. It waits until someone takes it or a
// senior assigns it; the person assigned accepts it before working on it, because
// responsibility is never taken on silently. It is then actioned, deferred to a date with a
// reason, or cancelled. Whoever actioned it, or a senior, records the outcome, which closes it.

type Row = Record<string, string | number | null>;
type Cap = 'requirement.record' | 'requirement.manage';
const STATES: Record<string, string> = {
  PENDING: 'Waiting to be assigned', ASSIGNED: 'Assigned', ACTIONED: 'Actioned', DEFERRED: 'Deferred', CANCELLED: 'Cancelled',
  CLOSED: 'Closed', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  GENERATED: 'Generated', ASSIGNED: 'Assigned', ACCEPTED: 'Accepted', RELEASED: 'Handed back', ACTIONED: 'Actioned', DEFERRED: 'Deferred',
  RESUMED: 'Deferral ended', CANCELLED: 'Cancelled', CLOSED: 'Outcome recorded', ERROR: 'Entered in error',
};
const OPEN = ['PENDING', 'ASSIGNED', 'ACTIONED', 'DEFERRED', 'CANCELLED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-REQ-001'];

const Q = `
  SELECT q.id, q.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = q.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         q.service_id AS serviceId, s.name AS service, q.state, q.what, q.detail, q.priority, q.due_by AS dueBy,
         q.source, q.source_id AS sourceId, q.source_label AS sourceLabel, gb.display_name AS generatedBy, q.generated_by AS generatedById, q.generated_at AS generatedAt,
         q.assigned_to AS assignedToId, aw.display_name AS assignedTo, ab.display_name AS assignedBy, q.assigned_at AS assignedAt, q.accepted_at AS acceptedAt,
         q.actioned_by AS actionedById, xb.display_name AS actionedBy, q.actioned_at AS actionedAt, q.action_note AS actionNote,
         q.deferred_until AS deferredUntil, q.defer_reason AS deferReason, q.ended_note AS endedNote,
         q.outcome, q.outcome_note AS outcomeNote, cb.display_name AS closedBy, q.closed_at AS closedAt
    FROM requirement q
    JOIN person p ON p.id = q.person_id
    JOIN service s ON s.id = q.service_id
    JOIN workforce_person gb ON gb.id = q.generated_by
    LEFT JOIN workforce_person aw ON aw.id = q.assigned_to
    LEFT JOIN workforce_person ab ON ab.id = q.assigned_by
    LEFT JOIN workforce_person xb ON xb.id = q.actioned_by
    LEFT JOIN workforce_person cb ON cb.id = q.closed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'REQUIREMENT', personId, cap }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'requirement', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, byId: string, id: string, kind: string, body: string) =>
  store.insert('requirement_log', { id: newId(), requirement_id: id, kind, body, by_id: byId, at: now() });

// Colleagues who can be assigned a requirement: a current position in this service, in a role
// that records requirements.
export function colleagues(store: Store, ctx: WorkContext) {
  const roles = ROLES.filter((r) => r.capabilities.includes('requirement.record')).map((r) => r.roleKey);
  const today = todayLocal();
  const rows = store.all<{ id: string; name: string; roleKey: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name, pos.role_key AS roleKey FROM position pos JOIN employment em ON em.id = pos.employment_id
       JOIN workforce_person w ON w.id = em.workforce_person_id
      WHERE pos.service_id = ? AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE'
      ORDER BY w.display_name`, ctx.serviceId, today, today);
  const seen = new Set<string>();
  return rows.filter((r) => roles.includes(r.roleKey) && !seen.has(r.id) && seen.add(r.id))
    .map((r) => ({ id: r.id, label: `${r.id === ctx.workerId ? 'You' : r.name} (${ROLE_BY_KEY.get(r.roleKey)?.label ?? r.roleKey})` }));
}

// A requirement generated by another object (an accepted recommendation). The caller has
// already checked authority for that object and runs inside its transaction.
export function generate(store: Store, ctx: WorkContext, g: {
  personId: string; serviceId: string; what: string; source: string; sourceId: string | null; sourceLabel: string; dueBy: string | null; priority?: string;
}) {
  const id = newId();
  store.insert('requirement', {
    id, person_id: g.personId, service_id: g.serviceId, state: 'PENDING', what: g.what, detail: null, priority: g.priority ?? 'ROUTINE',
    due_by: g.dueBy, source: g.source, source_id: g.sourceId, source_label: g.sourceLabel, generated_by: ctx.workerId, generated_at: now(),
  });
  recordInitial(store, 'requirement', id, 'PENDING', { actorId: ctx.workerId, workContextId: ctx.id }, g.what.slice(0, 200));
  addLog(store, ctx.workerId, id, 'GENERATED', `${g.what}. From ${g.sourceLabel}.`);
  logged(store, ctx, 'REQUIREMENT_GENERATE', g.personId, id, g.what.slice(0, 200));
  return id;
}

function shape(store: Store, ctx: WorkContext, r: Row, can: { record: boolean; manage: boolean }) {
  const id = String(r.id);
  const state = String(r.state);
  const here = ctx.serviceId === r.serviceId;
  const mine = r.assignedToId === ctx.workerId;
  const accepted = !!r.acceptedAt;
  const today = todayLocal();
  const actions: string[] = [];
  if (here && can.record) {
    if (state === 'PENDING') actions.push('take');
    if (state === 'ASSIGNED' && mine && !accepted) actions.push('accept');
    if (state === 'ASSIGNED' && mine && accepted) actions.push('action');
    if (can.manage && ['PENDING', 'ASSIGNED', 'DEFERRED'].includes(state)) actions.push('assign');
    if (state === 'ASSIGNED' && mine) actions.push('release');
    if (['PENDING', 'ASSIGNED'].includes(state) && (can.manage || mine)) actions.push('defer');
    if (state === 'DEFERRED') actions.push('resume');
    if (['ACTIONED', 'CANCELLED', 'DEFERRED'].includes(state) && (can.manage || r.actionedById === ctx.workerId)) actions.push('close');
    if (can.manage && ['PENDING', 'ASSIGNED', 'DEFERRED'].includes(state)) actions.push('cancel');
    if (OPEN.includes(state) && (can.manage || r.generatedById === ctx.workerId)) actions.push('error');
  }
  return {
    ...r, id, state, stateLabel: state === 'ASSIGNED' && !accepted ? 'Assigned, not yet accepted' : STATES[state],
    priorityLabel: PRIORITIES[String(r.priority)] ?? String(r.priority), sourceKind: SOURCES[String(r.source)] ?? String(r.source),
    deferReasonLabel: r.deferReason ? DEFER_REASONS[String(r.deferReason)] ?? String(r.deferReason) : null,
    outcomeLabel: r.outcome ? OUTCOMES[String(r.outcome)] ?? String(r.outcome) : null,
    mine, accepted,
    overdue: ['PENDING', 'ASSIGNED'].includes(state) && !!r.dueBy && String(r.dueBy) < today,
    deferralEnded: state === 'DEFERRED' && !!r.deferredUntil && String(r.deferredUntil) <= today,
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM requirement_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.requirement_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'requirement', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE q.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That requirement is no longer in SHIFT.');
  return r;
};

export function add(store: Store, ctx: WorkContext, personId: string, b: { what?: string; detail?: string; priority?: string; dueBy?: string; from?: string }) {
  enforce(store, ctx, { op: 'REQUIREMENT', personId, cap: 'requirement.record' }, personId);
  const what = text(b.what, 500);
  if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what needs doing, e.g. "Organise a hoist assessment before discharge".');
  const priority = PRIORITIES[String(b.priority)] ? String(b.priority) : '';
  if (!priority) throw new HttpError(400, 'PRIORITY', 'Choose how soon it is needed.');
  const dueBy = date(b.dueBy);
  if (b.dueBy && (!dueBy || dueBy < todayLocal())) throw new HttpError(400, 'DATE', 'The date must be today or later.');
  const from = text(b.from, 200);
  store.tx(() => {
    const id = generate(store, ctx, { personId, serviceId: ctx.serviceId, what, source: 'MANUAL', sourceId: null, sourceLabel: from || `${ctx.role.label}, added directly`, dueBy: dueBy || null, priority });
    const detail = text(b.detail, 1000);
    if (detail) store.run('UPDATE requirement SET detail = ? WHERE id = ?', detail, id);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; to?: string; until?: string; reason?: string; outcome?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const cap: Cap = ['assign', 'cancel'].includes(action) ? 'requirement.manage' : 'requirement.record';
  enforce(store, ctx, { op: 'REQUIREMENT', personId, cap }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This requirement belongs to ${r.service}.`);
  const manager = may(store, ctx, personId, 'requirement.manage');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const mine = r.assignedToId === ctx.workerId;
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This requirement is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const assigneeOnly = () => { if (!mine) throw new HttpError(403, 'BLOCK', `This requirement is assigned to ${r.assignedTo}.`); };
  const step = (to: string | null, kind: string, body: string, update?: [string, ...unknown[]]) => store.tx(() => {
    if (to) transition(store, 'requirement', id, to, who, body.slice(0, 200));
    if (update) store.run(update[0], ...(update.slice(1) as (string | null)[]));
    addLog(store, ctx.workerId, id, kind, body);
    logged(store, ctx, `REQUIREMENT_${kind}`, personId, id, body.slice(0, 200));
  });
  switch (action) {
    case 'take':
      inState('PENDING');
      step('ASSIGNED', 'ASSIGNED', `${ctx.displayName} took it on.`,
        ['UPDATE requirement SET assigned_to = ?, assigned_by = ?, assigned_at = ?, accepted_at = ? WHERE id = ?', ctx.workerId, ctx.workerId, at, at, id]);
      break;
    case 'assign': {
      inState('PENDING', 'ASSIGNED', 'DEFERRED');
      const to = colleagues(store, ctx).find((c) => c.id === b.to);
      if (!to) throw new HttpError(400, 'ASSIGNEE_REQUIRED', 'Choose who to assign it to.');
      if (to.id === r.assignedToId && state === 'ASSIGNED') throw new HttpError(409, 'SAME', 'It is already assigned to them.');
      const self = to.id === ctx.workerId;
      step('ASSIGNED', 'ASSIGNED', `Assigned to ${to.label}${self ? '' : '; waiting for them to accept'}.${note ? ` ${note}` : ''}`,
        ['UPDATE requirement SET assigned_to = ?, assigned_by = ?, assigned_at = ?, accepted_at = ?, deferred_until = NULL, defer_reason = NULL WHERE id = ?', to.id, ctx.workerId, at, self ? at : null, id]);
      break;
    }
    case 'accept':
      inState('ASSIGNED');
      assigneeOnly();
      if (r.acceptedAt) throw new HttpError(409, 'ALREADY', 'You have already accepted it.');
      step(null, 'ACCEPTED', note || 'Accepted.', ['UPDATE requirement SET accepted_at = ? WHERE id = ?', at, id]);
      break;
    case 'release':
      inState('ASSIGNED');
      assigneeOnly();
      need(5, 'Say why you are handing it back, e.g. "Going off shift; not started".');
      step('PENDING', 'RELEASED', note, ['UPDATE requirement SET assigned_to = NULL, assigned_by = NULL, assigned_at = NULL, accepted_at = NULL WHERE id = ?', id]);
      break;
    case 'action':
      inState('ASSIGNED');
      assigneeOnly();
      if (!r.acceptedAt) throw new HttpError(409, 'ACCEPT_FIRST', 'Accept it before recording that it was done.');
      need(5, 'Say what was done, e.g. "Hoist assessment booked with OT for Thursday".');
      step('ACTIONED', 'ACTIONED', note, ['UPDATE requirement SET actioned_by = ?, actioned_at = ?, action_note = ? WHERE id = ?', ctx.workerId, at, note, id]);
      break;
    case 'defer': {
      inState('PENDING', 'ASSIGNED');
      if (!manager && !mine) throw new HttpError(403, 'BLOCK', 'Only the person it is assigned to, or a senior, can defer it.');
      const reason = DEFER_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it is being deferred.');
      const until = date(b.until);
      if (!until || until < todayLocal()) throw new HttpError(400, 'DATE', 'Choose the date to come back to it, today or later.');
      need(5, 'Say what is happening in the meantime.');
      step('DEFERRED', 'DEFERRED', `Until ${until}. ${DEFER_REASONS[reason]}. ${note}`,
        ['UPDATE requirement SET deferred_until = ?, defer_reason = ?, assigned_to = NULL, assigned_by = NULL, assigned_at = NULL, accepted_at = NULL WHERE id = ?', until, reason, id]);
      break;
    }
    case 'resume':
      inState('DEFERRED');
      step('PENDING', 'RESUMED', note || 'Back on the list to be assigned.', ['UPDATE requirement SET deferred_until = NULL, defer_reason = NULL WHERE id = ?', id]);
      break;
    case 'cancel':
      inState('PENDING', 'ASSIGNED', 'DEFERRED');
      need(5, 'Say why it is no longer needed.');
      step('CANCELLED', 'CANCELLED', note, ['UPDATE requirement SET ended_note = ? WHERE id = ?', note, id]);
      break;
    case 'close': {
      inState('ACTIONED', 'CANCELLED', 'DEFERRED');
      if (!manager && r.actionedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only whoever actioned it, or a senior, can record the outcome.');
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose the outcome.');
      if (outcome !== 'MET') need(5, 'Say what the outcome was.');
      step('CLOSED', 'CLOSED', `${OUTCOMES[outcome]}.${note ? ` ${note}` : ''}`,
        ['UPDATE requirement SET outcome = ?, outcome_note = ?, closed_by = ?, closed_at = ? WHERE id = ?', outcome, note || null, ctx.workerId, at, id]);
      break;
    }
    case 'error':
      inState(...OPEN);
      if (!manager && r.generatedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only whoever added it, or a senior, can mark it entered in error.');
      need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".');
      step('ENTERED_IN_ERROR', 'ERROR', note, ['UPDATE requirement SET ended_note = ? WHERE id = ?', note, id]);
      break;
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Requirements view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = { record: may(store, ctx, personId, 'requirement.record'), manage: may(store, ctx, personId, 'requirement.manage') };
  const all = store.all<Row>(`${Q} WHERE q.person_id = ? ORDER BY CASE q.priority WHEN 'URGENT' THEN 0 WHEN 'TODAY' THEN 1 ELSE 2 END, q.due_by IS NULL, q.due_by, q.generated_at`, personId)
    .map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canAdd: can.record,
    options: { colleagues: can.manage ? colleagues(store, ctx) : [], priorities: PRIORITIES, deferReasons: DEFER_REASONS, outcomes: OUTCOMES },
  };
}

// Home → Requirements for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('requirement.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include requirements`);
  const can = { record: true, manage: ctx.role.capabilities.includes('requirement.manage') };
  const rows = store.all<Row>(`${Q} WHERE q.service_id = ? AND q.state IN ('PENDING', 'ASSIGNED', 'ACTIONED', 'DEFERRED', 'CANCELLED')
      ORDER BY CASE q.priority WHEN 'URGENT' THEN 0 WHEN 'TODAY' THEN 1 ELSE 2 END, q.due_by IS NULL, q.due_by, q.generated_at`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, can));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_REQUIREMENTS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    mine: rows.filter((r) => r.state === 'ASSIGNED' && r.mine),
    toAssign: rows.filter((r) => r.state === 'PENDING'),
    others: rows.filter((r) => r.state === 'ASSIGNED' && !r.mine),
    deferred: rows.filter((r) => r.state === 'DEFERRED'),
    toClose: rows.filter((r) => ['ACTIONED', 'CANCELLED'].includes(r.state) && r.actions.includes('close')),
  };
}
