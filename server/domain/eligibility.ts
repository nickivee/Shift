import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { STATES, OUTCOMES, SOURCE_NOTE, REFS } from '../config/eligibility.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Eligibility (matrix: Eligibility tab for district and community nursing): each check of whether a person is eligible for
// publicly funded services, what the eligibility is based on and what was seen, in the checker's words, and the outcome.
// SHIFT sets no categories or evidence rules (RR-ELIGIBILITY-001) and decides nothing itself. The latest check stands as
// the current one; an earlier one is kept.

type Row = Record<string, string | number | null>;

const Q = `
  SELECT e.id, e.person_id AS personId, e.service_id AS serviceId, e.state, e.outcome, e.basis, e.evidence, e.checked_on AS checkedOn, e.note,
         rb.display_name AS recordedBy, e.recorded_at AS recordedAt, cb.display_name AS closedBy, e.closed_at AS closedAt, e.closed_note AS closedNote
    FROM eligibility_check e
    JOIN workforce_person rb ON rb.id = e.recorded_by
    LEFT JOIN workforce_person cb ON cb.id = e.closed_by`;

const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'ELIGIBILITY', personId }).decision === 'ALLOW';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'eligibility', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

function shape(r: Row, can: boolean, ctx: WorkContext) {
  const state = String(r.state);
  const actions: string[] = [];
  if (can && r.serviceId === ctx.serviceId && state !== 'ENTERED_IN_ERROR') actions.push('error');
  return { ...r, state, stateLabel: STATES[state], outcomeLabel: OUTCOMES.find((x) => x.code === r.outcome)?.label ?? String(r.outcome), actions };
}

export function record(store: Store, ctx: WorkContext, personId: string, b: { outcome?: string; checkedOn?: string; basis?: string; evidence?: string; note?: string }) {
  enforce(store, ctx, { op: 'ELIGIBILITY', personId }, personId);
  if (!OUTCOMES.some((x) => x.code === b.outcome)) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose the outcome of the check.');
  const checkedOn = text(b.checkedOn, 10);
  if (!DAY.test(checkedOn) || checkedOn > now().slice(0, 10)) throw new HttpError(400, 'DATE', 'Enter the date of the check. It cannot be in the future.');
  const basis = text(b.basis, 500);
  if (basis.length < 3) throw new HttpError(400, 'BASIS_REQUIRED', 'Write what the person\'s eligibility is based on, as the person or their documents say.');
  const evidence = text(b.evidence, 500);
  const note = text(b.note, 1000);
  if (b.outcome !== 'UNCONFIRMED' && evidence.length < 3) throw new HttpError(400, 'EVIDENCE_REQUIRED', 'Write what you saw or were told, e.g. "Passport seen".');
  if (b.outcome === 'UNCONFIRMED' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what is still needed to confirm it.');
  const id = newId();
  store.tx(() => {
    store.insert('eligibility_check', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'CHECKED', outcome: b.outcome, basis, evidence: evidence || null, checked_on: checkedOn,
      note: note || null, recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'eligibility', id, 'CHECKED', { actorId: ctx.workerId, workContextId: ctx.id }, basis.slice(0, 200));
    logged(store, ctx, 'ELIGIBILITY_RECORD', personId, id, `${b.outcome}: ${basis}`.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const r = store.get<Row>(`${Q} WHERE e.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That eligibility check is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'ELIGIBILITY', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that recorded this can act on it.');
  if (action !== 'error') throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  if (r.state === 'ENTERED_IN_ERROR') throw new HttpError(409, 'WRONG_STATE', 'This is already marked as entered in error.');
  const note = text(b.note);
  if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why, e.g. "Recorded on the wrong person".');
  store.tx(() => {
    transition(store, 'eligibility', id, 'ENTERED_IN_ERROR', { actorId: ctx.workerId, workContextId: ctx.id }, note.slice(0, 200));
    store.run('UPDATE eligibility_check SET closed_by = ?, closed_at = ?, closed_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
    logged(store, ctx, 'ELIGIBILITY_ERROR', personId, id, note.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

// The person's Eligibility view: the latest check, then earlier ones.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const rows = store.all<Row>(`${Q} WHERE e.person_id = ? AND e.service_id = ? ORDER BY e.checked_on DESC, e.recorded_at DESC`, personId, ctx.serviceId)
    .map((r) => ({ ...shape(r, can, ctx), history: history(store, 'eligibility', String(r.id)) }));
  const i = rows.findIndex((x) => x.state === 'CHECKED');
  return {
    current: i >= 0 ? rows[i] : null,
    earlier: rows.filter((_, n) => n !== i),
    canRecord: can,
    sourceNote: SOURCE_NOTE,
    options: { outcomes: OUTCOMES },
  };
}
