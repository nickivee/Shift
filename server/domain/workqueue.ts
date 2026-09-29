import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { audit } from './audit.ts';
import { enforce } from './record.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { LADDERS, NOT_ACCEPTED_MINUTES, NOT_DONE_MINUTES, NOT_ACKNOWLEDGED_MINUTES, REASONS, EXTEND_MINUTES } from '../config/workqueue.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Work Queue Engine (Cross-System Capability 317):
//   requirement → responsible recipient → due threshold → escalation condition → next authorised
//   recipient → acknowledgement → action → resolution.
// A task goes to a role or a person and is due at a time. If no one accepts it, or it is accepted
// but not done, a while after that time it goes one step up the service's ladder. Someone in that
// role acknowledges it and does something: takes it over, gives it more time with a reason, or
// notes what they are doing about it. If no one acknowledges it, it goes up again. It resolves when
// the work is done, accepted, taken over or given more time. Nothing is reassigned silently.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = { OPEN: 'Waiting to be acknowledged', ACKNOWLEDGED: 'Acknowledged', RESOLVED: 'Resolved', SUPERSEDED: 'Sent further up' };
const REFS = ['ORG-SYN-001 v1', 'RR-QUEUE-001'];
const DONE = "('COMPLETED', 'CLOSED', 'CANCELLED')";

const minutes = (n: number) => n * 60_000;
const roleLabel = (k: string | null) => (k ? ROLE_BY_KEY.get(k)?.label ?? k : 'no one');
const log = (store: Store, id: string, kind: string, body: string, by: string | null, at = now()) =>
  store.insert('work_escalation_log', { id: newId(), escalation_id: id, kind, body, by_id: by, at });
const hhmm = (d: Date) => d.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false });

// A task's due time in words ("14:00", "Today 14:00", "Tomorrow 06:00") as a moment, when it names
// one. Words without a time ("Today", "Each shift") have no due threshold.
export function parseDue(text: string | null | undefined, from = new Date()): string | null {
  const t = String(text ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return new Date(t).toISOString();
  const m = t.match(/^(today|tomorrow)?\s*(?:at\s*)?(\d{1,2})[:.](\d{2})$/i);
  if (!m) return null;
  const d = new Date(from);
  if (m[1]?.toLowerCase() === 'tomorrow') d.setDate(d.getDate() + 1);
  d.setHours(Number(m[2]), Number(m[3]), 0, 0);
  return Number(m[2]) < 24 && Number(m[3]) < 60 ? d.toISOString() : null;
}

// Where the task sits on its service's ladder now: a role, a person's role, or nobody (-1).
function level(store: Store, serviceId: string, assignedTo: string | null) {
  const ladder = LADDERS[serviceId] ?? [];
  if (!assignedTo) return -1;
  if (assignedTo.startsWith('role:')) return ladder.indexOf(assignedTo.slice(5));
  const roles = store.all<{ r: string }>(
    `SELECT pos.role_key AS r FROM position pos JOIN employment em ON em.id = pos.employment_id
      WHERE em.workforce_person_id = ? AND pos.service_id = ? AND (pos.end_date IS NULL OR pos.end_date >= ?)`,
    assignedTo.slice(7), serviceId, todayLocal(),
  ).map((x) => ladder.indexOf(x.r));
  return roles.length ? Math.max(...roles) : -1;
}

function raise(store: Store, t: Row, lvl: number, reason: string, body: string) {
  const ladder = LADDERS[String(t.service_id)] ?? [];
  const to = ladder[lvl];
  if (!to) return;
  const id = newId();
  const at = now();
  store.insert('work_escalation', {
    id, task_id: t.id, person_id: t.person_id, service_id: t.service_id, level: lvl, to_role: to, reason, escalated_at: at, state: 'OPEN',
  });
  recordInitial(store, 'work_escalation', id, 'OPEN', { actorId: null, workContextId: null }, REASONS[reason]);
  log(store, id, 'ESCALATED', `${body} Sent to ${roleLabel(to)}.`, null, at);
  audit(store, { space: 'SYSTEM', subjectPersonId: String(t.person_id), operation: 'WORK_ESCALATE', objectType: 'task', objectId: String(t.id), outcome: 'COMMITTED', reason: `${REASONS[reason]} → ${to}`, ruleRefs: REFS });
}

function close(store: Store, id: string, state: 'RESOLVED' | 'SUPERSEDED', why: string, by: string | null = null) {
  transition(store, 'work_escalation', id, state, { actorId: by, workContextId: null as unknown as string }, why);
  store.run('UPDATE work_escalation SET state = ?, resolved_at = ?, resolution = ? WHERE id = ?', state, now(), why, id);
  log(store, id, state, why, by);
}

// Bring the service's queue up to date with the clock and the tasks.
export function sweep(store: Store, serviceId: string) {
  const ladder = LADDERS[serviceId];
  if (!ladder) return;
  const t0 = Date.now();
  store.tx(() => {
    // Work that is done, or accepted when the problem was that no one had, resolves its escalation.
    for (const e of store.all<Row>(
      `SELECT e.id, e.reason, t.state AS taskState, t.assigned_to AS assignedTo, w.display_name AS who FROM work_escalation e JOIN task t ON t.id = e.task_id
         LEFT JOIN workforce_person w ON t.assigned_to = 'worker:' || w.id
        WHERE e.service_id = ? AND e.state IN ('OPEN', 'ACKNOWLEDGED')`, serviceId,
    )) {
      const st = String(e.taskState);
      if (['COMPLETED', 'CLOSED'].includes(st)) close(store, String(e.id), 'RESOLVED', `Task ${st === 'CLOSED' ? 'closed' : 'completed'}${e.who ? ` by ${e.who}` : ''}.`);
      else if (st === 'CANCELLED') close(store, String(e.id), 'RESOLVED', 'Task cancelled.');
      else if (e.reason === 'NOT_ACCEPTED' && ['ACCEPTED', 'IN_PROGRESS'].includes(st)) close(store, String(e.id), 'RESOLVED', `Accepted${e.who ? ` by ${e.who}` : ''}.`);
    }
    // An escalation no one acknowledged goes one step further up, while there is a step.
    for (const e of store.all<Row>(
      `SELECT e.id, e.level, e.escalated_at, t.id AS tid, t.person_id, t.service_id FROM work_escalation e JOIN task t ON t.id = e.task_id
        WHERE e.service_id = ? AND e.state = 'OPEN' AND e.escalated_at <= ?`, serviceId, new Date(t0 - minutes(NOT_ACKNOWLEDGED_MINUTES)).toISOString(),
    )) {
      const next = Number(e.level) + 1;
      if (!ladder[next]) continue;
      close(store, String(e.id), 'SUPERSEDED', `Not acknowledged within ${NOT_ACKNOWLEDGED_MINUTES} minutes.`);
      raise(store, { id: e.tid, person_id: e.person_id, service_id: e.service_id }, next, 'NOT_ACKNOWLEDGED', `${roleLabel(ladder[next - 1])} did not acknowledge the escalation within ${NOT_ACKNOWLEDGED_MINUTES} minutes.`);
    }
    // Missed work with no escalation under way goes one step up from whoever holds it.
    for (const t of store.all<Row>(
      `SELECT t.id, t.person_id, t.service_id, t.description, t.state, t.assigned_to, t.due_by FROM task t
        WHERE t.service_id = ? AND t.state NOT IN ${DONE} AND t.state <> 'COMPLETED' AND t.due_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM work_escalation e WHERE e.task_id = t.id AND e.state IN ('OPEN', 'ACKNOWLEDGED'))
          AND NOT EXISTS (SELECT 1 FROM work_escalation e WHERE e.task_id = t.id AND e.state = 'RESOLVED' AND e.due_by = t.due_by AND e.reason = CASE WHEN t.state IN ('ACCEPTED', 'IN_PROGRESS') THEN 'NOT_DONE' ELSE 'NOT_ACCEPTED' END)`,
      serviceId,
    )) {
      const accepted = ['ACCEPTED', 'IN_PROGRESS'].includes(String(t.state));
      const late = t0 - Date.parse(String(t.due_by));
      if (late < minutes(accepted ? NOT_DONE_MINUTES : NOT_ACCEPTED_MINUTES)) continue;
      const lvl = level(store, serviceId, t.assigned_to ? String(t.assigned_to) : null);
      const due = hhmm(new Date(String(t.due_by)));
      raise(store, t, lvl + 1, accepted ? 'NOT_DONE' : 'NOT_ACCEPTED',
        accepted ? `Due ${due} and accepted, but not done ${NOT_DONE_MINUTES} minutes later.` : `Due ${due} and no one had accepted it ${NOT_ACCEPTED_MINUTES} minutes later.`);
      store.run('UPDATE work_escalation SET due_by = ? WHERE task_id = ? AND state = ?', t.due_by, t.id, 'OPEN');
    }
  });
}

const Q = `
  SELECT e.id, e.task_id AS taskId, e.person_id AS personId, e.service_id AS serviceId, p.given_name || ' ' || p.family_name AS patient, e.level, e.to_role AS toRole,
         e.reason, e.escalated_at AS escalatedAt, e.state, ak.display_name AS acknowledgedBy, e.acknowledged_at AS acknowledgedAt,
         e.action, e.action_note AS actionNote, ab.display_name AS actionBy, e.action_at AS actionAt, e.resolved_at AS resolvedAt, e.resolution,
         t.description, t.due_at AS dueAt, t.due_by AS dueBy, t.state AS taskState, t.assigned_to AS assignedTo, aw.display_name AS assignee,
         (SELECT location FROM encounter en WHERE en.person_id = e.person_id AND en.service_id = e.service_id AND en.state = 'ACTIVE') AS location
    FROM work_escalation e JOIN task t ON t.id = e.task_id JOIN person p ON p.id = e.person_id
    LEFT JOIN workforce_person ak ON ak.id = e.acknowledged_by
    LEFT JOIN workforce_person ab ON ab.id = e.action_by
    LEFT JOIN workforce_person aw ON t.assigned_to = 'worker:' || aw.id`;

function shape(store: Store, ctx: WorkContext, e: Row) {
  const mine = e.toRole === ctx.role.roleKey;
  const state = String(e.state);
  const actions: string[] = [];
  const unaccepted = ['CREATED', 'ASSIGNED'].includes(String(e.taskState));
  if (mine && state === 'OPEN') actions.push('acknowledge');
  if (mine && state === 'ACKNOWLEDGED') {
    if (unaccepted) actions.push('take');
    actions.push('extend', 'note');
  }
  const holder = String(e.assignedTo ?? '');
  return {
    ...e, stateLabel: STATES[state], reasonLabel: REASONS[String(e.reason)], toRoleLabel: roleLabel(String(e.toRole)),
    holder: holder.startsWith('worker:') ? String(e.assignee) : holder.startsWith('role:') ? `Any ${roleLabel(holder.slice(5))}` : 'Unassigned',
    actions, extendOptions: EXTEND_MINUTES,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM work_escalation_log l LEFT JOIN workforce_person w ON w.id = l.by_id WHERE l.escalation_id = ? ORDER BY l.at, l.rowid', e.id)
      .map((l) => ({ ...l, by: l.by ?? 'SHIFT' })),
  };
}

// The Tasks screen: escalations waiting on this role, and the escalation on each visible task.
export function queue(store: Store, ctx: WorkContext) {
  sweep(store, ctx.serviceId);
  const since = new Date(Date.now() - 12 * 3600_000).toISOString();
  const toMe = store.all<Row>(`${Q} WHERE e.service_id = ? AND e.to_role = ? AND (e.state IN ('OPEN', 'ACKNOWLEDGED') OR e.resolved_at >= ?) ORDER BY CASE e.state WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END, e.escalated_at`,
    ctx.serviceId, ctx.role.roleKey, since).map((e) => shape(store, ctx, e));
  const onTasks = Object.fromEntries(store.all<Row>(`${Q} WHERE e.service_id = ? AND e.state IN ('OPEN', 'ACKNOWLEDGED')`, ctx.serviceId)
    .map((e) => [String(e.taskId), { toRoleLabel: roleLabel(String(e.toRole)), reasonLabel: REASONS[String(e.reason)], escalatedAt: e.escalatedAt, state: e.state }]));
  const ladder = (LADDERS[ctx.serviceId] ?? []).map(roleLabel);
  return { toMe, onTasks, ladder, onLadder: (LADDERS[ctx.serviceId] ?? []).includes(ctx.role.roleKey) };
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; minutes?: number }) {
  sweep(store, ctx.serviceId);
  const e = store.get<Row>(`${Q} WHERE e.id = ?`, id);
  if (!e) throw new HttpError(404, 'NOT_FOUND', 'That escalation is no longer in SHIFT.');
  if (e.toRole !== ctx.role.roleKey || e.personId === null) throw new HttpError(403, 'BLOCK', `This was escalated to ${roleLabel(String(e.toRole))}.`);
  // Being the role it was sent to is not enough: the worker needs task authority in that service and a relationship with the person.
  enforce(store, ctx, { op: 'TASK', serviceId: String(e.serviceId) }, String(e.personId));
  enforce(store, ctx, { op: 'VIEW_RECORD', personId: String(e.personId) }, String(e.personId));
  const state = String(e.state);
  const note = String(b.note ?? '').trim().slice(0, 1000);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const wrong = () => new HttpError(409, 'WRONG_STATE', `This escalation is ${STATES[state].toLowerCase()}.`);
  const done = (kind: string, body: string) => {
    store.run('UPDATE work_escalation SET action = ?, action_note = ?, action_by = ?, action_at = ? WHERE id = ?', kind, body, ctx.workerId, at, id);
    audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: String(e.personId), operation: `WORK_ESCALATION_${kind}`, objectType: 'task', objectId: String(e.taskId), decision: 'ALLOW', outcome: 'COMMITTED', reason: body.slice(0, 200), ruleRefs: REFS });
  };
  store.tx(() => {
    switch (action) {
      case 'acknowledge':
        if (state !== 'OPEN') throw wrong();
        transition(store, 'work_escalation', id, 'ACKNOWLEDGED', who);
        store.run("UPDATE work_escalation SET state = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?", ctx.workerId, at, id);
        log(store, id, 'ACKNOWLEDGED', 'Acknowledged.', ctx.workerId);
        audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: String(e.personId), operation: 'WORK_ESCALATION_ACKNOWLEDGE', objectType: 'task', objectId: String(e.taskId), decision: 'ALLOW', outcome: 'COMMITTED', ruleRefs: REFS });
        break;
      case 'take': {
        if (state !== 'ACKNOWLEDGED') throw wrong();
        if (!['CREATED', 'ASSIGNED'].includes(String(e.taskState))) throw new HttpError(409, 'ALREADY_ACCEPTED', `${e.assignee ?? 'Someone'} has already accepted this task.`);
        transition(store, 'task', String(e.taskId), 'ACCEPTED', who, 'Taken over from an escalation');
        store.run('UPDATE task SET assigned_to = ? WHERE id = ?', `worker:${ctx.workerId}`, e.taskId);
        done('TAKEN', note || 'Taken over.');
        close(store, id, 'RESOLVED', `Taken over by ${ctx.displayName}.${note ? ` ${note}` : ''}`, ctx.workerId);
        break;
      }
      case 'extend': {
        if (state !== 'ACKNOWLEDGED') throw wrong();
        const mins = EXTEND_MINUTES.includes(Number(b.minutes)) ? Number(b.minutes) : 0;
        if (!mins) throw new HttpError(400, 'TIME_REQUIRED', 'Choose how much more time.');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why it can wait, e.g. "Resident asleep; do at 3 pm".');
        const due = new Date(Date.now() + minutes(mins));
        store.run('UPDATE task SET due_by = ?, due_at = ? WHERE id = ?', due.toISOString(), `Today ${hhmm(due)}`, e.taskId);
        done('EXTENDED', `${note} New due time ${hhmm(due)}.`);
        close(store, id, 'RESOLVED', `More time given until ${hhmm(due)}: ${note}`, ctx.workerId);
        break;
      }
      case 'note':
        if (state !== 'ACKNOWLEDGED') throw wrong();
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what you are doing about it.');
        done('NOTED', note);
        log(store, id, 'NOTED', note, ctx.workerId);
        break;
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return shape(store, ctx, store.get<Row>(`${Q} WHERE e.id = ?`, id)!);
}
