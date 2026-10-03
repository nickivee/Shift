import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { STATES, GIVEN_TO, UNDERSTANDING, REFS } from '../config/education.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Education (matrix: Education tab for general practice): what was explained to a person or their whanau, how
// well it was understood, and whether more teaching is needed. SHIFT sets no content or schedule (RR-EDUCATION-001).

type Row = Record<string, string | number | null>;

const Q = `
  SELECT e.id, e.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, e.service_id AS serviceId, e.state, e.given_at AS givenAt,
         e.topic, e.given_to AS givenTo, e.understanding, e.note, rb.display_name AS recordedBy, e.recorded_at AS recordedAt,
         cb.display_name AS closedBy, e.closed_at AS closedAt, e.closed_note AS closedNote
    FROM education_session e
    JOIN person p ON p.id = e.person_id
    JOIN workforce_person rb ON rb.id = e.recorded_by
    LEFT JOIN workforce_person cb ON cb.id = e.closed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'EDUCATION', personId }).decision === 'ALLOW';
const label = (list: { code: string; label: string }[], code: unknown) => list.find((x) => x.code === code)?.label ?? String(code);

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'education', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

function shape(r: Row, can: boolean, ctx: WorkContext) {
  const state = String(r.state);
  const actions: string[] = [];
  if (can && r.serviceId === ctx.serviceId) {
    if (state === 'FOLLOW_UP') actions.push('complete');
    if (state !== 'ENTERED_IN_ERROR') actions.push('error');
  }
  return { ...r, state, stateLabel: STATES[state], givenToLabel: label(GIVEN_TO, r.givenTo), understandingLabel: label(UNDERSTANDING, r.understanding), actions };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE e.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That education record is no longer in SHIFT.');
  return r;
};

export function record(store: Store, ctx: WorkContext, personId: string, b: { when?: string; topic?: string; givenTo?: string; understanding?: string; note?: string }) {
  enforce(store, ctx, { op: 'EDUCATION', personId }, personId);
  const t = Date.parse(String(b.when ?? ''));
  if (Number.isNaN(t) || t > Date.now() + 5 * 60_000 || t < Date.now() - 30 * 86_400_000) throw new HttpError(400, 'DATE', 'Enter when the education was given, within the last 30 days.');
  const topic = text(b.topic, 300);
  if (topic.length < 3) throw new HttpError(400, 'TOPIC_REQUIRED', 'Say what was explained, e.g. "Using the inhaler and spacer".');
  if (!GIVEN_TO.some((x) => x.code === b.givenTo)) throw new HttpError(400, 'GIVEN_TO_REQUIRED', 'Choose who it was given to.');
  if (!UNDERSTANDING.some((x) => x.code === b.understanding)) throw new HttpError(400, 'UNDERSTANDING_REQUIRED', 'Choose how well it was understood.');
  const note = text(b.note, 1000);
  if (b.understanding !== 'UNDERSTOOD' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what was not clear or what is needed next.');
  const state = b.understanding === 'PARTLY' || b.understanding === 'NEEDS_MORE' ? 'FOLLOW_UP' : 'DONE';
  const id = newId();
  store.tx(() => {
    store.insert('education_session', {
      id, person_id: personId, service_id: ctx.serviceId, state, given_at: new Date(t).toISOString(), topic, given_to: b.givenTo, understanding: b.understanding,
      note: note || null, recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'education', id, state, { actorId: ctx.workerId, workContextId: ctx.id }, topic.slice(0, 200));
    logged(store, ctx, 'EDUCATION_RECORD', personId, id, topic.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'EDUCATION', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that recorded this education can act on it.');
  const state = String(r.state);
  const note = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  if (action === 'complete') {
    if (state !== 'FOLLOW_UP') throw new HttpError(409, 'WRONG_STATE', `This education is ${STATES[state].toLowerCase()}.`);
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was done and how well it was understood, e.g. "Went through it again; showed it back correctly".');
    store.tx(() => {
      transition(store, 'education', id, 'DONE', who, note.slice(0, 200));
      store.run('UPDATE education_session SET closed_by = ?, closed_at = ?, closed_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
      logged(store, ctx, 'EDUCATION_COMPLETE', personId, id, note.slice(0, 200));
    });
  } else if (action === 'error') {
    if (state === 'ENTERED_IN_ERROR') throw new HttpError(409, 'WRONG_STATE', 'This education is already marked as entered in error.');
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why, e.g. "Recorded on the wrong person".');
    store.tx(() => {
      transition(store, 'education', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
      store.run('UPDATE education_session SET closed_by = ?, closed_at = ?, closed_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
      logged(store, ctx, 'EDUCATION_ERROR', personId, id, note.slice(0, 200));
    });
  } else {
    throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Education view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE e.person_id = ? AND e.service_id = ? ORDER BY e.given_at DESC`, personId, ctx.serviceId).map((r) => ({ ...shape(r, can, ctx), history: history(store, 'education', String(r.id)) }));
  return {
    more: all.filter((x) => x.state === 'FOLLOW_UP'),
    given: all.filter((x) => x.state !== 'FOLLOW_UP'),
    canRecord: can,
    options: { givenTo: GIVEN_TO, understanding: UNDERSTANDING },
  };
}

// Home → Education: people who need more teaching, and education given in the last week.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('education.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include education`);
  const since = `${addDays(todayLocal(), -7)}T00:00:00.000Z`;
  const rows = store.all<Row>(`${Q} WHERE e.service_id = ? AND (e.state = 'FOLLOW_UP' OR (e.state = 'DONE' AND e.given_at >= ?)) ORDER BY e.given_at DESC`, ctx.serviceId, since).map((r) => shape(r, false, ctx));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_EDUCATION', decision: 'ALLOW', outcome: 'VIEWED' });
  return { moreNeeded: rows.filter((x) => x.state === 'FOLLOW_UP'), recent: rows.filter((x) => x.state === 'DONE') };
}
