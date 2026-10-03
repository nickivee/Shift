import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { STATES, CALLERS, OUTCOMES, REFS } from '../config/afterhours.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// After-hours (matrix: After-hours tab for palliative care / hospice): a contact outside usual hours about a
// person in the service's care is recorded with who made it, the concern, the advice given and what came of it.
// It waits for the day team to review. SHIFT sets no response time, triage rule or advice (RR-AFTERHOURS-001).

type Row = Record<string, string | number | null>;

const Q = `
  SELECT a.id, a.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, a.service_id AS serviceId, a.state, a.contact_at AS contactAt,
         a.caller, a.concern, a.advice, a.outcome, a.outcome_note AS outcomeNote, rb.display_name AS recordedBy, a.recorded_at AS recordedAt,
         vb.display_name AS reviewedBy, a.reviewed_at AS reviewedAt, a.review_note AS reviewNote
    FROM afterhours_contact a
    JOIN person p ON p.id = a.person_id
    JOIN workforce_person rb ON rb.id = a.recorded_by
    LEFT JOIN workforce_person vb ON vb.id = a.reviewed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'AFTERHOURS', personId }).decision === 'ALLOW';
const label = (list: { code: string; label: string }[], code: unknown) => list.find((x) => x.code === code)?.label ?? String(code);

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'afterhours', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

function shape(r: Row, can: boolean, ctx: WorkContext) {
  const state = String(r.state);
  const actions: string[] = [];
  if (can && r.serviceId === ctx.serviceId) {
    if (state === 'OPEN') actions.push('review');
    if (state !== 'ENTERED_IN_ERROR') actions.push('error');
  }
  return { ...r, state, stateLabel: STATES[state], callerLabel: label(CALLERS, r.caller), outcomeLabel: label(OUTCOMES, r.outcome), actions };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE a.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That after-hours contact is no longer in SHIFT.');
  return r;
};

export function record(store: Store, ctx: WorkContext, personId: string, b: { when?: string; caller?: string; concern?: string; advice?: string; outcome?: string; note?: string }) {
  enforce(store, ctx, { op: 'AFTERHOURS', personId }, personId);
  const t = Date.parse(String(b.when ?? ''));
  if (Number.isNaN(t) || t > Date.now() + 5 * 60_000 || t < Date.now() - 30 * 86_400_000) throw new HttpError(400, 'DATE', 'Enter when the contact was made, within the last 30 days.');
  if (!CALLERS.some((x) => x.code === b.caller)) throw new HttpError(400, 'CALLER_REQUIRED', 'Choose who made contact.');
  const concern = text(b.concern, 1000);
  if (concern.length < 5) throw new HttpError(400, 'CONCERN_REQUIRED', 'Write what they were worried about, e.g. "Pain not settling since the evening dose".');
  const advice = text(b.advice, 1000);
  if (advice.length < 5) throw new HttpError(400, 'ADVICE_REQUIRED', 'Write the advice given or what was done.');
  if (!OUTCOMES.some((x) => x.code === b.outcome)) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose what came of the contact.');
  const note = text(b.note, 1000);
  if (b.outcome === 'OTHER' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what came of the contact.');
  const id = newId();
  store.tx(() => {
    store.insert('afterhours_contact', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'OPEN', contact_at: new Date(t).toISOString(), caller: b.caller, concern, advice, outcome: b.outcome,
      outcome_note: note || null, recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'afterhours', id, 'OPEN', { actorId: ctx.workerId, workContextId: ctx.id }, concern.slice(0, 200));
    logged(store, ctx, 'AFTERHOURS_RECORD', personId, id, concern.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'AFTERHOURS', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that recorded this contact can act on it.');
  const state = String(r.state);
  const note = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  if (action === 'review') {
    if (state !== 'OPEN') throw new HttpError(409, 'WRONG_STATE', `This contact is ${STATES[state].toLowerCase()}.`);
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what the day team did or decided, e.g. "Rang them; pain settled; dose changed".');
    store.tx(() => {
      transition(store, 'afterhours', id, 'REVIEWED', who, note.slice(0, 200));
      store.run('UPDATE afterhours_contact SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
      logged(store, ctx, 'AFTERHOURS_REVIEW', personId, id, note.slice(0, 200));
    });
  } else if (action === 'error') {
    if (state === 'ENTERED_IN_ERROR') throw new HttpError(409, 'WRONG_STATE', 'This contact is already marked as entered in error.');
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why, e.g. "Recorded on the wrong person".');
    store.tx(() => {
      transition(store, 'afterhours', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
      store.run('UPDATE afterhours_contact SET review_note = ? WHERE id = ?', note, id);
      logged(store, ctx, 'AFTERHOURS_ERROR', personId, id, note.slice(0, 200));
    });
  } else {
    throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's After-hours view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE a.person_id = ? AND a.service_id = ? ORDER BY a.contact_at DESC`, personId, ctx.serviceId).map((r) => ({ ...shape(r, can, ctx), history: history(store, 'afterhours', String(r.id)) }));
  return {
    open: all.filter((x) => x.state === 'OPEN'),
    past: all.filter((x) => x.state !== 'OPEN'),
    canRecord: can,
    options: { callers: CALLERS, outcomes: OUTCOMES },
  };
}

// Home → After-hours: contacts waiting for the day team, and those reviewed in the last week.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('afterhours.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include after-hours`);
  const since = `${addDays(todayLocal(), -7)}T00:00:00.000Z`;
  const rows = store.all<Row>(`${Q} WHERE a.service_id = ? AND (a.state = 'OPEN' OR a.reviewed_at >= ?) ORDER BY a.contact_at DESC`, ctx.serviceId, since).map((r) => shape(r, false, ctx));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_AFTERHOURS', decision: 'ALLOW', outcome: 'VIEWED' });
  return { toReview: rows.filter((x) => x.state === 'OPEN'), reviewed: rows.filter((x) => x.state === 'REVIEWED') };
}
