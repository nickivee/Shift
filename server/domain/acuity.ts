import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { activeRaised } from './alerts.ts';
import { current as helpNeeded } from './functional.ts';
import { current as differentNow } from './usual.ts';
import { LEVELS, LEVEL_BY_ID } from '../config/acuity.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Clinical status / acuity (Shared Lifecycle Object 267):
//   clinical evidence → acuity assessment → current status → escalation/resource implications →
//   reassessment → changed status.
// A nurse or doctor looks at the evidence SHIFT already holds (latest observations, changes from
// usual, open escalations, help needed, alerts), records how unwell the person is and why, and
// SHIFT keeps that evidence with it. Each level carries what it means for escalation and
// staffing and when it must be looked at again. A new assessment replaces the last and says
// whether they are better or worse. SHIFT never calculates a score or raises an escalation
// itself (RR-EWS-001, RR-ACU-001).

type Row = Record<string, string | number | null>;
interface Evidence { obs: { text: string; at: string } | null; different: string[]; escalations: string[]; help: string[]; alerts: string[] }
const STATES: Record<string, string> = { CURRENT: 'Current', SUPERSEDED: 'Replaced', ENTERED_IN_ERROR: 'Entered in error' };
const CHANGES: Record<string, string> = { FIRST: 'First assessment', WORSE: 'Worse', BETTER: 'Better', SAME: 'No change' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-EWS-001', 'RR-ACU-001'];

const Q = `
  SELECT a.id, a.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = a.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         a.level, a.basis, a.evidence_json AS evidenceJson, a.change, a.review_due AS reviewDue, a.state,
         ab.display_name AS assessedBy, a.assessed_by AS assessedById, a.assessed_at AS assessedAt, a.error_reason AS errorReason
    FROM acuity_assessment a
    JOIN person p ON p.id = a.person_id
    JOIN workforce_person ab ON ab.id = a.assessed_by`;

const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'ACUITY', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'acuity_assessment', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const openEscalations = (store: Store, personId: string) => store.all<{ concern: string; urgency: string; state: string }>(
  "SELECT concern, urgency, state FROM escalation WHERE person_id = ? AND state NOT IN ('RESOLVED', 'ESCALATED') ORDER BY raised_at DESC", personId);

// What SHIFT already holds that bears on how unwell they are.
export function evidence(store: Store, personId: string): Evidence {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const obs = store.get<{ text: string; at: string }>(
    "SELECT rendered_text AS text, effective_at AS at FROM clinical_event WHERE person_id = ? AND category = 'OBS' AND state = 'CURRENT' AND effective_at >= ? ORDER BY effective_at DESC LIMIT 1",
    personId, since);
  const help = helpNeeded(store, personId);
  return {
    obs: obs ?? null,
    different: differentNow(store, personId) ?? [],
    escalations: openEscalations(store, personId).map((e) => `${e.urgency === 'IMMEDIATE' ? 'Immediate' : e.urgency === 'URGENT' ? 'Urgent' : 'Routine'}: ${e.concern}`),
    help: help ? help.help : [],
    alerts: activeRaised(store, personId).map((a) => a.title),
  };
}

function shape(store: Store, r: Row, canAssess: boolean) {
  const level = LEVEL_BY_ID.get(String(r.level))!;
  const state = String(r.state);
  const overdue = state === 'CURRENT' && String(r.reviewDue) < now();
  const { evidenceJson: _e, ...rest } = r;
  return {
    ...rest, id: String(r.id), personId: String(r.personId), state, stateLabel: STATES[state], level: level.id, label: level.label, short: level.short, tone: level.tone,
    implication: level.implication, escalate: level.escalate, change: String(r.change), changeLabel: CHANGES[String(r.change)], overdue,
    evidence: r.evidenceJson ? JSON.parse(String(r.evidenceJson)) as Evidence : null,
    actions: canAssess && state === 'CURRENT' ? ['error'] : [],
    history: history(store, 'acuity', String(r.id)),
  };
}

const latest = (store: Store, personId: string) => store.get<Row>(`${Q} WHERE a.person_id = ? AND a.state = 'CURRENT'`, personId);

export function assess(store: Store, ctx: WorkContext, personId: string, b: { level?: string; basis?: string }) {
  enforce(store, ctx, { op: 'ACUITY', personId }, personId);
  const level = LEVEL_BY_ID.get(String(b.level));
  if (!level) throw new HttpError(400, 'LEVEL_REQUIRED', 'Choose how they are.');
  const basis = text(b.basis);
  if (basis.length < 5) throw new HttpError(400, 'BASIS_REQUIRED', 'Write what you are basing this on, e.g. "Resp rate up to 24, more confused than this morning".');
  const prior = latest(store, personId);
  const priorRank = prior ? LEVEL_BY_ID.get(String(prior.level))!.rank : null;
  const change = priorRank === null ? 'FIRST' : level.rank > priorRank ? 'WORSE' : level.rank < priorRank ? 'BETTER' : 'SAME';
  const id = newId();
  const at = now();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('acuity_assessment', {
      id, person_id: personId, service_id: ctx.serviceId, level: level.id, basis, evidence_json: JSON.stringify(evidence(store, personId)), change,
      review_due: new Date(Date.parse(at) + level.reviewHours * 3600_000).toISOString(), state: 'CURRENT', assessed_by: ctx.workerId, assessed_at: at,
      supersedes: prior ? String(prior.id) : null,
    });
    recordInitial(store, 'acuity', id, 'CURRENT', who, `${level.label}: ${basis.slice(0, 200)}`);
    if (prior) transition(store, 'acuity', String(prior.id), 'SUPERSEDED', who, `Reassessed: ${CHANGES[change].toLowerCase()}`);
    logged(store, ctx, 'ACUITY_ASSESS', personId, id, `${level.label} (${CHANGES[change]}): ${basis.slice(0, 200)}`);
  });
  return forPerson(store, ctx, personId);
}

export function markError(store: Store, ctx: WorkContext, id: string, b: { reason?: string }) {
  const r = store.get<Row>(`${Q} WHERE a.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'ACUITY', personId }, personId);
  if (r.state !== 'CURRENT') throw new HttpError(409, 'WRONG_STATE', 'Only the current status can be marked as entered in error.');
  const reason = text(b.reason, 500);
  if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Write what was wrong, e.g. "recorded on the wrong person".');
  store.tx(() => {
    transition(store, 'acuity', id, 'ENTERED_IN_ERROR', { actorId: ctx.workerId, workContextId: ctx.id }, reason);
    store.run('UPDATE acuity_assessment SET error_reason = ? WHERE id = ?', reason, id);
    logged(store, ctx, 'ACUITY_ERROR', personId, id, reason);
  });
  return forPerson(store, ctx, personId);
}

// The person's Clinical status view: now, what it means, the evidence SHIFT holds, and how it has changed.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canAssess = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE a.person_id = ? ORDER BY a.assessed_at DESC`, personId).map((r) => shape(store, r, canAssess));
  const cur = all.find((a) => a.state === 'CURRENT') ?? null;
  const calc = evaluate(store, ctx, { op: 'ACUITY_SCORE' });
  return {
    current: cur, escalationOpen: openEscalations(store, personId).length > 0, evidence: evidence(store, personId),
    earlier: all.filter((a) => a !== cur), canAssess, canEscalate: ctx.role.capabilities.includes('escalation.raise'),
    levels: LEVELS.map((l) => ({ id: l.id, label: l.label, reviewHours: l.reviewHours, implication: l.implication, tone: l.tone })),
    calculation: { decision: calc.decision, reason: calc.reasons[0] ?? null, refs: calc.ruleRefs },
  };
}

// For the record header, the allocation and the patient list.
export function current(store: Store, personId: string) {
  const r = latest(store, personId);
  if (!r) return null;
  const l = LEVEL_BY_ID.get(String(r.level))!;
  return { level: l.id, label: l.label, short: l.short, tone: l.tone, reviewDue: String(r.reviewDue), overdue: String(r.reviewDue) < now(), change: String(r.change), changeLabel: CHANGES[String(r.change)] };
}

// Home → Clinical status: who is unwell, whose status is overdue for a look, and who has none.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('acuity.assess')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include recording clinical status`);
  const people = store.all<{ id: string; patient: string; location: string | null }>(
    `SELECT p.id, p.given_name || ' ' || p.family_name AS patient, e.location FROM encounter e JOIN person p ON p.id = e.person_id
      WHERE e.service_id = ? AND e.state = 'ACTIVE' ORDER BY e.location, p.family_name`, ctx.serviceId);
  const rows = people.map((p) => {
    const r = latest(store, p.id);
    return { ...p, personId: p.id, status: r ? shape(store, r, true) : null, escalationOpen: openEscalations(store, p.id).length > 0 };
  });
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_ACUITY', decision: 'ALLOW', outcome: 'VIEWED' });
  const rank = (x: typeof rows[number]) => (x.status ? LEVEL_BY_ID.get(x.status.level)!.rank : -1);
  return {
    unwell: rows.filter((x) => rank(x) >= 2).sort((a, b) => rank(b) - rank(a)),
    overdue: rows.filter((x) => x.status?.overdue && rank(x) < 2),
    none: rows.filter((x) => !x.status),
    others: rows.filter((x) => x.status && rank(x) < 2 && !x.status.overdue),
    counts: LEVELS.map((l) => ({ id: l.id, short: l.short, tone: l.tone, count: rows.filter((x) => x.status?.level === l.id).length })),
  };
}
