import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Handover of responsibility for a person (entry 18; Shared Lifecycle Object 219):
//   given to a named colleague in the same role and service → questions asked and answered →
//   accepted (responsibility moves) or declined (it stays with the giver) → or withdrawn.
// Until it is accepted, the person giving the handover is still responsible, and the record says
// so to everyone. Entries marked for handover stay on the handover board as before; this adds
// who is taking over and when they said yes. Who may receive is a colleague in the same role in
// this service with current practising authority where the role needs it (ORG-SYN-001).

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const REFS = ['ORG-SYN-001 v1'];
const STATES: Record<string, string> = {
  GIVEN: 'Waiting for them to accept', QUESTION: 'They have a question', ACCEPTED: 'Accepted', DECLINED: 'Not accepted', WITHDRAWN: 'Withdrawn',
};
const OPEN = "('GIVEN', 'QUESTION')";

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'person_handover', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [16, 219],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('person_handover_step', { id: newId(), handover_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT h.id, h.person_id AS personId, h.service_id AS serviceId, h.state, h.situation, h.background, h.watch, h.todo,
         h.from_id AS fromId, fb.display_name AS "from", h.to_id AS toId, tb.display_name AS "to", h.given_at AS givenAt,
         h.accepted_at AS acceptedAt, h.closed_at AS closedAt, h.close_note AS closeNote,
         p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = h.person_id AND e.service_id = h.service_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location
    FROM person_handover h
    JOIN person p ON p.id = h.person_id
    JOIN workforce_person fb ON fb.id = h.from_id
    JOIN workforce_person tb ON tb.id = h.to_id`;

function shape(store: Store, ctx: WorkContext, r: Row): Record<string, any> {
  const state = String(r.state);
  const mineToTake = r.toId === ctx.workerId;
  const mineGiven = r.fromId === ctx.workerId;
  const actions: string[] = [];
  if (state === 'GIVEN' && mineToTake) actions.push('accept', 'ask', 'decline');
  if (state === 'QUESTION' && mineToTake) actions.push('accept', 'decline');
  if (state === 'QUESTION' && mineGiven) actions.push('answer');
  if (['GIVEN', 'QUESTION'].includes(state) && mineGiven) actions.push('withdraw');
  return {
    ...r, state, stateLabel: STATES[state], mineToTake, mineGiven, actions,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM person_handover_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.handover_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

// Colleagues who can take over from this worker: the same role in this service, active, with
// current practising authority where the role needs it.
function receivers(store: Store, ctx: WorkContext) {
  const today = todayLocal();
  const profession = ROLE_BY_KEY.get(ctx.role.roleKey)?.profession;
  const rows = store.all<{ id: string; name: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name FROM position pos JOIN employment em ON em.id = pos.employment_id JOIN workforce_person w ON w.id = em.workforce_person_id
      WHERE pos.service_id = ? AND pos.role_key = ? AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE' AND w.id != ?
      ORDER BY w.display_name`, ctx.serviceId, ctx.role.roleKey, today, today, ctx.workerId);
  return rows.filter((r) => {
    if (!profession) return true;
    const a = store.get<{ status: string; valid_from: string; valid_to: string | null }>(
      'SELECT status, valid_from, valid_to FROM professional_authority WHERE workforce_person_id = ? AND profession = ? ORDER BY valid_from DESC LIMIT 1', r.id, profession);
    return !!a && a.status === 'CURRENT' && a.valid_from <= today && (a.valid_to === null || a.valid_to >= today);
  });
}

// The person's Handover view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(`${Q} WHERE h.person_id = ? AND h.service_id = ? ORDER BY h.given_at DESC LIMIT 10`, personId, ctx.serviceId).map((r) => shape(store, ctx, r));
  const open = rows.find((r) => ['GIVEN', 'QUESTION'].includes(r.state)) ?? null;
  const last = rows.find((r) => r.state === 'ACCEPTED') ?? null;
  const canGive = ctx.role.capabilities.includes('handover.use') && !open;
  return { open, responsible: last ? { name: last.to, since: last.acceptedAt, from: last.from } : null, past: rows.filter((r) => r !== open), canGive, receivers: canGive ? receivers(store, ctx) : [] };
}

// For the record header: only a handover not yet accepted shows.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE h.person_id = ? AND h.state IN ${OPEN} ORDER BY h.given_at DESC LIMIT 1`, personId);
  return r ? { from: r.from, to: r.to, givenAt: r.givenAt, question: r.state === 'QUESTION' } : null;
}

// Home → Handover: handovers waiting for me to accept, and ones I gave that are not accepted yet.
export function mine(store: Store, ctx: WorkContext) {
  const rows = store.all<Row>(`${Q} WHERE h.service_id = ? AND h.state IN ${OPEN} AND (h.to_id = ? OR h.from_id = ?) ORDER BY h.given_at`, ctx.serviceId, ctx.workerId, ctx.workerId)
    .map((r) => shape(store, ctx, r));
  return { toAccept: rows.filter((r) => r.mineToTake), given: rows.filter((r) => r.mineGiven) };
}

interface Body { to?: string; situation?: string; background?: string; watch?: string; todo?: string; note?: string }

export function give(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'HANDOVER_GIVE', personId }, personId);
  if (store.get(`SELECT 1 FROM person_handover WHERE person_id = ? AND service_id = ? AND state IN ${OPEN}`, personId, ctx.serviceId)) {
    throw new HttpError(409, 'ALREADY', 'A handover for them is already waiting to be accepted.');
  }
  const to = receivers(store, ctx).find((r) => r.id === b.to);
  if (!to) throw new HttpError(400, 'TO_REQUIRED', 'Choose who is taking over: a colleague in your role in this service.');
  const situation = text(b.situation);
  if (situation.length < 10) throw new HttpError(400, 'SITUATION_REQUIRED', 'Write how they are now, e.g. "Settled overnight, obs stable, pain 2/10".');
  const todo = text(b.todo);
  if (todo.length < 3) throw new HttpError(400, 'TODO_REQUIRED', 'Write what needs doing next, or "Nothing outstanding".');
  const id = newId();
  store.tx(() => {
    store.insert('person_handover', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'GIVEN', from_id: ctx.workerId, to_id: to.id,
      situation, background: text(b.background) || null, watch: text(b.watch) || null, todo, given_at: now(),
    });
    recordInitial(store, 'person_handover', id, 'GIVEN', { actorId: ctx.workerId, workContextId: ctx.id }, `To ${to.name}`);
    step(store, id, 'GIVEN', `Handed over to ${to.name}.`, ctx.workerId);
    logged(store, ctx, 'HANDOVER_GIVE', personId, id, `To ${to.name}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE h.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That handover is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'HANDOVER_GIVE', personId }, personId);
  const state = String(r.state);
  if (!['GIVEN', 'QUESTION'].includes(state)) throw new HttpError(409, 'CLOSED', 'This handover is finished.');
  const receiver = r.toId === ctx.workerId;
  const giver = r.fromId === ctx.workerId;
  const say = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const onlyReceiver = () => { if (!receiver) throw new HttpError(403, 'BLOCK', `Only ${r.to} can do this: the handover was given to them.`); };
  const onlyGiver = () => { if (!giver) throw new HttpError(403, 'BLOCK', `Only ${r.from}, who gave the handover, can do this.`); };
  store.tx(() => {
    switch (action) {
      case 'accept': {
        onlyReceiver();
        transition(store, 'person_handover', id, 'ACCEPTED', who, 'Accepted');
        store.run('UPDATE person_handover SET accepted_at = ?, closed_at = ?, close_note = ? WHERE id = ?', now(), now(), say || null, id);
        step(store, id, 'ACCEPTED', `Accepted. ${r.to} is now responsible.${say ? ` ${say}` : ''}`, ctx.workerId);
        logged(store, ctx, 'HANDOVER_ACCEPT', personId, id, `${r.to} took over from ${r.from}`);
        break;
      }
      case 'ask': {
        onlyReceiver();
        if (state !== 'GIVEN') throw new HttpError(409, 'STATE', 'Wait for the answer to your last question.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write your question.');
        transition(store, 'person_handover', id, 'QUESTION', who, 'Question asked');
        step(store, id, 'QUESTION', say, ctx.workerId);
        logged(store, ctx, 'HANDOVER_QUESTION', personId, id, 'Question asked');
        break;
      }
      case 'answer': {
        onlyGiver();
        if (state !== 'QUESTION') throw new HttpError(409, 'STATE', 'There is no question waiting.');
        if (say.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write your answer.');
        transition(store, 'person_handover', id, 'GIVEN', who, 'Question answered');
        step(store, id, 'ANSWER', say, ctx.workerId);
        logged(store, ctx, 'HANDOVER_ANSWER', personId, id, 'Question answered');
        break;
      }
      case 'decline': {
        onlyReceiver();
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why you cannot take over, e.g. "Already have six patients; ask the charge nurse".');
        transition(store, 'person_handover', id, 'DECLINED', who, 'Not accepted');
        store.run('UPDATE person_handover SET closed_at = ?, close_note = ? WHERE id = ?', now(), say, id);
        step(store, id, 'DECLINED', `Not accepted: ${say} ${r.from} is still responsible.`, ctx.workerId);
        logged(store, ctx, 'HANDOVER_DECLINE', personId, id, 'Not accepted');
        break;
      }
      case 'withdraw': {
        onlyGiver();
        transition(store, 'person_handover', id, 'WITHDRAWN', who, 'Withdrawn');
        store.run('UPDATE person_handover SET closed_at = ?, close_note = ? WHERE id = ?', now(), say || null, id);
        step(store, id, 'WITHDRAWN', `Withdrawn.${say ? ` ${say}` : ''}`, ctx.workerId);
        logged(store, ctx, 'HANDOVER_WITHDRAW', personId, id, 'Withdrawn');
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
