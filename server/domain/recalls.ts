import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { KINDS, KIND_BY_ID, INTERVALS, CHANNELS, EXIT_REASONS, DUE_SOON_DAYS } from '../config/recalls.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Recall (Shared Lifecycle Object 283):
//   recall requirement → due interval/date → patient/service eligibility → invitation/contact →
//   booking → attendance/action → outcome → next recall OR completion/exit.
// A clinician sets up a recall with a due date, once or repeating. Before inviting the person,
// someone confirms they are still eligible. The person (or their whānau) is contacted, then it
// is booked. If they come, the outcome is recorded and the next recall is set, or it stops. If
// they do not come, they are invited again or the recall ends with a reason.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  SCHEDULED: 'Not invited yet', INVITED: 'Invited', BOOKED: 'Booked', DID_NOT_ATTEND: 'Did not attend', DONE: 'Done',
  EXITED: 'Ended', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  SET_UP: 'Set up', ELIGIBLE: 'Still eligible', INVITED: 'Invited', BOOKED: 'Booked', DID_NOT_ATTEND: 'Did not attend', DONE: 'Outcome',
  NEXT: 'Next recall set', EXITED: 'Ended', ERROR: 'Entered in error',
};
const OPEN = ['SCHEDULED', 'INVITED', 'BOOKED', 'DID_NOT_ATTEND'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-RECALL-001'];

const Q = `
  SELECT r.id, r.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = r.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         r.service_id AS serviceId, s.name AS service, r.kind, r.what, r.detail, r.every_days AS everyDays, r.due_date AS dueDate, r.state, r.previous_id AS previousId,
         sb.display_name AS setBy, r.set_by AS setById, r.set_at AS setAt,
         cb.display_name AS checkedBy, r.checked_at AS checkedAt, r.eligibility_note AS eligibilityNote,
         ib.display_name AS invitedBy, r.invited_at AS invitedAt, r.channel, r.invite_note AS inviteNote,
         bb.display_name AS bookedBy, r.booked_for AS bookedFor, r.booked_where AS bookedWhere,
         r.dna_at AS dnaAt, r.dna_note AS dnaNote,
         db.display_name AS doneBy, r.done_at AS doneAt, r.outcome,
         r.exit_reason AS exitReason, eb.display_name AS endedBy, r.ended_at AS endedAt, r.ended_note AS endedNote
    FROM recall r
    JOIN person p ON p.id = r.person_id
    JOIN service s ON s.id = r.service_id
    JOIN workforce_person sb ON sb.id = r.set_by
    LEFT JOIN workforce_person cb ON cb.id = r.checked_by
    LEFT JOIN workforce_person ib ON ib.id = r.invited_by
    LEFT JOIN workforce_person bb ON bb.id = r.booked_by
    LEFT JOIN workforce_person db ON db.id = r.done_by
    LEFT JOIN workforce_person eb ON eb.id = r.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'RECALL', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'recall', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('recall_log', { id: newId(), recall_id: id, kind, body, by_id: ctx.workerId, at: now() });

function create(store: Store, ctx: WorkContext, x: { personId: string; kind: string; what: string; detail: string | null; everyDays: number | null; dueDate: string; previousId: string | null }) {
  const id = newId();
  store.insert('recall', {
    id, person_id: x.personId, service_id: ctx.serviceId, kind: x.kind, what: x.what, detail: x.detail, every_days: x.everyDays, due_date: x.dueDate,
    state: 'SCHEDULED', previous_id: x.previousId, set_by: ctx.workerId, set_at: now(),
  });
  recordInitial(store, 'recall', id, 'SCHEDULED', { actorId: ctx.workerId, workContextId: ctx.id }, `${x.what} due ${x.dueDate}`);
  addLog(store, ctx, id, 'SET_UP', `${x.what}. Due ${x.dueDate}. ${INTERVALS[String(x.everyDays ?? 0)] ?? `Every ${x.everyDays} days`}.${x.previousId ? ' Set from the last recall.' : ''}`);
  return id;
}

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const today = todayLocal();
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId) {
    if (state === 'SCHEDULED' && !r.checkedAt) actions.push('check');
    if ((state === 'SCHEDULED' && r.checkedAt) || state === 'DID_NOT_ATTEND') actions.push('invite');
    if (state === 'INVITED') actions.push('book');
    if (state === 'BOOKED') actions.push('attended', 'dna');
    if (OPEN.includes(state)) actions.push('exit', 'error');
  }
  const waiting = ['SCHEDULED', 'INVITED'].includes(state);
  return {
    ...r, id, state, stateLabel: STATES[state], dueDate: String(r.dueDate), bookedFor: r.bookedFor as string | null,
    kindLabel: KIND_BY_ID.get(String(r.kind))?.label ?? String(r.kind), everyLabel: INTERVALS[String(r.everyDays ?? 0)] ?? `Every ${r.everyDays} days`,
    channelLabel: r.channel ? CHANNELS[String(r.channel)] ?? String(r.channel) : null,
    exitLabel: r.exitReason ? EXIT_REASONS[String(r.exitReason)] ?? String(r.exitReason) : null,
    overdue: waiting && String(r.dueDate) < today,
    dueSoon: waiting && String(r.dueDate) >= today && String(r.dueDate) <= addDays(today, DUE_SOON_DAYS),
    nextDue: r.everyDays ? addDays(today, Number(r.everyDays)) : null,
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM recall_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.recall_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'recall', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That recall is no longer in SHIFT.');
  return r;
};

export function setUp(store: Store, ctx: WorkContext, personId: string, b: { kind?: string; what?: string; detail?: string; every?: string; dueDate?: string }) {
  enforce(store, ctx, { op: 'RECALL', personId }, personId);
  const kind = KIND_BY_ID.get(String(b.kind));
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what the recall is for.');
  const what = text(b.what, 300) || (kind.id === 'OTHER' ? '' : kind.label);
  if (what.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what the recall is for.');
  if (!(String(b.every ?? '') in INTERVALS)) throw new HttpError(400, 'EVERY_REQUIRED', 'Choose how often.');
  const dueDate = date(b.dueDate);
  if (!dueDate || dueDate < todayLocal() || dueDate > addDays(todayLocal(), 3 * 365)) throw new HttpError(400, 'DATE', 'Choose when it is due, from today to three years ahead.');
  store.tx(() => {
    const id = create(store, ctx, { personId, kind: kind.id, what, detail: text(b.detail, 1000) || null, everyDays: Number(b.every) || null, dueDate, previousId: null });
    logged(store, ctx, 'RECALL_SET_UP', personId, id, what.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; eligible?: string; channel?: string; when?: string; where?: string; next?: string; nextDue?: string; reason?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'RECALL', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This recall belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This recall is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const end = (to: 'EXITED' | 'ENTERED_IN_ERROR', reason: string | null, body: string) => {
    transition(store, 'recall', id, to, who, body.slice(0, 200));
    store.run('UPDATE recall SET exit_reason = ?, ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', reason, ctx.workerId, at, note, id);
  };
  switch (action) {
    case 'check': {
      inState('SCHEDULED');
      if (b.eligible !== 'YES' && b.eligible !== 'NO') throw new HttpError(400, 'ELIGIBLE_REQUIRED', 'Say whether they are still eligible.');
      if (b.eligible === 'NO') {
        need(5, 'Say why they are no longer eligible.');
        store.tx(() => {
          end('EXITED', 'NOT_ELIGIBLE', note);
          addLog(store, ctx, id, 'EXITED', `${EXIT_REASONS.NOT_ELIGIBLE}. ${note}`);
          logged(store, ctx, 'RECALL_NOT_ELIGIBLE', personId, id, note.slice(0, 200));
        });
      } else {
        store.tx(() => {
          store.run('UPDATE recall SET checked_by = ?, checked_at = ?, eligibility_note = ? WHERE id = ?', ctx.workerId, at, note || null, id);
          addLog(store, ctx, id, 'ELIGIBLE', note || 'Checked.');
          logged(store, ctx, 'RECALL_ELIGIBLE', personId, id, note.slice(0, 200));
        });
      }
      break;
    }
    case 'invite': {
      inState('SCHEDULED', 'DID_NOT_ATTEND');
      if (state === 'SCHEDULED' && !r.checkedAt) throw new HttpError(409, 'CHECK_FIRST', 'Check they are still eligible before inviting them.');
      const channel = CHANNELS[String(b.channel)] ? String(b.channel) : '';
      if (!channel) throw new HttpError(400, 'CHANNEL', 'Choose how you contacted them.');
      if (channel === 'WHANAU') need(5, 'Say who you contacted.');
      store.tx(() => {
        transition(store, 'recall', id, 'INVITED', who, CHANNELS[channel]);
        store.run('UPDATE recall SET invited_by = ?, invited_at = ?, channel = ?, invite_note = ? WHERE id = ?', ctx.workerId, at, channel, note || null, id);
        addLog(store, ctx, id, 'INVITED', `${state === 'DID_NOT_ATTEND' ? 'Invited again. ' : ''}${CHANNELS[channel]}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'RECALL_INVITE', personId, id, channel);
      });
      break;
    }
    case 'book': {
      inState('INVITED');
      const when = Date.parse(String(b.when ?? ''));
      if (Number.isNaN(when) || when < Date.now() - 60 * 60_000 || when > Date.now() + 365 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it is booked, from now to a year ahead.');
      const where = text(b.where, 200);
      if (where.length < 3) throw new HttpError(400, 'WHERE_REQUIRED', 'Say where, e.g. "Treatment room" or "Specsavers Onehunga".');
      const iso = new Date(when).toISOString();
      store.tx(() => {
        transition(store, 'recall', id, 'BOOKED', who, where);
        store.run('UPDATE recall SET booked_by = ?, booked_at = ?, booked_for = ?, booked_where = ? WHERE id = ?', ctx.workerId, at, iso, where, id);
        addLog(store, ctx, id, 'BOOKED', `${where}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'RECALL_BOOK', personId, id, where);
      });
      break;
    }
    case 'attended': {
      inState('BOOKED');
      need(5, 'Write the outcome, e.g. "Vaccine given, left arm; no reaction".');
      const next = b.next === 'NEXT' ? 'NEXT' : b.next === 'STOP' ? 'STOP' : '';
      if (!next) throw new HttpError(400, 'NEXT_REQUIRED', 'Choose whether to set the next recall.');
      const nextDue = next === 'NEXT' ? date(b.nextDue) : '';
      if (next === 'NEXT' && (!nextDue || nextDue <= todayLocal())) throw new HttpError(400, 'DATE', 'Choose when the next one is due, after today.');
      store.tx(() => {
        transition(store, 'recall', id, 'DONE', who, note.slice(0, 200));
        store.run('UPDATE recall SET done_by = ?, done_at = ?, outcome = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx, id, 'DONE', note);
        if (next === 'NEXT') {
          const nextId = create(store, ctx, { personId, kind: String(r.kind), what: String(r.what), detail: r.detail ? String(r.detail) : null, everyDays: r.everyDays ? Number(r.everyDays) : null, dueDate: nextDue, previousId: id });
          store.run('UPDATE recall SET next_id = ? WHERE id = ?', nextId, id);
          addLog(store, ctx, id, 'NEXT', `Next due ${nextDue}.`);
        } else addLog(store, ctx, id, 'EXITED', 'No further recall.');
        logged(store, ctx, 'RECALL_DONE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'dna': {
      inState('BOOKED');
      need(5, 'Say what happened and what was tried, e.g. "Not at home when the optometrist visited".');
      store.tx(() => {
        transition(store, 'recall', id, 'DID_NOT_ATTEND', who, note.slice(0, 200));
        store.run('UPDATE recall SET dna_at = ?, dna_note = ? WHERE id = ?', at, note, id);
        addLog(store, ctx, id, 'DID_NOT_ATTEND', note);
        logged(store, ctx, 'RECALL_DNA', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'exit': {
      inState(...OPEN);
      const reason = EXIT_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why the recall is ending.');
      need(5, 'Say what happened.');
      store.tx(() => {
        end('EXITED', reason, note);
        addLog(store, ctx, id, 'EXITED', `${EXIT_REASONS[reason]}. ${note}`);
        logged(store, ctx, 'RECALL_EXIT', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      inState(...OPEN);
      need(10, 'Write why this was entered in error, e.g. "Set up for the wrong person".');
      store.tx(() => {
        end('ENTERED_IN_ERROR', null, note);
        addLog(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'RECALL_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Recalls view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE r.person_id = ? ORDER BY r.due_date DESC, r.set_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canSetUp: can,
    options: { kinds: KINDS, intervals: INTERVALS, channels: CHANNELS, exitReasons: EXIT_REASONS },
  };
}

// Home → Recalls for this service: overdue, due soon, booked, did not attend.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('recall.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include recalls`);
  const rows = store.all<Row>(`${Q} WHERE r.service_id = ? AND r.state IN ('SCHEDULED', 'INVITED', 'BOOKED', 'DID_NOT_ATTEND') ORDER BY r.due_date`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_RECALLS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    overdue: rows.filter((r) => r.overdue),
    dueSoon: rows.filter((r) => r.dueSoon),
    booked: rows.filter((r) => r.state === 'BOOKED').sort((a, b) => String(a.bookedFor).localeCompare(String(b.bookedFor))),
    dna: rows.filter((r) => r.state === 'DID_NOT_ATTEND'),
  };
}
