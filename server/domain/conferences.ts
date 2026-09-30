import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { KINDS, STATES, TAKES_PART, REFS } from '../config/conferences.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// MDT meetings and case conferences (Shared Lifecycle Object 239):
//   needed → planned, with who is asked → held: who came, the record entries looked at, what was
//   discussed, decisions, and for each decision an action with a named person and a due date →
//   follow-up → closed (or cancelled before it is held).
// An action given to a colleague becomes a task assigned to them, so it sits in their own task
// list; whether it is done is read from that task, never kept twice. Actions for someone outside
// SHIFT (whānau, the GP) are marked done here. Meetings belong to the person, not one service, so
// the physio and the ward see the same meeting. Nurses, doctors and physios run meetings;
// caregivers see them (ORG-SYN-001).

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const sentence = (s: string) => s.replace(/\.?$/, '.');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'CONFERENCE', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'case_conference', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [239],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('case_conference_step', { id: newId(), conference_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT c.id, c.person_id AS personId, c.service_id AS serviceId, s.name AS service, c.kind, c.reason, c.state, c.planned_for AS plannedFor,
         pb.display_name AS plannedBy, c.others_invited AS othersInvited, c.held_at AS heldAt, lb.display_name AS ledBy, c.patient_there AS patientThere,
         c.others_there AS othersThere, c.evidence_note AS evidenceNote, c.discussion, c.follow_up_on AS followUpOn,
         c.closed_at AS closedAt, c.close_note AS closeNote
    FROM case_conference c
    JOIN service s ON s.id = c.service_id
    JOIN workforce_person pb ON pb.id = c.planned_by
    LEFT JOIN workforce_person lb ON lb.id = c.led_by`;

// Who can be asked to a meeting about this person: clinical staff in this service and in any
// service that is caring for them now.
function colleagues(store: Store, ctx: WorkContext, personId: string) {
  const today = todayLocal();
  const rows = store.all<{ id: string; name: string; roleKey: string; serviceId: string; service: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name, pos.role_key AS roleKey, pos.service_id AS serviceId, s.name AS service
       FROM position pos JOIN employment em ON em.id = pos.employment_id JOIN workforce_person w ON w.id = em.workforce_person_id JOIN service s ON s.id = pos.service_id
      WHERE pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE'
        AND (pos.service_id = ?
          OR pos.service_id IN (SELECT service_id FROM encounter WHERE person_id = ? AND state = 'ACTIVE')
          OR pos.service_id IN (SELECT service_id FROM care_relationship WHERE person_id = ? AND ended_at IS NULL))
      ORDER BY s.name, w.display_name`, today, today, ctx.serviceId, personId, personId);
  const seen = new Set<string>();
  return rows.filter((r) => TAKES_PART.includes(r.roleKey) && !seen.has(r.id) && seen.add(r.id))
    .map((r) => ({ id: r.id, name: r.name, role: ROLE_BY_KEY.get(r.roleKey)?.label ?? r.roleKey, serviceId: r.serviceId, service: r.service }));
}

// Record entries that can be named as looked at: the last 60 days, newest first.
function evidenceOptions(store: Store, personId: string) {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  return store.all<Row>(
    `SELECT id, rendered_text AS text, effective_at AS at FROM clinical_event
      WHERE person_id = ? AND state = 'CURRENT' AND effective_at >= ? ORDER BY effective_at DESC LIMIT 30`, personId, since,
  ).map((r) => ({ id: r.id, at: r.at, text: String(r.text).slice(0, 140) }));
}

function shape(store: Store, ctx: WorkContext, r: Row, manage: boolean): Record<string, any> {
  const id = String(r.id);
  const state = String(r.state);
  const people = store.all<Row>(
    `SELECT w.id, w.display_name AS name, cp.attended FROM case_conference_person cp JOIN workforce_person w ON w.id = cp.worker_id WHERE cp.conference_id = ? ORDER BY w.display_name`, id);
  const actions = store.all<Row>(
    `SELECT a.id, a.decision, a.action, a.owner_label AS ownerLabel, ow.display_name AS ownerName, a.owner_id AS ownerId, a.due_on AS dueOn,
            a.state, a.done_at AS doneAt, db.display_name AS doneBy, a.done_note AS doneNote, t.state AS taskState, t.outcome AS taskOutcome
       FROM case_conference_action a LEFT JOIN workforce_person ow ON ow.id = a.owner_id LEFT JOIN workforce_person db ON db.id = a.done_by
       LEFT JOIN task t ON t.id = a.task_id WHERE a.conference_id = ? ORDER BY a.rowid`, id,
  ).map((a) => {
    const done = a.taskState ? ['COMPLETED', 'CLOSED'].includes(String(a.taskState)) : a.state === 'DONE';
    const cancelled = a.taskState === 'CANCELLED';
    return {
      id: a.id, decision: a.decision, action: a.action, owner: a.ownerName ?? a.ownerLabel, ownerIsMe: a.ownerId === ctx.workerId, dueOn: a.dueOn,
      done, cancelled, overdue: !done && !cancelled && String(a.dueOn) < todayLocal(),
      outcome: a.taskState ? a.taskOutcome : a.doneNote, doneBy: a.doneBy, doneAt: a.doneAt,
      viaTask: !!a.taskState, taskOpen: !!a.taskState && !done && !cancelled,
      canMarkDone: manage && state === 'HELD' && !a.taskState && a.state !== 'DONE',
    };
  });
  const evidence = store.all<Row>(
    `SELECT e.id, e.rendered_text AS text, e.effective_at AS at FROM case_conference_ref r JOIN clinical_event e ON e.id = r.event_id WHERE r.conference_id = ? ORDER BY e.effective_at DESC`, id,
  ).map((e) => ({ id: e.id, at: e.at, text: String(e.text).slice(0, 140) }));
  const open = actions.filter((a) => !a.done && !a.cancelled).length;
  const acts: string[] = [];
  if (manage && state === 'PLANNED') acts.push('hold', 'cancel');
  if (manage && state === 'HELD') acts.push('close');
  return {
    ...r, state, kindLabel: KINDS[String(r.kind)], stateLabel: state === 'HELD' && !open ? 'Held: all actions done' : STATES[state],
    invited: people.map((p) => ({ id: p.id, name: p.name, attended: p.attended === null ? null : !!p.attended })),
    actions, evidence, openActions: open, followUpDue: state === 'HELD' && !!r.followUpOn && String(r.followUpOn) <= todayLocal(), acts,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM case_conference_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.conference_id = ? ORDER BY s.at, s.rowid', id),
  };
}

// In the care plan (rest home and ward nurses), the doctor's Review and the physio's Goals.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  if (!caps.includes('conference.manage') && !caps.includes('conference.view')) return null;
  const manage = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE c.person_id = ? ORDER BY COALESCE(c.held_at, c.planned_for) DESC`, personId).map((r) => shape(store, ctx, r, manage));
  const planned = all.some((c) => c.state === 'PLANNED');
  return {
    title: ctx.role.roleKey.startsWith('arc-') ? 'Family meetings and care reviews' : 'MDT meetings',
    current: all.filter((c) => ['PLANNED', 'HELD'].includes(c.state)),
    past: all.filter((c) => ['CLOSED', 'CANCELLED'].includes(c.state)),
    canPlan: manage,
    options: manage ? { kinds: KINDS, colleagues: colleagues(store, ctx, personId), evidence: planned ? evidenceOptions(store, personId) : [] } : null,
  };
}

interface ActionIn { decision?: string; action?: string; owner?: string; ownerLabel?: string; due?: string }
interface Body {
  kind?: string; reason?: string; when?: string; invite?: string[]; others?: string; attended?: string[]; patientThere?: string;
  othersThere?: string; evidence?: string[]; evidenceNote?: string; discussion?: string; actions?: ActionIn[]; followUp?: string; note?: string;
}

export function plan(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'CONFERENCE', personId }, personId);
  const kind = KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what kind of meeting it is.');
  const reason = text(b.reason);
  if (reason.length < 10) throw new HttpError(400, 'REASON_REQUIRED', 'Write why the meeting is needed, e.g. "Plan for going home; family worried about stairs".');
  const when = text(b.when, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(when)) throw new HttpError(400, 'WHEN_REQUIRED', 'Choose when the meeting is.');
  const pool = colleagues(store, ctx, personId);
  const invite = [...new Set([ctx.workerId, ...(b.invite ?? [])])].filter((w) => pool.some((p) => p.id === w) || w === ctx.workerId);
  const others = text(b.others, 500);
  const id = newId();
  store.tx(() => {
    store.insert('case_conference', {
      id, person_id: personId, service_id: ctx.serviceId, kind, reason, state: 'PLANNED', planned_for: new Date(when).toISOString(), planned_by: ctx.workerId,
      others_invited: others || null, created_at: now(),
    });
    for (const w of invite) store.insert('case_conference_person', { id: newId(), conference_id: id, worker_id: w, attended: null });
    recordInitial(store, 'case_conference', id, 'PLANNED', { actorId: ctx.workerId, workContextId: ctx.id }, KINDS[kind]);
    step(store, id, 'PLANNED', `${KINDS[kind]} planned. ${sentence(reason)}`, ctx.workerId);
    logged(store, ctx, 'CONFERENCE_PLAN', personId, id, KINDS[kind]);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That meeting is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'CONFERENCE', personId }, personId);
  const state = String(r.state);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = text(b.note);
  store.tx(() => {
    switch (action) {
      case 'hold': {
        if (state !== 'PLANNED') throw new HttpError(409, 'STATE', 'This meeting has already been recorded.');
        const discussion = text(b.discussion, 4000);
        if (discussion.length < 10) throw new HttpError(400, 'DISCUSSION_REQUIRED', 'Write what was discussed.');
        const pool = colleagues(store, ctx, personId);
        const acts = (b.actions ?? []).map((a) => ({ decision: text(a.decision, 500), action: text(a.action, 500), owner: text(a.owner, 60), ownerLabel: text(a.ownerLabel, 120), due: text(a.due, 10) }))
          .filter((a) => a.decision || a.action);
        if (!acts.length) throw new HttpError(400, 'DECISION_REQUIRED', 'Record at least one decision, with what will be done about it.');
        for (const a of acts) {
          if (a.decision.length < 3) throw new HttpError(400, 'DECISION_REQUIRED', 'Write each decision.');
          if (a.action.length < 3) throw new HttpError(400, 'ACTION_REQUIRED', `Write what will be done about "${a.decision}".`);
          if (!pool.some((p) => p.id === a.owner) && a.ownerLabel.length < 2) throw new HttpError(400, 'OWNER_REQUIRED', `Choose who will do "${a.action}".`);
          if (!DAY.test(a.due)) throw new HttpError(400, 'DUE_REQUIRED', `Choose when "${a.action}" is due.`);
        }
        const followUp = text(b.followUp, 10);
        if (followUp && !DAY.test(followUp)) throw new HttpError(400, 'FOLLOW_UP', 'Choose a follow-up date, or leave it empty.');
        const attended = new Set(b.attended ?? []);
        for (const p of store.all<{ id: string; worker_id: string }>('SELECT id, worker_id FROM case_conference_person WHERE conference_id = ?', id)) {
          store.run('UPDATE case_conference_person SET attended = ? WHERE id = ?', attended.has(p.worker_id) ? 1 : 0, p.id);
        }
        for (const w of attended) {
          if (!store.get('SELECT 1 FROM case_conference_person WHERE conference_id = ? AND worker_id = ?', id, w) && pool.some((p) => p.id === w)) {
            store.insert('case_conference_person', { id: newId(), conference_id: id, worker_id: w, attended: 1 });
          }
        }
        const allowed = new Set(evidenceOptions(store, personId).map((e) => String(e.id)));
        for (const e of new Set(b.evidence ?? [])) if (allowed.has(e)) store.insert('case_conference_ref', { id: newId(), conference_id: id, event_id: e });
        store.run(
          'UPDATE case_conference SET held_at = ?, led_by = ?, patient_there = ?, others_there = ?, evidence_note = ?, discussion = ?, follow_up_on = ? WHERE id = ?',
          now(), ctx.workerId, b.patientThere === 'yes' ? 1 : b.patientThere === 'no' ? 0 : null, text(b.othersThere, 500) || null, text(b.evidenceNote, 1000) || null,
          discussion, followUp || null, id,
        );
        transition(store, 'case_conference', id, 'HELD', who, 'Held');
        for (const a of acts) {
          const staff = pool.find((p) => p.id === a.owner);
          let taskId: string | null = null;
          if (staff) {
            taskId = newId();
            store.insert('task', {
              id: taskId, person_id: personId, source_event_id: null, service_id: staff.serviceId, assigned_to: `worker:${staff.id}`, state: 'CREATED',
              created_by: ctx.workerId, created_at: now(), due_at: new Date(`${a.due}T17:00:00`).toISOString(), description: `From the ${KINDS[String(r.kind)]}: ${a.action}`,
            });
            recordInitial(store, 'task', taskId, 'CREATED', who, 'Action from a meeting');
            transition(store, 'task', taskId, 'ASSIGNED', who, `Given to ${staff.name} at the meeting`);
          }
          store.insert('case_conference_action', {
            id: newId(), conference_id: id, decision: a.decision, action: a.action, owner_id: staff?.id ?? null, owner_label: staff ? null : a.ownerLabel,
            due_on: a.due, task_id: taskId, state: 'OPEN',
          });
        }
        step(store, id, 'HELD', `Held. ${acts.length} decision${acts.length === 1 ? '' : 's'} recorded.`, ctx.workerId);
        logged(store, ctx, 'CONFERENCE_HOLD', personId, id, `${acts.length} decisions`);
        break;
      }
      case 'cancel': {
        if (state !== 'PLANNED') throw new HttpError(409, 'STATE', 'Only a planned meeting can be cancelled.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the meeting is cancelled.');
        transition(store, 'case_conference', id, 'CANCELLED', who, 'Cancelled');
        store.run('UPDATE case_conference SET closed_at = ?, close_note = ? WHERE id = ?', now(), say, id);
        step(store, id, 'CANCELLED', `Cancelled: ${say}`, ctx.workerId);
        logged(store, ctx, 'CONFERENCE_CANCEL', personId, id, 'Cancelled');
        break;
      }
      case 'close': {
        if (state !== 'HELD') throw new HttpError(409, 'STATE', 'Only a meeting that has been held can be closed.');
        const open = shape(store, ctx, r, true).openActions;
        if (open && say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', `${open} action${open === 1 ? ' is' : 's are'} not done. Write what happens to ${open === 1 ? 'it' : 'them'}.`);
        transition(store, 'case_conference', id, 'CLOSED', who, 'Closed');
        store.run('UPDATE case_conference SET closed_at = ?, close_note = ? WHERE id = ?', now(), say || null, id);
        step(store, id, 'CLOSED', `Closed.${say ? ` ${say}` : ''}`, ctx.workerId);
        logged(store, ctx, 'CONFERENCE_CLOSE', personId, id, open ? `Closed with ${open} open` : 'Closed');
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}

// An action for someone outside SHIFT (whānau, the GP) is marked done here.
export function actionDone(store: Store, ctx: WorkContext, actionId: string, b: Body) {
  const a = store.get<Row>('SELECT a.id, a.action, a.state, a.task_id AS taskId, c.id AS conferenceId, c.person_id AS personId, c.state AS cState FROM case_conference_action a JOIN case_conference c ON c.id = a.conference_id WHERE a.id = ?', actionId);
  if (!a) throw new HttpError(404, 'NOT_FOUND', 'That action is no longer in SHIFT.');
  const personId = String(a.personId);
  enforce(store, ctx, { op: 'CONFERENCE', personId }, personId);
  if (a.taskId) throw new HttpError(409, 'VIA_TASK', 'This action is a task for the person it was given to; they complete it in their tasks.');
  if (a.state === 'DONE' || a.cState !== 'HELD') throw new HttpError(409, 'STATE', 'This action is already finished.');
  const say = text(b.note, 500);
  if (say.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what happened, e.g. "Daughter brought her glasses in".');
  store.tx(() => {
    store.run("UPDATE case_conference_action SET state = 'DONE', done_at = ?, done_by = ?, done_note = ? WHERE id = ?", now(), ctx.workerId, say, actionId);
    step(store, String(a.conferenceId), 'ACTION_DONE', `Done: ${a.action}. ${sentence(say)}`, ctx.workerId);
    logged(store, ctx, 'CONFERENCE_ACTION_DONE', personId, String(a.conferenceId), String(a.action));
  });
  return forPerson(store, ctx, personId);
}
