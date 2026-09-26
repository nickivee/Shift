import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { INSTRUMENTS, INSTRUMENT_BY_CODE, type Instrument } from '../config/instruments.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Questionnaire / assessment instrument (Shared Lifecycle Object 257):
//   instrument required or offered → version identified → administered → responses →
//   score/result → interpretation → clinical action where applicable → repeat assessment.
// SHIFT adds up the score and names the band the publisher gives. A clinician then says what it
// means for this person and what is being done, and whether and when to repeat it. Safety flags
// (such as PHQ-9 item 9) stay on the record header until a clinician has interpreted the result.

type Row = Record<string, string | number | null>;
const MODES: Record<string, string> = { STAFF_ASKED: 'Asked by staff', SELF_COMPLETED: 'Filled in by them', INTERPRETER: 'Through an interpreter', OBSERVED: 'Observed and asked' };
const STATES: Record<string, string> = { REQUESTED: 'Due', COMPLETED: 'To interpret', INTERPRETED: 'Interpreted', DECLINED: 'Declined', CANCELLED: 'Cancelled' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-INSTR-001'];

const USE = `
  SELECT u.id, u.state, u.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = u.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         s.name AS service, u.instrument_code AS code, u.instrument_version AS version, u.reason, u.due_at AS dueAt,
         qb.display_name AS requestedBy, u.requested_at AS requestedAt, u.repeat_of AS repeatOf, u.mode,
         ab.display_name AS administeredBy, u.administered_at AS administeredAt, u.responses_json AS responsesJson, u.score, u.band, u.flags_json AS flagsJson,
         ib.display_name AS interpretedBy, u.interpreted_at AS interpretedAt, u.interpretation, u.action, u.next_id AS nextId, u.closed_reason AS closedReason
    FROM instrument_use u
    JOIN person p ON p.id = u.person_id
    JOIN service s ON s.id = u.service_id
    JOIN workforce_person qb ON qb.id = u.requested_by
    LEFT JOIN workforce_person ab ON ab.id = u.administered_by
    LEFT JOIN workforce_person ib ON ib.id = u.interpreted_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'INSTRUMENT', personId }).decision === 'ALLOW';
const instrument = (code: unknown): Instrument => {
  const i = INSTRUMENT_BY_CODE.get(String(code));
  if (!i) throw new HttpError(400, 'INSTRUMENT_UNKNOWN', 'Choose a questionnaire from the list.');
  return i;
};
const library = () => INSTRUMENTS.map((i) => ({ code: i.code, version: i.version, name: i.name, purpose: i.purpose, source: i.source, licence: i.licence, preamble: i.preamble, items: i.items, selfComplete: i.selfComplete, repeatDays: i.repeatDays }));
const options = () => ({ modes: MODES, instruments: library() });

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'instrument_use', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

function shape(store: Store, r: Row, manage: boolean) {
  const inst = INSTRUMENT_BY_CODE.get(String(r.code));
  const responses: Record<string, number> = r.responsesJson ? JSON.parse(String(r.responsesJson)) : {};
  const flags: string[] = r.flagsJson ? JSON.parse(String(r.flagsJson)) : [];
  const band = inst?.bands.find((b) => b.label === r.band);
  const previous = r.administeredAt ? store.get<Row>(
    `SELECT score, band, administered_at AS at FROM instrument_use WHERE person_id = ? AND instrument_code = ? AND state IN ('COMPLETED', 'INTERPRETED')
       AND administered_at < ? ORDER BY administered_at DESC LIMIT 1`, String(r.personId), String(r.code), String(r.administeredAt)) ?? null : null;
  const actions: string[] = [];
  if (manage && r.state === 'REQUESTED') actions.push('complete', 'decline', 'cancel');
  if (manage && r.state === 'COMPLETED') actions.push('interpret');
  const { responsesJson: _r, flagsJson: _f, ...rest } = r;
  return {
    ...rest, state: String(r.state), name: inst?.name ?? String(r.code), stateLabel: STATES[String(r.state)], modeLabel: r.mode ? MODES[String(r.mode)] : null,
    answers: inst && r.responsesJson ? inst.items.map((it) => ({ text: it.text, answer: it.options[responses[it.id]]?.label ?? '', score: it.options[responses[it.id]]?.score ?? null })) : [],
    maxScore: inst ? inst.items.reduce((n, it) => n + Math.max(...it.options.map((o) => o.score)), 0) : null,
    tone: band?.tone ?? null, flags, previous,
    overdue: r.state === 'REQUESTED' && String(r.dueAt) < now(),
    actions, history: history(store, 'instrument', String(r.id)),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${USE} WHERE u.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That questionnaire is no longer in SHIFT.');
  return r;
};

function insertRequest(store: Store, ctx: WorkContext, personId: string, inst: Instrument, reason: string, due: string, repeatOf: string | null) {
  const id = newId();
  store.insert('instrument_use', {
    id, person_id: personId, service_id: ctx.serviceId, instrument_code: inst.code, instrument_version: inst.version, state: 'REQUESTED',
    reason, due_at: due, requested_by: ctx.workerId, requested_at: now(), repeat_of: repeatOf,
  });
  recordInitial(store, 'instrument', id, 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, `${inst.name}: ${reason}`);
  return id;
}

export function request(store: Store, ctx: WorkContext, personId: string, b: { code?: string; reason?: string; dueAt?: string }) {
  enforce(store, ctx, { op: 'INSTRUMENT', personId }, personId);
  const inst = instrument(b.code);
  const reason = text(b.reason, 300);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why it is being used, e.g. "low mood since admission".');
  const due = b.dueAt ? new Date(String(b.dueAt)) : new Date();
  if (Number.isNaN(due.getTime())) throw new HttpError(400, 'DUE_INVALID', 'Choose when it is due.');
  if (store.get("SELECT 1 FROM instrument_use WHERE person_id = ? AND instrument_code = ? AND state = 'REQUESTED'", personId, inst.code)) {
    throw new HttpError(409, 'ALREADY_DUE', `A ${inst.code} is already due for them.`);
  }
  store.tx(() => {
    const id = insertRequest(store, ctx, personId, inst, reason, due.toISOString(), null);
    logged(store, ctx, 'INSTRUMENT_REQUEST', personId, id, `${inst.code}: ${reason}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { mode?: string; responses?: Record<string, unknown>; note?: string; interpretation?: string; action?: string; repeatDays?: string | number }) {
  const r = load(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'INSTRUMENT', personId }, personId);
  const inst = instrument(r.code);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const inState = (s: string, msg: string) => { if (r.state !== s) throw new HttpError(409, 'WRONG_STATE', msg); };
  switch (action) {
    case 'complete': {
      inState('REQUESTED', 'This has already been done or closed.');
      if (inst.version !== r.version) throw new HttpError(409, 'VERSION_CHANGED', `This was asked for as ${r.version}; SHIFT now has ${inst.version}. Cancel it and ask again.`);
      const mode = MODES[String(b.mode)] ? String(b.mode) : 'STAFF_ASKED';
      if (mode === 'SELF_COMPLETED' && !inst.selfComplete) throw new HttpError(400, 'NOT_SELF', `${inst.code} is done by a clinician, not filled in by the person.`);
      const given = b.responses ?? {};
      const responses: Record<string, number> = {};
      const missing: number[] = [];
      inst.items.forEach((it, n) => {
        const v = Number(given[it.id]);
        if (!Number.isInteger(v) || v < 0 || v >= it.options.length) missing.push(n + 1);
        else responses[it.id] = v;
      });
      if (missing.length) throw new HttpError(400, 'INCOMPLETE', `Answer every item. Missing: ${missing.join(', ')}.`);
      const score = inst.items.reduce((n, it) => n + it.options[responses[it.id]].score, 0);
      const band = inst.bands.find((x) => score >= x.min && score <= x.max)?.label ?? null;
      const flags = inst.flags.filter((f) => inst.items.find((it) => it.id === f.item)!.options[responses[f.item]].score >= f.atLeast).map((f) => f.text);
      store.tx(() => {
        transition(store, 'instrument', id, 'COMPLETED', who, `${inst.code} score ${score}${band ? ` (${band})` : ''}`);
        store.run('UPDATE instrument_use SET mode = ?, administered_by = ?, administered_at = ?, responses_json = ?, score = ?, band = ?, flags_json = ? WHERE id = ?',
          mode, ctx.workerId, at, JSON.stringify(responses), score, band, flags.length ? JSON.stringify(flags) : null, id);
        logged(store, ctx, 'INSTRUMENT_COMPLETE', personId, id, `${inst.code} ${score}`);
      });
      break;
    }
    case 'decline':
    case 'cancel': {
      inState('REQUESTED', 'This has already been done or closed.');
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', action === 'decline' ? 'Write what they said.' : 'Write why it is no longer needed.');
      store.tx(() => {
        transition(store, 'instrument', id, action === 'decline' ? 'DECLINED' : 'CANCELLED', who, note);
        store.run('UPDATE instrument_use SET closed_reason = ? WHERE id = ?', note, id);
        logged(store, ctx, `INSTRUMENT_${action.toUpperCase()}`, personId, id, note);
      });
      break;
    }
    case 'interpret': {
      inState('COMPLETED', 'This has already been interpreted.');
      const interpretation = text(b.interpretation, 1000);
      if (interpretation.length < 10) throw new HttpError(400, 'INTERPRETATION_REQUIRED', 'Write what the result means for this person.');
      const done = text(b.action, 1000);
      const tone = inst.bands.find((x) => x.label === r.band)?.tone;
      if ((r.flagsJson || tone === 'danger') && done.length < 5) throw new HttpError(400, 'ACTION_REQUIRED', 'This result needs action. Write what was done.');
      const days = Number(b.repeatDays ?? 0);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, 'REPEAT_RANGE', 'Repeat in 0 to 365 days (0 for no repeat).');
      store.tx(() => {
        transition(store, 'instrument', id, 'INTERPRETED', who, interpretation);
        let next: string | null = null;
        if (days > 0) next = insertRequest(store, ctx, personId, inst, `Repeat of ${inst.code} (score ${r.score})`, new Date(Date.now() + days * 24 * 3600_000).toISOString(), id);
        store.run('UPDATE instrument_use SET interpreted_by = ?, interpreted_at = ?, interpretation = ?, action = ?, next_id = ? WHERE id = ?',
          ctx.workerId, at, interpretation, done || null, next, id);
        logged(store, ctx, 'INSTRUMENT_INTERPRET', personId, id, interpretation);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Questionnaires view: what is due, what needs interpreting, and results over time.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = may(store, ctx, personId);
  const rows = store.all<Row>(`${USE} WHERE u.person_id = ? ORDER BY COALESCE(u.administered_at, u.due_at) DESC`, personId).map((r) => shape(store, r, manage));
  return {
    open: rows.filter((r) => r.state === 'REQUESTED' || r.state === 'COMPLETED'),
    done: rows.filter((r) => r.state === 'INTERPRETED'),
    closed: rows.filter((r) => r.state === 'DECLINED' || r.state === 'CANCELLED'),
    canUse: manage, options: options(),
  };
}

// For the record header: safety flags on results no clinician has interpreted yet.
export function current(store: Store, personId: string) {
  const rows = store.all<Row>("SELECT instrument_code AS code, flags_json AS flags FROM instrument_use WHERE person_id = ? AND state = 'COMPLETED' AND flags_json IS NOT NULL", personId);
  return rows.length ? rows.map((r) => ({ code: r.code, flags: JSON.parse(String(r.flags)) as string[] })) : null;
}

// Home → Questionnaires: flagged and to-interpret results first, then what is due in the next day.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('instrument.use')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include questionnaires`);
  const inService = "u.person_id IN (SELECT person_id FROM encounter WHERE service_id = ? AND state = 'ACTIVE' UNION SELECT person_id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL)";
  const toInterpret = store.all<Row>(`${USE} WHERE ${inService} AND u.state = 'COMPLETED' ORDER BY u.flags_json IS NULL, u.administered_at`, ctx.serviceId, ctx.serviceId)
    .map((r) => shape(store, r, true));
  const due = store.all<Row>(`${USE} WHERE ${inService} AND u.state = 'REQUESTED' AND u.due_at <= ? ORDER BY u.due_at`, ctx.serviceId, ctx.serviceId,
    new Date(Date.now() + 24 * 3600_000).toISOString()).map((r) => shape(store, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_QUESTIONNAIRES', decision: 'ALLOW', outcome: 'VIEWED' });
  return { toInterpret, due, options: options() };
}
