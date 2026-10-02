import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { DECISION, SENT_HOW, STATES, REQUEST_STATES, REFS } from '../config/coronial.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// The coroner's side of a death (entry 153): the record held for the coroner, the coroner's
// requests for information and the decision about each, and the findings with the service's
// response. Opened when a death is recorded as reported to the coroner.

type Row = Record<string, string | number | null>;
type Cap = 'death.manage' | 'coroner.decide';

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, serviceId: string, cap: Cap) => evaluate(store, ctx, { op: 'CORONIAL', serviceId, cap }).decision === 'ALLOW';

const Q = `
  SELECT c.id, c.death_id AS deathId, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, c.service_id AS serviceId,
         c.coroner_ref AS coronerRef, c.state, c.held_at AS heldAt, hb.display_name AS heldBy,
         c.findings_at AS findingsAt, c.findings, c.recommendations, fb.display_name AS findingsBy,
         c.response, c.responded_at AS respondedAt, rb.display_name AS respondedBy, c.closed_at AS closedAt, d.died_at AS diedAt
    FROM coronial_case c JOIN person p ON p.id = c.person_id JOIN death_event d ON d.id = c.death_id
    JOIN workforce_person hb ON hb.id = c.held_by
    LEFT JOIN workforce_person fb ON fb.id = c.findings_by
    LEFT JOIN workforce_person rb ON rb.id = c.responded_by`;

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'coronial', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS, engines: [153],
  });
}

const step = (store: Store, ctx: WorkContext, caseId: string, kind: string, body: string) =>
  store.insert('coronial_step', { id: newId(), case_id: caseId, kind, body, by_id: ctx.workerId, at: now() });

// Called when a death is recorded as reported to the coroner.
export function openCase(store: Store, ctx: WorkContext, deathId: string, personId: string, serviceId: string, ref: string | null) {
  if (store.get('SELECT 1 FROM coronial_case WHERE death_id = ?', deathId)) return;
  const id = newId();
  store.insert('coronial_case', { id, death_id: deathId, person_id: personId, service_id: serviceId, coroner_ref: ref, state: 'HELD', held_by: ctx.workerId, held_at: now() });
  recordInitial(store, 'coronial', id, 'HELD', { actorId: ctx.workerId, workContextId: ctx.id }, 'Reported to the coroner');
  step(store, ctx, id, 'HELD', 'Reported to the coroner. The record is held for the coroner from now.');
  logged(store, ctx, 'CORONIAL_HOLD', personId, id);
}

// Whether the record is held, for the record header.
export function held(store: Store, personId: string) {
  return Boolean(store.get("SELECT 1 FROM coronial_case WHERE person_id = ? AND state = 'HELD'", personId));
}

function requests(store: Store, caseId: string) {
  return store.all<Row>(
    `SELECT r.id, r.from_name AS fromName, r.ref, r.asked, r.received_at AS receivedAt, r.due_date AS dueDate, r.state,
            r.decision, r.basis, db.display_name AS decidedBy, r.decided_at AS decidedAt,
            r.sent_what AS sentWhat, r.sent_how AS sentHow, sb.display_name AS sentBy, r.sent_at AS sentAt, lb.display_name AS loggedBy
       FROM coronial_request r JOIN workforce_person lb ON lb.id = r.logged_by
       LEFT JOIN workforce_person db ON db.id = r.decided_by LEFT JOIN workforce_person sb ON sb.id = r.sent_by
      WHERE r.case_id = ? ORDER BY r.received_at`, caseId,
  ).map((r): Record<string, any> => ({
    ...r, stateLabel: REQUEST_STATES[String(r.state)], decisionLabel: r.decision ? DECISION[String(r.decision)] : null,
    sentHowLabel: r.sentHow ? SENT_HOW[String(r.sentHow)] : null,
    overdue: r.state !== 'SENT' && !!r.dueDate && String(r.dueDate) < todayLocal(),
  }));
}

function shape(store: Store, ctx: WorkContext, r: Row) {
  const id = String(r.id);
  const state = String(r.state);
  const canLog = may(store, ctx, String(r.serviceId), 'death.manage');
  const canDecide = may(store, ctx, String(r.serviceId), 'coroner.decide');
  const reqs = requests(store, id).map((q): Record<string, any> => ({
    ...q,
    can: state === 'CLOSED' ? [] : [
      ...(canDecide && ['RECEIVED', 'ADVICE'].includes(String(q.state)) ? ['decide'] : []),
      ...(canLog && q.state === 'DECIDED' ? ['send'] : []),
    ],
  }));
  const since = String(r.heldAt);
  const added = store.get<{ n: number }>('SELECT count(*) AS n FROM clinical_event WHERE person_id = ? AND recorded_at > ? AND supersedes_id IS NULL', String(r.personId), since)!.n;
  const changed = store.get<{ n: number }>('SELECT count(*) AS n FROM clinical_event WHERE person_id = ? AND recorded_at > ? AND supersedes_id IS NOT NULL', String(r.personId), since)!.n;
  const open = reqs.filter((q) => q.state !== 'SENT').length;
  const can: string[] = [];
  if (state !== 'CLOSED' && canLog) can.push('request');
  if (state === 'HELD' && canDecide) can.push('findings');
  if (state === 'FINDINGS' && canDecide && !r.respondedAt) can.push('respond');
  if (state === 'FINDINGS' && canDecide && r.respondedAt && !open) can.push('close');
  return {
    ...r, id, state, stateLabel: STATES[state], requests: reqs, openRequests: open, overdue: reqs.filter((q) => q.overdue).length,
    sinceHold: { added, changed }, can,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM coronial_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.case_id = ? ORDER BY s.at, s.rowid`, id),
    history: history(store, 'coronial', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That coroner\'s case is no longer in SHIFT.');
  return r;
};

// The person's Death view, under their death record.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const r = store.get<Row>(`${Q} WHERE c.person_id = ? ORDER BY c.held_at DESC LIMIT 1`, personId);
  return r ? shape(store, ctx, r) : null;
}

// Home → Deaths: every case for this service that is not closed.
export function list(store: Store, ctx: WorkContext) {
  return store.all<Row>(`${Q} WHERE c.service_id = ? AND c.state != 'CLOSED' ORDER BY c.held_at`, ctx.serviceId).map((r) => shape(store, ctx, r));
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Record<string, string | undefined>) {
  const r = load(store, id);
  const personId = String(r.personId);
  const serviceId = String(r.serviceId);
  const state = String(r.state);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  if (state === 'CLOSED') throw new HttpError(409, 'CLOSED', 'This coroner\'s case is closed.');
  switch (action) {
    case 'request': {
      enforce(store, ctx, { op: 'CORONIAL', serviceId, cap: 'death.manage' });
      const from = text(b.from, 200);
      const asked = text(b.asked);
      if (from.length < 3) throw new HttpError(400, 'FROM_REQUIRED', 'Write who the request is from, e.g. "Coronial investigator J. Ruru, Wellington".');
      if (asked.length < 10) throw new HttpError(400, 'ASKED_REQUIRED', 'Write what they asked for, word for word where you can.');
      const due = b.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) ? b.dueDate : null;
      const rid = newId();
      store.tx(() => {
        store.insert('coronial_request', { id: rid, case_id: id, from_name: from, ref: text(b.ref, 100) || null, asked, received_at: at, due_date: due, state: 'RECEIVED', logged_by: ctx.workerId });
        recordInitial(store, 'coronial_request', rid, 'RECEIVED', who, from);
        step(store, ctx, id, 'REQUEST', `Request from ${from}${due ? `, needed by ${due}` : ''}: ${asked}`);
        logged(store, ctx, 'CORONIAL_REQUEST', personId, id, from);
      });
      break;
    }
    case 'decide': {
      enforce(store, ctx, { op: 'CORONIAL', serviceId, cap: 'coroner.decide' });
      const q = store.get<Row>('SELECT * FROM coronial_request WHERE id = ? AND case_id = ?', b.requestId ?? '', id);
      if (!q) throw new HttpError(404, 'NOT_FOUND', 'That request is not part of this case.');
      if (!['RECEIVED', 'ADVICE'].includes(String(q.state))) throw new HttpError(409, 'DECIDED', 'That request has already been decided.');
      const decision = DECISION[String(b.decision)] ? String(b.decision) : '';
      if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose what will be released.');
      if (decision === 'ADVICE' && q.state === 'ADVICE') throw new HttpError(409, 'ALREADY_WAITING', 'This request is already waiting on advice. Record the decision once you have it.');
      const basis = text(b.basis);
      if (basis.length < 10) throw new HttpError(400, 'BASIS_REQUIRED', decision === 'PART'
        ? 'Write what is withheld and why, and what the release is based on.'
        : decision === 'ADVICE' ? 'Write whose advice you are waiting for and why.' : 'Write what the release is based on, e.g. "Coroner\'s written request under the Coroners Act; clinical lead agreed".');
      store.tx(() => {
        transition(store, 'coronial_request', String(q.id), decision === 'ADVICE' ? 'ADVICE' : 'DECIDED', who, DECISION[decision]);
        store.run('UPDATE coronial_request SET decision = ?, basis = ?, decided_by = ?, decided_at = ? WHERE id = ?', decision, basis, ctx.workerId, at, q.id);
        step(store, ctx, id, 'DECIDED', `${DECISION[decision]} (request from ${q.from_name}). ${basis}`);
        logged(store, ctx, 'CORONIAL_DECIDE', personId, id, DECISION[decision]);
      });
      break;
    }
    case 'send': {
      enforce(store, ctx, { op: 'CORONIAL', serviceId, cap: 'death.manage' });
      const q = store.get<Row>('SELECT * FROM coronial_request WHERE id = ? AND case_id = ?', b.requestId ?? '', id);
      if (!q) throw new HttpError(404, 'NOT_FOUND', 'That request is not part of this case.');
      if (q.state !== 'DECIDED') throw new HttpError(409, 'NOT_DECIDED', 'A decision about what to release comes first.');
      const how = SENT_HOW[String(b.how)] ? String(b.how) : '';
      if (!how) throw new HttpError(400, 'HOW_REQUIRED', 'Choose how it was sent.');
      const what = text(b.what);
      if (what.length < 10) throw new HttpError(400, 'WHAT_REQUIRED', 'List what was sent, e.g. "Clinical notes 3–9 Sept, observation charts, incident report 2026-311".');
      store.tx(() => {
        transition(store, 'coronial_request', String(q.id), 'SENT', who, SENT_HOW[how]);
        store.run('UPDATE coronial_request SET sent_what = ?, sent_how = ?, sent_by = ?, sent_at = ? WHERE id = ?', what, how, ctx.workerId, at, q.id);
        step(store, ctx, id, 'SENT', `Sent to ${q.from_name} by ${SENT_HOW[how].toLowerCase()}: ${what}`);
        logged(store, ctx, 'CORONIAL_SEND', personId, id, SENT_HOW[how]);
      });
      break;
    }
    case 'findings': {
      enforce(store, ctx, { op: 'CORONIAL', serviceId, cap: 'coroner.decide' });
      if (state !== 'HELD') throw new HttpError(409, 'WRONG_STATE', 'Findings are already recorded.');
      const findings = text(b.findings);
      if (findings.length < 10) throw new HttpError(400, 'FINDINGS_REQUIRED', 'Summarise the coroner\'s findings, with the date and reference.');
      const recommendations = text(b.recommendations) || null;
      store.tx(() => {
        transition(store, 'coronial', id, 'FINDINGS', who, 'Findings received');
        store.run('UPDATE coronial_case SET findings = ?, recommendations = ?, findings_by = ?, findings_at = ? WHERE id = ?', findings, recommendations, ctx.workerId, at, id);
        step(store, ctx, id, 'FINDINGS', `${findings}${recommendations ? ` Recommendations: ${recommendations}` : ' No recommendations for this service.'} The hold on the record ends.`);
        logged(store, ctx, 'CORONIAL_FINDINGS', personId, id);
      });
      break;
    }
    case 'respond': {
      enforce(store, ctx, { op: 'CORONIAL', serviceId, cap: 'coroner.decide' });
      if (state !== 'FINDINGS') throw new HttpError(409, 'WRONG_STATE', 'Record the findings first.');
      const response = text(b.response);
      if (response.length < 10) throw new HttpError(400, 'RESPONSE_REQUIRED', r.recommendations
        ? 'Write what the service has done or will do about each recommendation, and who is responsible.'
        : 'Write who reviewed the findings and what, if anything, the service will do.');
      store.tx(() => {
        store.run('UPDATE coronial_case SET response = ?, responded_by = ?, responded_at = ? WHERE id = ?', response, ctx.workerId, at, id);
        step(store, ctx, id, 'RESPONSE', response);
        logged(store, ctx, 'CORONIAL_RESPOND', personId, id);
      });
      break;
    }
    case 'close': {
      enforce(store, ctx, { op: 'CORONIAL', serviceId, cap: 'coroner.decide' });
      if (state !== 'FINDINGS' || !r.respondedAt) throw new HttpError(409, 'NOT_READY', 'Record the findings and the service\'s response first.');
      if (requests(store, id).some((q) => q.state !== 'SENT')) throw new HttpError(409, 'OPEN_REQUESTS', 'Every request needs to be decided and sent first.');
      store.tx(() => {
        transition(store, 'coronial', id, 'CLOSED', who, 'Closed');
        store.run('UPDATE coronial_case SET closed_at = ?, closed_by = ? WHERE id = ?', at, ctx.workerId, id);
        step(store, ctx, id, 'CLOSED', text(b.note) || 'Closed.');
        logged(store, ctx, 'CORONIAL_CLOSE', personId, id);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, ctx, load(store, id));
}

export const options = () => ({ decision: DECISION, sentHow: SENT_HOW });
