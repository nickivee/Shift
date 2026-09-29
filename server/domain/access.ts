import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history, revise } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Interpreter / communication accessibility requirement (Shared Lifecycle Object 253):
//   need identified → requirement recorded → service arrangement → interpreter / support booked
//   → provided → outcome → continuing requirement reviewed.
// A need belongs to the person, so every service caring for them sees it. The Code of Rights
// (Right 5, LAW-NZ-005) gives the right to effective communication and a competent interpreter
// where necessary and reasonably practicable. Using whānau to interpret is allowed but recorded,
// with why, so it can be seen later.

type Row = Record<string, string | number | null>;
const KINDS: Record<string, string> = {
  INTERPRETER: 'Spoken-language interpreter', NZSL: 'NZ Sign Language interpreter', HEARING: 'Hearing', VISION: 'Sight',
  SPEECH: 'Speech', UNDERSTANDING: 'Understanding or memory', READING: 'Reading and writing', OTHER: 'Other',
};
const WHEN: Record<string, string> = { ALWAYS: 'Every conversation', IMPORTANT: 'Important conversations', SOMETIMES: 'Some situations' };
const MODES: Record<string, string> = { IN_PERSON: 'In person', PHONE: 'Phone', VIDEO: 'Video' };
const STATES: Record<string, string> = {
  REQUESTED: 'Needs booking', BOOKED: 'Booked', PROVIDED: 'Provided', NOT_PROVIDED: 'Did not happen', CANCELLED: 'Cancelled',
};
const INTERPRETED = ['INTERPRETER', 'NZSL'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-005'];

const NEED = `
  SELECT n.id, n.state, n.person_id AS personId, n.kind, n.language, n.detail, n.when_needed AS whenNeeded, n.review_date AS reviewDate,
         rb.display_name AS recordedBy, n.recorded_at AS recordedAt, vb.display_name AS reviewedBy, n.reviewed_at AS reviewedAt,
         eb.display_name AS endedBy, n.ended_at AS endedAt, n.end_reason AS endReason
    FROM comm_need n
    JOIN workforce_person rb ON rb.id = n.recorded_by
    LEFT JOIN workforce_person vb ON vb.id = n.reviewed_by
    LEFT JOIN workforce_person eb ON eb.id = n.ended_by`;

const BOOKING = `
  SELECT b.id, b.state, b.need_id AS needId, b.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = b.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         n.kind, n.language, b.purpose, b.mode, b.needed_at AS neededAt, s.name AS service,
         rb.display_name AS requestedBy, b.requested_at AS requestedAt, b.provider, b.reference, b.interpreter,
         bb.display_name AS bookedBy, b.booked_at AS bookedAt, b.outcome, b.family_interpreted AS familyInterpreted,
         cb.display_name AS closedBy, b.closed_at AS closedAt
    FROM interpreter_booking b
    JOIN comm_need n ON n.id = b.need_id
    JOIN person p ON p.id = b.person_id
    JOIN service s ON s.id = b.service_id
    JOIN workforce_person rb ON rb.id = b.requested_by
    LEFT JOIN workforce_person bb ON bb.id = b.booked_by
    LEFT JOIN workforce_person cb ON cb.id = b.closed_by`;

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'ACCESS', personId }).decision === 'ALLOW';
const needLabel = (r: Row) => (r.kind === 'INTERPRETER' && r.language ? `${r.language} interpreter` : KINDS[String(r.kind)]);

function shapeNeed(store: Store, r: Row, manage: boolean) {
  const active = r.state === 'ACTIVE';
  const actions: string[] = [];
  if (active && manage) actions.push(...(INTERPRETED.includes(String(r.kind)) ? ['book'] : []), 'review', 'end');
  return {
    ...r, label: needLabel(r), kindLabel: KINDS[String(r.kind)], whenLabel: WHEN[String(r.whenNeeded)],
    interpreted: INTERPRETED.includes(String(r.kind)), reviewDue: active && !!r.reviewDate && String(r.reviewDate) <= todayLocal(), actions,
    changes: history(store, 'commneed', String(r.id)).filter((x) => x.from_state === x.to_state),
  };
}

function shapeBooking(store: Store, r: Row, manage: boolean) {
  const actions: string[] = [];
  if (manage && r.state === 'REQUESTED') actions.push('booked', 'provided', 'cancel');
  if (manage && r.state === 'BOOKED') actions.push('provided', 'notProvided', 'cancel');
  return {
    ...r, label: needLabel(r), modeLabel: MODES[String(r.mode)], stateLabel: STATES[String(r.state)], familyInterpreted: !!r.familyInterpreted,
    due: ['REQUESTED', 'BOOKED'].includes(String(r.state)) && String(r.neededAt) <= new Date(Date.now() + 24 * 3600_000).toISOString(),
    actions, history: history(store, 'interpreter', String(r.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, type: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: type, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const options = () => ({ kinds: KINDS, when: WHEN, modes: MODES });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = may(store, ctx, personId);
  const needs = store.all<Row>(`${NEED} WHERE n.person_id = ? AND n.state = 'ACTIVE' ORDER BY n.recorded_at`, personId).map((r) => shapeNeed(store, r, manage));
  const ended = store.all<Row>(`${NEED} WHERE n.person_id = ? AND n.state = 'ENDED' ORDER BY n.ended_at DESC`, personId).map((r) => shapeNeed(store, r, false));
  const bookings = store.all<Row>(`${BOOKING} WHERE b.person_id = ? ORDER BY b.state IN ('REQUESTED', 'BOOKED') DESC, b.needed_at DESC LIMIT 20`, personId)
    .map((r) => shapeBooking(store, r, manage));
  return { needs, ended, bookings, canManage: manage, options: options() };
}

// For the record header: every current need, in a few words.
export function current(store: Store, personId: string) {
  const rows = store.all<Row>("SELECT kind, language, detail FROM comm_need WHERE person_id = ? AND state = 'ACTIVE' ORDER BY recorded_at", personId);
  return rows.length ? rows.map((r) => ({ label: needLabel(r), detail: r.detail })) : null;
}

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);

interface NeedFields { kind?: string; language?: string; detail?: string; whenNeeded?: string; reviewDate?: string }
function cleanNeed(b: NeedFields) {
  const kind = KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose the kind of need.');
  const language = text(b.language, 80);
  if (kind === 'INTERPRETER' && language.length < 2) throw new HttpError(400, 'LANGUAGE_REQUIRED', 'Write the language.');
  const detail = text(b.detail);
  if (detail.length < 3) throw new HttpError(400, 'DETAIL_REQUIRED', 'Write what helps, e.g. "hearing aid in the left ear, face her when speaking".');
  return {
    kind, language: kind === 'INTERPRETER' ? language : null, detail, when_needed: WHEN[String(b.whenNeeded)] ? String(b.whenNeeded) : 'ALWAYS',
    review_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null,
  };
}

export function addNeed(store: Store, ctx: WorkContext, personId: string, b: NeedFields) {
  enforce(store, ctx, { op: 'ACCESS', personId }, personId);
  const v = cleanNeed(b);
  const id = newId();
  store.tx(() => {
    store.insert('comm_need', { id, person_id: personId, ...v, state: 'ACTIVE', recorded_by: ctx.workerId, recorded_at: now() });
    recordInitial(store, 'commneed', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, v.detail);
    logged(store, ctx, 'COMM_NEED_RECORD', personId, 'comm_need', id, v.detail);
  });
  return { id };
}

const loadNeed = (store: Store, id: string) => {
  const r = store.get<Row>(`${NEED} WHERE n.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That need is no longer recorded.');
  return r;
};

export function actNeed(store: Store, ctx: WorkContext, id: string, action: string,
  b: NeedFields & { note?: string; purpose?: string; mode?: string; neededAt?: string }) {
  const r = loadNeed(store, id);
  const personId = String(r.personId);
  if (r.state !== 'ACTIVE') throw new HttpError(409, 'ENDED', 'This need is no longer recorded as current.');
  enforce(store, ctx, { op: 'ACCESS', personId }, personId);
  const at = now();
  switch (action) {
    case 'book': {
      if (!INTERPRETED.includes(String(r.kind))) throw new HttpError(409, 'NOT_INTERPRETER', 'Only interpreter needs are booked.');
      const purpose = text(b.purpose, 300);
      if (purpose.length < 3) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Write what the interpreter is for, e.g. "family meeting about going home".');
      const mode = MODES[String(b.mode)] ? String(b.mode) : 'IN_PERSON';
      const d = new Date(String(b.neededAt));
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'WHEN_REQUIRED', 'Choose when the interpreter is needed.');
      const bid = newId();
      store.tx(() => {
        store.insert('interpreter_booking', {
          id: bid, need_id: id, person_id: personId, service_id: ctx.serviceId, purpose, mode, needed_at: d.toISOString(), state: 'REQUESTED',
          requested_by: ctx.workerId, requested_at: at,
        });
        recordInitial(store, 'interpreter', bid, 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, purpose);
        logged(store, ctx, 'INTERPRETER_REQUEST', personId, 'interpreter_booking', bid, purpose);
      });
      break;
    }
    case 'review': {
      const v = cleanNeed({ ...b, kind: String(r.kind) });
      store.tx(() => {
        const before = store.get<Record<string, unknown>>('SELECT * FROM comm_need WHERE id = ?', id)!;
        const changed = revise(store, 'commneed', id, before, v, { language: 'Language', detail: 'What helps', when_needed: ['When needed', WHEN], review_date: 'Review by' },
          { actorId: ctx.workerId, workContextId: ctx.id }, `Reviewed: ${v.detail}`);
        store.run('UPDATE comm_need SET language = ?, detail = ?, when_needed = ?, review_date = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
          v.language, v.detail, v.when_needed, v.review_date, ctx.workerId, at, id);
        store.insert('state_transition', { id: newId(), object_type: 'commneed', object_id: id, from_state: 'ACTIVE', to_state: 'ACTIVE', actor_id: ctx.workerId, work_context_id: ctx.id, at, reason: `Reviewed: ${v.detail}${changed ? `. Changed ${changed}` : ''}`, transaction_id: null });
        logged(store, ctx, 'COMM_NEED_REVIEW', personId, 'comm_need', id, v.detail);
      });
      break;
    }
    case 'end': {
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is no longer needed.');
      store.tx(() => {
        transition(store, 'commneed', id, 'ENDED', { actorId: ctx.workerId, workContextId: ctx.id }, note);
        store.run('UPDATE comm_need SET ended_by = ?, ended_at = ?, end_reason = ? WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'COMM_NEED_END', personId, 'comm_need', id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

const loadBooking = (store: Store, id: string) => {
  const r = store.get<Row>(`${BOOKING} WHERE b.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That booking no longer exists.');
  return r;
};

export function actBooking(store: Store, ctx: WorkContext, id: string, action: string,
  b: { provider?: string; reference?: string; interpreter?: string; outcome?: string; familyInterpreted?: boolean | string; note?: string }) {
  const r = loadBooking(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'ACCESS', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const open = (states: string[]) => { if (!states.includes(String(r.state))) throw new HttpError(409, 'WRONG_STATE', 'This booking has already been closed.'); };
  switch (action) {
    case 'booked': {
      open(['REQUESTED']);
      const provider = text(b.provider, 200);
      if (provider.length < 2) throw new HttpError(400, 'PROVIDER_REQUIRED', 'Write the interpreting service booked.');
      store.tx(() => {
        transition(store, 'interpreter', id, 'BOOKED', who, provider);
        store.run('UPDATE interpreter_booking SET provider = ?, reference = ?, interpreter = ?, booked_by = ?, booked_at = ? WHERE id = ?',
          provider, text(b.reference, 100) || null, text(b.interpreter, 200) || null, ctx.workerId, at, id);
        logged(store, ctx, 'INTERPRETER_BOOK', personId, 'interpreter_booking', id, provider);
      });
      break;
    }
    case 'provided':
    case 'notProvided': {
      open(['REQUESTED', 'BOOKED']);
      const outcome = text(b.outcome, 1000);
      const family = b.familyInterpreted === true || b.familyInterpreted === 'true';
      if (outcome.length < 3) {
        throw new HttpError(400, 'OUTCOME_REQUIRED', action === 'provided' ? 'Write how it went and whether they understood.' : 'Write what happened instead, and what is next.');
      }
      if (family && outcome.length < 20) throw new HttpError(400, 'FAMILY_REASON_REQUIRED', 'Whānau interpreted: write why a professional interpreter was not used.');
      const to = action === 'provided' ? 'PROVIDED' : 'NOT_PROVIDED';
      store.tx(() => {
        if (r.state === 'REQUESTED') transition(store, 'interpreter', id, 'BOOKED', who, 'Arranged on the spot');
        transition(store, 'interpreter', id, to, who, outcome);
        store.run('UPDATE interpreter_booking SET outcome = ?, family_interpreted = ?, closed_by = ?, closed_at = ? WHERE id = ?', outcome, family ? 1 : 0, ctx.workerId, at, id);
        logged(store, ctx, `INTERPRETER_${to}`, personId, 'interpreter_booking', id, outcome);
      });
      break;
    }
    case 'cancel': {
      open(['REQUESTED', 'BOOKED']);
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is cancelled.');
      store.tx(() => {
        transition(store, 'interpreter', id, 'CANCELLED', who, note);
        store.run('UPDATE interpreter_booking SET outcome = ?, closed_by = ?, closed_at = ? WHERE id = ?', note, ctx.workerId, at, id);
        logged(store, ctx, 'INTERPRETER_CANCEL', personId, 'interpreter_booking', id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do with a booking.');
  }
  return shapeBooking(store, loadBooking(store, id), true);
}

// Home → Interpreters: bookings to arrange or coming up in this service, and needs due review.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('access.manage')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include interpreters`);
  }
  const bookings = store.all<Row>(
    `${BOOKING} WHERE b.service_id = ? AND (b.state IN ('REQUESTED', 'BOOKED') OR b.closed_at >= ?) ORDER BY b.state IN ('REQUESTED', 'BOOKED') DESC, b.needed_at`,
    ctx.serviceId, new Date(Date.now() - 24 * 3600_000).toISOString(),
  ).map((r) => shapeBooking(store, r, true));
  const needs = store.all<Row>(
    `${NEED} WHERE n.state = 'ACTIVE' AND n.person_id IN (SELECT person_id FROM encounter WHERE service_id = ? AND state = 'ACTIVE') ORDER BY n.recorded_at`, ctx.serviceId,
  ).map((r) => ({ ...shapeNeed(store, r, true), patient: store.get<{ n: string }>("SELECT given_name || ' ' || family_name AS n FROM person WHERE id = ?", String(r.personId))?.n }));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_INTERPRETERS', decision: 'ALLOW', outcome: 'VIEWED' });
  return { bookings, needs, options: options() };
}
