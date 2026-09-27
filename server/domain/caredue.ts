import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { KINDS, KIND_BY_ID, INTERVALS, RESCHEDULE_REASONS, upcomingLead, grace } from '../config/caredue.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Care due (the due-date lifecycle listed under Shared Lifecycle Object 278):
//   requirement established → due date/time → upcoming → due → overdue → completed/ceased/rescheduled.
// A senior sets up care that falls due: once, or every so many hours. Each time it falls due is
// an occurrence. As the time comes near it is upcoming, then due, then overdue; those follow
// from the clock and are shown, not recorded. Whoever does it records it done, and repeating
// care is next due that interval after it was done. It can be moved to a later time with a
// reason, and a senior can stop it.

type Row = Record<string, string | number | null>;
type Cap = 'due.record' | 'due.manage';
const ITEM_STATES: Record<string, string> = { ACTIVE: 'Active', COMPLETED: 'Done', CEASED: 'Stopped', ENTERED_IN_ERROR: 'Entered in error' };
const TIMING: Record<string, string> = { SCHEDULED: 'Scheduled', UPCOMING: 'Upcoming', DUE: 'Due now', OVERDUE: 'Overdue' };
const LOG: Record<string, string> = {
  SET_UP: 'Set up', DONE: 'Done', RESCHEDULED: 'Moved', CEASED: 'Stopped', ERROR: 'Entered in error',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-DUE-001'];
const MIN = 60_000;

const Q = `
  SELECT d.id, d.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = d.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         d.service_id AS serviceId, s.name AS service, d.kind, d.what, d.detail, d.every_hours AS everyHours, d.state,
         sb.display_name AS setBy, d.set_by AS setById, d.set_at AS setAt, eb.display_name AS endedBy, d.ended_at AS endedAt, d.ended_note AS endedNote,
         o.id AS occurrenceId, o.due_at AS dueAt,
         (SELECT MAX(x.done_at) FROM due_occurrence x WHERE x.item_id = d.id AND x.state = 'COMPLETED') AS lastDoneAt,
         (SELECT COUNT(*) FROM due_occurrence x WHERE x.item_id = d.id AND x.state = 'COMPLETED') AS timesDone
    FROM due_item d
    JOIN person p ON p.id = d.person_id
    JOIN service s ON s.id = d.service_id
    JOIN workforce_person sb ON sb.id = d.set_by
    LEFT JOIN workforce_person eb ON eb.id = d.ended_by
    LEFT JOIN due_occurrence o ON o.item_id = d.id AND o.state = 'SCHEDULED'`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'CARE_DUE', personId, cap }).decision === 'ALLOW';
const iso = (v: unknown) => { const t = Date.parse(String(v ?? '')); return Number.isNaN(t) ? null : new Date(t); };
const every = (r: Row) => (r.everyHours ? Number(r.everyHours) : null);

export function timing(dueAt: string, everyHours: number | null, at = Date.now()) {
  const due = Date.parse(dueAt);
  if (at < due - upcomingLead(everyHours)) return 'SCHEDULED';
  if (at < due) return 'UPCOMING';
  if (at <= due + grace(everyHours)) return 'DUE';
  return 'OVERDUE';
}
const late = (mins: number) => (mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 6) / 10} h` : `${Math.round(mins / 1440)} days`);

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'due_item', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('due_log', { id: newId(), item_id: id, kind, body, by_id: ctx.workerId, at: now() });

function schedule(store: Store, ctx: WorkContext, itemId: string, dueAt: Date) {
  const id = newId();
  store.insert('due_occurrence', { id, item_id: itemId, due_at: dueAt.toISOString(), state: 'SCHEDULED', done_by: null, done_at: null, note: null, reason: null });
  recordInitial(store, 'due_occurrence', id, 'SCHEDULED', { actorId: ctx.workerId, workContextId: ctx.id }, dueAt.toISOString());
  return id;
}

function shape(store: Store, ctx: WorkContext, r: Row, can: { record: boolean; manage: boolean }) {
  const id = String(r.id);
  const state = String(r.state);
  const t = state === 'ACTIVE' && r.dueAt ? timing(String(r.dueAt), every(r)) : null;
  const here = ctx.serviceId === r.serviceId;
  const actions: string[] = [];
  if (here && state === 'ACTIVE') {
    if (can.record) actions.push('done', 'reschedule');
    if (can.manage) actions.push('cease');
    if (can.manage || r.setById === ctx.workerId) actions.push('error');
  }
  const minsLate = t === 'DUE' || t === 'OVERDUE' ? Math.floor((Date.now() - Date.parse(String(r.dueAt))) / MIN) : 0;
  return {
    ...r, id, state, stateLabel: ITEM_STATES[state], timing: t, timingLabel: t ? TIMING[t] : null, late: minsLate ? late(minsLate) : null,
    kindLabel: KIND_BY_ID.get(String(r.kind))?.label ?? String(r.kind), everyLabel: INTERVALS[String(r.everyHours ?? 0)] ?? `Every ${r.everyHours} hours`,
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM due_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.item_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'due_item', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That is no longer in SHIFT.');
  return r;
};

export function setUp(store: Store, ctx: WorkContext, personId: string, b: { kind?: string; what?: string; detail?: string; every?: string; firstDue?: string }) {
  enforce(store, ctx, { op: 'CARE_DUE', personId, cap: 'due.manage' }, personId);
  const kind = KIND_BY_ID.get(String(b.kind));
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what care is due.');
  const what = text(b.what, 300) || (kind.id === 'OTHER' ? '' : kind.label);
  if (what.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what needs doing.');
  if (!(String(b.every ?? '') in INTERVALS)) throw new HttpError(400, 'EVERY_REQUIRED', 'Choose how often.');
  const everyHours = Number(b.every) || null;
  const first = b.firstDue ? iso(b.firstDue) : new Date();
  if (!first) throw new HttpError(400, 'DATE', 'Choose when it is first due.');
  if (first.getTime() < Date.now() - 5 * MIN || first.getTime() > Date.now() + 30 * 24 * 60 * MIN) throw new HttpError(400, 'DATE', 'The first time must be from now to 30 days ahead.');
  const id = newId();
  store.tx(() => {
    store.insert('due_item', {
      id, person_id: personId, service_id: ctx.serviceId, kind: kind.id, what, detail: text(b.detail, 1000) || null, every_hours: everyHours, state: 'ACTIVE',
      set_by: ctx.workerId, set_at: now(), ended_by: null, ended_at: null, ended_note: null,
    });
    recordInitial(store, 'due_item', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, what.slice(0, 200));
    schedule(store, ctx, id, first);
    const inMins = Math.round((first.getTime() - Date.now()) / MIN);
    addLog(store, ctx, id, 'SET_UP', `${what}. ${INTERVALS[String(everyHours ?? 0)]}, first due ${inMins > 0 ? `in ${late(inMins)}` : 'now'}.`);
    logged(store, ctx, 'DUE_SET_UP', personId, id, what.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; to?: string; reason?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const cap: Cap = ['cease'].includes(action) ? 'due.manage' : 'due.record';
  enforce(store, ctx, { op: 'CARE_DUE', personId, cap }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This belongs to ${r.service}.`);
  if (r.state !== 'ACTIVE' || !r.occurrenceId) throw new HttpError(409, 'WRONG_STATE', `This is ${ITEM_STATES[String(r.state)].toLowerCase()}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const occ = String(r.occurrenceId);
  const note = text(b.note);
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const at = new Date();
  switch (action) {
    case 'done': {
      const overdue = timing(String(r.dueAt), every(r), at.getTime()) === 'OVERDUE';
      const minsAfter = Math.floor((at.getTime() - Date.parse(String(r.dueAt))) / MIN);
      const early = Date.parse(String(r.dueAt)) - upcomingLead(every(r)) > at.getTime();
      if (early) need(5, 'This is not due yet. Say why you are doing it early.');
      store.tx(() => {
        transition(store, 'due_occurrence', occ, 'COMPLETED', who, note.slice(0, 200) || undefined);
        store.run('UPDATE due_occurrence SET done_by = ?, done_at = ?, note = ? WHERE id = ?', ctx.workerId, at.toISOString(), note || null, occ);
        let body = `${overdue ? `Done ${late(minsAfter)} after it was due. ` : early ? 'Done early. ' : ''}${note}`.trim() || 'Done.';
        if (every(r)) {
          const next = new Date(at.getTime() + every(r)! * 60 * MIN);
          schedule(store, ctx, id, next);
          body += ` Next due in ${late(every(r)! * 60)}.`;
        } else {
          transition(store, 'due_item', id, 'COMPLETED', who, 'Done');
          store.run('UPDATE due_item SET ended_by = ?, ended_at = ? WHERE id = ?', ctx.workerId, at.toISOString(), id);
        }
        addLog(store, ctx, id, 'DONE', body);
        logged(store, ctx, 'DUE_DONE', personId, id, body.slice(0, 200));
      });
      break;
    }
    case 'reschedule': {
      const to = iso(b.to);
      if (!to || to.getTime() <= at.getTime() || to.getTime() > at.getTime() + 7 * 24 * 60 * MIN) throw new HttpError(400, 'DATE', 'Choose a new time later than now and within a week.');
      const reason = RESCHEDULE_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it is being moved.');
      need(5, 'Say what is happening, e.g. "At X-ray; will turn her when she is back".');
      store.tx(() => {
        transition(store, 'due_occurrence', occ, 'RESCHEDULED', who, RESCHEDULE_REASONS[reason]);
        store.run('UPDATE due_occurrence SET done_by = ?, done_at = ?, note = ?, reason = ? WHERE id = ?', ctx.workerId, at.toISOString(), note, reason, occ);
        schedule(store, ctx, id, to);
        addLog(store, ctx, id, 'RESCHEDULED', `Moved to ${late(Math.round((to.getTime() - at.getTime()) / MIN))} from now. ${RESCHEDULE_REASONS[reason]}. ${note}`);
        logged(store, ctx, 'DUE_RESCHEDULE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'cease':
    case 'error': {
      if (action === 'cease') need(5, 'Say why it is being stopped, e.g. "Skin healed; walking on her own now".');
      else {
        if (!may(store, ctx, personId, 'due.manage') && r.setById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only whoever set it up, or a senior, can mark it entered in error.');
        need(10, 'Write why this was entered in error, e.g. "Set up for the wrong person".');
      }
      const to = action === 'cease' ? 'CEASED' : 'ENTERED_IN_ERROR';
      store.tx(() => {
        transition(store, 'due_occurrence', occ, to, who, note.slice(0, 200));
        transition(store, 'due_item', id, to, who, note.slice(0, 200));
        store.run('UPDATE due_item SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at.toISOString(), note, id);
        addLog(store, ctx, id, action === 'cease' ? 'CEASED' : 'ERROR', note);
        logged(store, ctx, action === 'cease' ? 'DUE_CEASE' : 'DUE_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

const ORDER = { OVERDUE: 0, DUE: 1, UPCOMING: 2, SCHEDULED: 3 } as Record<string, number>;
const byTime = (a: { timing: string | null }, b: { timing: string | null }) =>
  (ORDER[a.timing ?? ''] ?? 9) - (ORDER[b.timing ?? ''] ?? 9) || String((a as Row).dueAt).localeCompare(String((b as Row).dueAt));

// The person's Care due view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = { record: may(store, ctx, personId, 'due.record'), manage: may(store, ctx, personId, 'due.manage') };
  const all = store.all<Row>(`${Q} WHERE d.person_id = ? ORDER BY d.set_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    active: all.filter((x) => x.state === 'ACTIVE').sort(byTime),
    ended: all.filter((x) => x.state !== 'ACTIVE'),
    canSetUp: can.manage,
    options: { kinds: KINDS, intervals: INTERVALS, reasons: RESCHEDULE_REASONS },
  };
}

// For the record header: care overdue for this person.
export function current(store: Store, personId: string) {
  return store.all<{ what: string; due_at: string; every_hours: number | null }>(`SELECT d.what, o.due_at, d.every_hours FROM due_item d
      JOIN due_occurrence o ON o.item_id = d.id AND o.state = 'SCHEDULED' WHERE d.person_id = ? AND d.state = 'ACTIVE' ORDER BY o.due_at`, personId)
    .filter((x) => timing(x.due_at, x.every_hours) === 'OVERDUE').map((x) => x.what);
}

// Home → Care due for this service: overdue, due now, upcoming, and the rest of the next day.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('due.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include care due`);
  const can = { record: true, manage: ctx.role.capabilities.includes('due.manage') };
  const horizon = new Date(Date.now() + 24 * 60 * MIN).toISOString();
  const rows = store.all<Row>(`${Q} WHERE d.service_id = ? AND d.state = 'ACTIVE' AND o.due_at <= ? ORDER BY o.due_at`, ctx.serviceId, horizon)
    .map((r) => shape(store, ctx, r, can));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_CARE_DUE', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    overdue: rows.filter((r) => r.timing === 'OVERDUE'),
    due: rows.filter((r) => r.timing === 'DUE'),
    upcoming: rows.filter((r) => r.timing === 'UPCOMING'),
    later: rows.filter((r) => r.timing === 'SCHEDULED'),
  };
}
