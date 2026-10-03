import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { REVIEW_STATES, HOLD_STATES, DECISION, REFS } from '../config/retention.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Records retention, legal hold and disposal (entries 27, 28):
//   hold: placed with who asked and why → released with a reason.
//   review: a record is identified for review → decided against the rule the privacy officer names
//   (keep, dispose, or send to another provider) → carried out with evidence.
// A record on hold cannot be disposed of. SHIFT deletes nothing and sets no retention period.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const mayManage = (ctx: WorkContext) => (ctx.role.capabilities as string[]).includes('privacy.manage');

const HOLD = `
  SELECT h.id, h.state, h.person_id AS personId, p.given_name || ' ' || p.family_name AS person,
         (SELECT value FROM external_identifier WHERE person_id = h.person_id AND system = 'NHI') AS nhi,
         h.reason, h.asked_by AS askedBy, h.reference, pb.display_name AS placedBy, h.placed_at AS placedAt,
         rb.display_name AS releasedBy, h.released_at AS releasedAt, h.release_note AS releaseNote
    FROM records_hold h JOIN person p ON p.id = h.person_id
    JOIN workforce_person pb ON pb.id = h.placed_by
    LEFT JOIN workforce_person rb ON rb.id = h.released_by`;

const REVIEW = `
  SELECT v.id, v.state, v.person_id AS personId, p.given_name || ' ' || p.family_name AS person,
         (SELECT value FROM external_identifier WHERE person_id = v.person_id AND system = 'NHI') AS nhi,
         v.scope, v.why, v.decision, v.basis, v.decision_note AS decisionNote, db.display_name AS decidedBy, v.decided_at AS decidedAt,
         v.done_note AS doneNote, nb.display_name AS doneBy, v.done_at AS doneAt, v.raised_at AS raisedAt,
         EXISTS (SELECT 1 FROM records_hold h WHERE h.person_id = v.person_id AND h.state = 'ACTIVE') AS onHold
    FROM records_review v JOIN person p ON p.id = v.person_id
    LEFT JOIN workforce_person db ON db.id = v.decided_by
    LEFT JOIN workforce_person nb ON nb.id = v.done_by`;

const holdShape = (r: Row): Record<string, any> => ({ ...r, stateLabel: HOLD_STATES[String(r.state)], canRelease: r.state === 'ACTIVE' });
const reviewShape = (r: Row): Record<string, any> => ({
  ...r, onHold: !!r.onHold, stateLabel: REVIEW_STATES[String(r.state)], decisionLabel: r.decision ? DECISION[String(r.decision)] : null,
  actions: r.state === 'DUE' ? ['decide'] : r.state === 'DECIDED' ? ['done'] : [],
});

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, type: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: type, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}

function gate(ctx: WorkContext) {
  if (!mayManage(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include records retention`);
}
const personByNhi = (store: Store, v: unknown) => {
  const nhi = text(v, 20).toUpperCase().replace(/\s/g, '');
  if (!nhi) throw new HttpError(400, 'NHI_REQUIRED', 'Write the NHI of the person whose record this is.');
  const p = store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'No one in SHIFT has that NHI. Check it.');
  return p.id;
};

// For the record header: is a legal hold in place?
export function onHold(store: Store, personId: string) {
  return !!store.get("SELECT 1 FROM records_hold WHERE person_id = ? AND state = 'ACTIVE'", personId);
}

export function list(store: Store, ctx: WorkContext) {
  gate(ctx);
  enforce(store, ctx, { op: 'PRIVACY', organisationId: ctx.organisationId });
  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const holds = (w: string, ...a: unknown[]) => store.all<Row>(`${HOLD} WHERE h.organisation_id = ? AND ${w}`, ctx.organisationId, ...a).map(holdShape);
  const reviews = (w: string, ...a: unknown[]) => store.all<Row>(`${REVIEW} WHERE v.organisation_id = ? AND ${w}`, ctx.organisationId, ...a).map(reviewShape);
  return {
    holds: holds("h.state = 'ACTIVE' ORDER BY h.placed_at"),
    released: holds("h.state = 'RELEASED' AND h.released_at >= ? ORDER BY h.released_at DESC", since),
    toDecide: reviews("v.state = 'DUE' ORDER BY v.raised_at"),
    toDo: reviews("v.state = 'DECIDED' ORDER BY v.decided_at"),
    done: reviews("v.state = 'DONE' AND v.done_at >= ? ORDER BY v.done_at DESC", since),
    options: { decision: DECISION },
  };
}

export function placeHold(store: Store, ctx: WorkContext, b: { nhi?: string; reason?: string; askedBy?: string; reference?: string }) {
  gate(ctx);
  enforce(store, ctx, { op: 'PRIVACY', organisationId: ctx.organisationId });
  const personId = personByNhi(store, b.nhi);
  const reason = text(b.reason);
  if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Say why the record is on hold, e.g. "Coroner has asked for the record".');
  const askedBy = text(b.askedBy, 200);
  if (askedBy.length < 3) throw new HttpError(400, 'ASKED_REQUIRED', 'Say who asked for the hold, e.g. "Coroner\'s office".');
  if (store.get("SELECT 1 FROM records_hold WHERE person_id = ? AND state = 'ACTIVE'", personId)) throw new HttpError(409, 'ALREADY', 'This record is already on hold. Release that hold first if this one replaces it.');
  const id = newId();
  store.tx(() => {
    store.insert('records_hold', { id, organisation_id: ctx.organisationId, person_id: personId, state: 'ACTIVE', reason, asked_by: askedBy, reference: text(b.reference, 120) || null, placed_by: ctx.workerId, placed_at: now() });
    recordInitial(store, 'records_hold', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, reason);
    logged(store, ctx, 'RECORDS_HOLD_PLACE', personId, 'records_hold', id, `${askedBy}: ${reason}`);
  });
  return list(store, ctx);
}

export function releaseHold(store: Store, ctx: WorkContext, id: string, b: { note?: string }) {
  gate(ctx);
  const h = store.get<Row>('SELECT id, person_id AS personId, organisation_id AS org, state FROM records_hold WHERE id = ?', id);
  if (!h) throw new HttpError(404, 'NOT_FOUND', 'That hold is no longer in SHIFT.');
  enforce(store, ctx, { op: 'PRIVACY', organisationId: String(h.org) });
  if (h.state !== 'ACTIVE') throw new HttpError(409, 'WRONG_STATE', 'That hold has already been released.');
  const note = text(b.note);
  if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why the hold is released and who said so, e.g. "Coroner\'s office confirmed the file is closed".');
  store.tx(() => {
    transition(store, 'records_hold', id, 'RELEASED', { actorId: ctx.workerId, workContextId: ctx.id }, note.slice(0, 160));
    store.run('UPDATE records_hold SET release_note = ?, released_by = ?, released_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
    logged(store, ctx, 'RECORDS_HOLD_RELEASE', String(h.personId), 'records_hold', id, note);
  });
  return list(store, ctx);
}

export function openReview(store: Store, ctx: WorkContext, b: { nhi?: string; scope?: string; why?: string }) {
  gate(ctx);
  enforce(store, ctx, { op: 'PRIVACY', organisationId: ctx.organisationId });
  const personId = personByNhi(store, b.nhi);
  const scope = text(b.scope);
  if (scope.length < 5) throw new HttpError(400, 'SCOPE_REQUIRED', 'Say which records, e.g. "Paper file and electronic record of the 2019 stay".');
  const why = text(b.why);
  if (why.length < 5) throw new HttpError(400, 'WHY_REQUIRED', 'Say why it is being reviewed, e.g. "Stay ended; due for retention review".');
  const id = newId();
  store.tx(() => {
    store.insert('records_review', { id, organisation_id: ctx.organisationId, person_id: personId, state: 'DUE', scope, why, raised_by: ctx.workerId, raised_at: now() });
    recordInitial(store, 'records_review', id, 'DUE', { actorId: ctx.workerId, workContextId: ctx.id }, why);
    logged(store, ctx, 'RECORDS_REVIEW_OPEN', personId, 'records_review', id, `${scope}: ${why}`);
  });
  return list(store, ctx);
}

export function actReview(store: Store, ctx: WorkContext, id: string, action: string, b: { decision?: string; basis?: string; note?: string }) {
  gate(ctx);
  const v = store.get<Row>(`SELECT id, person_id AS personId, organisation_id AS org, state, decision FROM records_review WHERE id = ?`, id);
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'That review is no longer in SHIFT.');
  enforce(store, ctx, { op: 'PRIVACY', organisationId: String(v.org) });
  const personId = String(v.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const held = () => { if (onHold(store, personId)) throw new HttpError(409, 'ON_HOLD', 'This record is on legal hold, so it cannot be disposed of. Release the hold first.'); };
  store.tx(() => {
    if (action === 'decide') {
      if (v.state !== 'DUE') throw new HttpError(409, 'WRONG_STATE', 'This review has already been decided.');
      const decision = DECISION[String(b.decision)] ? String(b.decision) : '';
      if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose what is decided.');
      const basis = text(b.basis, 500);
      if (basis.length < 5) throw new HttpError(400, 'BASIS_REQUIRED', 'Name the rule or period you are relying on, e.g. "Retention schedule item 4.2".');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what you found and why.');
      if (decision === 'DISPOSE') held();
      transition(store, 'records_review', id, 'DECIDED', who, `${DECISION[decision]}: ${note.slice(0, 140)}`);
      store.run('UPDATE records_review SET decision = ?, basis = ?, decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?', decision, basis, note, ctx.workerId, now(), id);
      logged(store, ctx, 'RECORDS_REVIEW_DECIDE', personId, 'records_review', id, `${DECISION[decision]} (${basis}): ${note}`);
    } else if (action === 'done') {
      if (v.state !== 'DECIDED') throw new HttpError(409, 'WRONG_STATE', 'Decide the review first.');
      if (v.decision === 'DISPOSE') held();
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what was done and how, e.g. "Paper file shredded by the contractor, certificate 4471". SHIFT does not delete anything itself.');
      transition(store, 'records_review', id, 'DONE', who, note.slice(0, 160));
      store.run('UPDATE records_review SET done_note = ?, done_by = ?, done_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
      logged(store, ctx, 'RECORDS_REVIEW_DONE', personId, 'records_review', id, note);
    } else throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  });
  return list(store, ctx);
}
