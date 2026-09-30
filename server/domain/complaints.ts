import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { FROM, HOW, ABOUT, ACK_HOW, STATES, OUTCOME, REPLY_DAYS, REFS } from '../config/complaints.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Complaints (entries 25, 26):
//   received (anyone can take one in) → acknowledged, advocacy offered, reply date set, and a
//   person handling it → looked into → responded to → not satisfied (looked at again) → closed,
//   with what is changing because of it.
// A complaint is kept apart from the clinical record and never shows on it: their care must not
// change because they complained. Nurses and doctors who handle complaints read the details; the
// worker who took it in sees their own words and where it is up to. Timeframes and reporting are
// RR-COMPLAINT-001.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const pick = (map: Record<string, string>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const mayManage = (store: Store, ctx: WorkContext, personId: string) =>
  evaluate(store, ctx, { op: 'COMPLAINT', personId }).decision === 'ALLOW';
const mayRecord = (store: Store, ctx: WorkContext, personId: string) =>
  mayManage(store, ctx, personId) || evaluate(store, ctx, { op: 'COMPLAINT_RECORD', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'complaint', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('complaint_step', { id: newId(), complaint_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT c.id, c.person_id AS personId, c.service_id AS serviceId, c.state, c.from_kind AS fromKind, c.from_name AS fromName, c.contact, c.how, c.about,
         c.words, c.wants, c.reply_by AS replyBy, c.advocacy, c.response, c.change, c.outcome, c.close_note AS closeNote,
         p.given_name || ' ' || p.family_name AS patient,
         rb.display_name AS receivedBy, c.received_by AS receivedById, c.received_at AS receivedAt,
         hb.display_name AS handler, c.acknowledged_at AS acknowledgedAt, c.responded_at AS respondedAt,
         cb.display_name AS closedBy, c.closed_at AS closedAt
    FROM complaint c
    JOIN person p ON p.id = c.person_id
    JOIN workforce_person rb ON rb.id = c.received_by
    LEFT JOIN workforce_person hb ON hb.id = c.handler_id
    LEFT JOIN workforce_person cb ON cb.id = c.closed_by`;

function shape(store: Store, r: Row, full: boolean) {
  const state = String(r.state);
  const base = {
    id: r.id, personId: r.personId, patient: r.patient, state, stateLabel: STATES[state], aboutLabel: ABOUT[String(r.about)],
    receivedAt: r.receivedAt, receivedBy: r.receivedBy,
    overdue: ['LOOKING'].includes(state) && !!r.replyBy && String(r.replyBy) < now(),
    waitingDays: state === 'RECEIVED' ? Math.floor((Date.now() - Date.parse(String(r.receivedAt))) / 86_400_000) : null,
  };
  if (!full) return { ...base, full: false, words: r.words };
  const actions: string[] = [];
  if (state === 'RECEIVED') actions.push('acknowledge');
  if (state === 'LOOKING') actions.push('note', 'update', 'respond');
  if (state === 'RESPONDED') actions.push('notSatisfied', 'close');
  if (state !== 'CLOSED' && state !== 'RESPONDED') actions.push('close');
  return {
    ...base, ...r, full: true, state,
    fromLabel: FROM[String(r.fromKind)], howLabel: HOW[String(r.how)], outcomeLabel: r.outcome ? OUTCOME[String(r.outcome)] : null,
    actions,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM complaint_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.complaint_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

const options = () => ({ from: FROM, how: HOW, about: ABOUT, ackHow: ACK_HOW, outcome: OUTCOME, replyDays: REPLY_DAYS });

// The person's Incidents, complaints and safeguarding view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = mayManage(store, ctx, personId);
  const canRecord = mayRecord(store, ctx, personId);
  const rows = store.all<Row>(`${Q} WHERE c.person_id = ? ORDER BY c.received_at DESC`, personId);
  const mine = manage ? rows : rows.filter((r) => r.receivedById === ctx.workerId);
  if (manage && rows.length) logged(store, ctx, 'COMPLAINT_VIEW', personId, String(rows[0].id), 'Read complaints');
  return { complaints: mine.map((r) => shape(store, r, manage)), canRecord, canManage: manage, options: options() };
}

// Home → Incidents and complaints, for those who handle complaints in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('complaint.manage')) return null;
  const rows = store.all<Row>(`${Q} WHERE c.service_id = ? AND (c.state != 'CLOSED' OR c.closed_at >= ?) ORDER BY c.received_at`,
    ctx.serviceId, new Date(Date.now() - 30 * 86_400_000).toISOString()).map((r) => shape(store, r, true));
  return {
    toAcknowledge: rows.filter((r) => r.state === 'RECEIVED'),
    open: rows.filter((r) => ['LOOKING', 'RESPONDED'].includes(r.state)),
    closed: rows.filter((r) => r.state === 'CLOSED'),
    overdue: rows.filter((r) => r.overdue).length,
    options: options(),
  };
}

interface Body {
  fromKind?: string; fromName?: string; contact?: string; how?: string; about?: string; words?: string; wants?: string;
  ackHow?: string; advocacy?: unknown; replyDays?: unknown; note?: string; response?: string; change?: string; outcome?: string;
}

export function receive(store: Store, ctx: WorkContext, personId: string, b: Body) {
  const manage = mayManage(store, ctx, personId);
  enforce(store, ctx, { op: manage ? 'COMPLAINT' : 'COMPLAINT_RECORD', personId }, personId);
  const fromKind = pick(FROM, b.fromKind);
  if (!fromKind) throw new HttpError(400, 'FROM_REQUIRED', 'Choose who is complaining.');
  const fromName = text(b.fromName, 120);
  if (fromKind !== 'PERSON' && fromName.length < 2) throw new HttpError(400, 'NAME_REQUIRED', 'Write the name of the person complaining and how they are connected, e.g. "Anne (daughter)".');
  const how = pick(HOW, b.how);
  if (!how) throw new HttpError(400, 'HOW_REQUIRED', 'Choose how the complaint came in.');
  const about = pick(ABOUT, b.about);
  if (!about) throw new HttpError(400, 'ABOUT_REQUIRED', 'Choose what the complaint is mostly about.');
  const words = text(b.words);
  if (words.length < 15) throw new HttpError(400, 'WORDS_REQUIRED', 'Write the complaint in their words where you can.');
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('complaint', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'RECEIVED', from_kind: fromKind, from_name: fromName || null, contact: text(b.contact, 200) || null,
      how, about, words, wants: text(b.wants, 500) || null, received_by: ctx.workerId, received_at: now(),
    });
    recordInitial(store, 'complaint', id, 'RECEIVED', who, ABOUT[about]);
    step(store, id, 'RECEIVED', `${FROM[fromKind]}${fromName ? `: ${fromName}` : ''}. ${HOW[how]}. About: ${ABOUT[about].toLowerCase()}.`, ctx.workerId);
    // The task says only that there is a complaint: task lists are seen by the whole team.
    if (!manage) {
      const taskId = newId();
      store.insert('task', {
        id: taskId, person_id: personId, source_event_id: null, service_id: ctx.serviceId, assigned_to: null, state: 'CREATED', created_by: ctx.workerId, created_at: now(), due_at: null,
        description: 'A complaint has been received. The nurse in charge needs to open Incidents, complaints and safeguarding and acknowledge it. The details are private.',
      });
      recordInitial(store, 'task', taskId, 'CREATED', who, 'Complaint received');
    }
    logged(store, ctx, 'COMPLAINT_RECEIVE', personId, id, ABOUT[about]);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That complaint is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'COMPLAINT', personId }, personId);
  const state = String(r.state);
  if (state === 'CLOSED') throw new HttpError(409, 'CLOSED', 'This complaint is closed. Take in a new one if they raise something new.');
  const say = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const need = (states: string[], msg: string) => { if (!states.includes(state)) throw new HttpError(409, 'STATE', msg); };
  const replyBy = () => {
    const d = Number(b.replyDays);
    if (!REPLY_DAYS.includes(d)) throw new HttpError(400, 'REPLY_REQUIRED', 'Choose when you told them they will hear back.');
    return daysFrom(d);
  };
  store.tx(() => {
    switch (action) {
      case 'acknowledge': {
        need(['RECEIVED'], 'This complaint has already been acknowledged.');
        const how = pick(ACK_HOW, b.ackHow);
        if (!how) throw new HttpError(400, 'ACK_REQUIRED', 'Choose how you acknowledged it.');
        const advocacy = b.advocacy === true || b.advocacy === 'yes';
        const due = replyBy();
        transition(store, 'complaint', id, 'LOOKING', who, 'Acknowledged');
        store.run('UPDATE complaint SET handler_id = ?, acknowledged_at = ?, reply_by = ?, advocacy = ? WHERE id = ?', ctx.workerId, now(), due, advocacy ? 1 : 0, id);
        step(store, id, 'ACKNOWLEDGED', [`Acknowledged ${ACK_HOW[how].toLowerCase()}.`,
          advocacy ? 'Told about the free Health and Disability Advocacy Service.' : 'Not yet told about the advocacy service.',
          say ? sentence(say) : ''].join(' ').trim(), ctx.workerId);
        logged(store, ctx, 'COMPLAINT_ACKNOWLEDGE', personId, id, 'Acknowledged');
        break;
      }
      case 'note': {
        need(['LOOKING'], 'Notes are added while it is being looked into.');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you did or found, e.g. "Spoke with the night staff; call bell log shows 25 minutes".');
        step(store, id, 'LOOKED', say, ctx.workerId);
        logged(store, ctx, 'COMPLAINT_NOTE', personId, id, 'Looked into');
        break;
      }
      case 'update': {
        need(['LOOKING'], 'Updates are given while it is being looked into.');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you told them and why it is taking longer.');
        const due = replyBy();
        store.run('UPDATE complaint SET reply_by = ? WHERE id = ?', due, id);
        step(store, id, 'UPDATE', say, ctx.workerId);
        logged(store, ctx, 'COMPLAINT_UPDATE', personId, id, 'Told them how it is going');
        break;
      }
      case 'respond': {
        need(['LOOKING'], 'Only a complaint being looked into can be responded to.');
        const response = text(b.response);
        if (response.length < 20) throw new HttpError(400, 'RESPONSE_REQUIRED', 'Write what you told them: what you found, any apology, and what will change.');
        transition(store, 'complaint', id, 'RESPONDED', who, 'Responded');
        store.run('UPDATE complaint SET response = ?, responded_at = ? WHERE id = ?', response, now(), id);
        step(store, id, 'RESPONDED', response, ctx.workerId);
        logged(store, ctx, 'COMPLAINT_RESPOND', personId, id, 'Responded');
        break;
      }
      case 'notSatisfied': {
        need(['RESPONDED'], 'Only a complaint that has been responded to can go back.');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what they are still unhappy about.');
        const due = replyBy();
        transition(store, 'complaint', id, 'LOOKING', who, 'Not satisfied');
        store.run('UPDATE complaint SET reply_by = ? WHERE id = ?', due, id);
        step(store, id, 'NOT_SATISFIED', say, ctx.workerId);
        logged(store, ctx, 'COMPLAINT_NOT_SATISFIED', personId, id, 'Not satisfied');
        break;
      }
      case 'close': {
        const outcome = pick(OUTCOME, b.outcome);
        if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose how it ended.');
        if (['RESOLVED', 'NOT_RESOLVED'].includes(outcome) && state !== 'RESPONDED') throw new HttpError(409, 'STATE', 'Respond to them before closing it.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was agreed with them.');
        const change = text(b.change, 1000) || null;
        transition(store, 'complaint', id, 'CLOSED', who, OUTCOME[outcome]);
        store.run('UPDATE complaint SET outcome = ?, close_note = ?, change = ?, closed_by = ?, closed_at = ? WHERE id = ?', outcome, say, change, ctx.workerId, now(), id);
        step(store, id, 'CLOSED', `${OUTCOME[outcome]}. ${sentence(say)}${change ? ` What we are changing: ${sentence(change)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'COMPLAINT_CLOSE', personId, id, OUTCOME[outcome]);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
