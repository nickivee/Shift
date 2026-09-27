import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { evidence, assess, current as statusNow } from './acuity.ts';
import { raise, forPerson as escalationOptions } from './escalations.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Deterioration event (Shared Lifecycle Object 268):
//   change detected → evidence → concern/trigger → escalation → clinical response →
//   intervention → reassessment → outcome → further escalation/closure.
// One record holds a whole episode of someone getting worse, from the moment anyone caring for
// them notices, through each escalation, response, intervention and reassessment, to how it
// ended. Escalations stay their own records (Object 225) and reassessments are clinical status
// assessments (Object 267); the event links them in order. SHIFT detects nothing itself and
// applies no thresholds or response-time targets (RR-EWS-001): it shows elapsed time only.

type Row = Record<string, string | number | null>;
type Cap = 'deterioration.record' | 'deterioration.manage';
const STATES: Record<string, string> = {
  DETECTED: 'Noticed: not yet escalated', ESCALATED: 'Escalated: waiting for a response', RESPONDING: 'Being responded to',
  REASSESSED: 'Reassessed', CLOSED: 'Closed',
};
export const OUTCOMES: Record<string, string> = {
  IMPROVED: 'Improved', STABLE_PLAN: 'Stable with a new plan', HIGHER_CARE: 'Moved to a higher level of care', DIED: 'Died', OTHER: 'Other',
};
const KINDS: Record<string, string> = {
  DETECTED: 'Change noticed', ESCALATED: 'Escalated', RESPONSE: 'Clinical response', INTERVENTION: 'Intervention', REASSESSMENT: 'Reassessment', OUTCOME: 'Outcome',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-EWS-001'];

const Q = `
  SELECT d.id, d.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = d.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         d.service_id AS serviceId, d.change_text AS change, d.evidence_json AS evidenceJson, d.state, d.detected_at AS detectedAt,
         db.display_name AS detectedBy, d.outcome, d.outcome_note AS outcomeNote, cb.display_name AS closedBy, d.closed_at AS closedAt
    FROM deterioration_event d
    JOIN person p ON p.id = d.person_id
    JOIN workforce_person db ON db.id = d.detected_by
    LEFT JOIN workforce_person cb ON cb.id = d.closed_by`;

const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'DETERIORATION', personId, cap }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'deterioration_event', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

function addStep(store: Store, ctx: WorkContext, eventId: string, kind: string, body: string, linkId: string | null = null) {
  store.insert('deterioration_step', { id: newId(), event_id: eventId, kind, body, link_id: linkId, by_id: ctx.workerId, at: now() });
}

function steps(store: Store, eventId: string) {
  return store.all<Row>(
    `SELECT s.kind, s.body, s.link_id AS linkId, w.display_name AS "by", s.at,
            x.state AS escalationState, x.urgency, x.recipient_role_key AS roleKey, x.response AS escalationResponse
       FROM deterioration_step s JOIN workforce_person w ON w.id = s.by_id
       LEFT JOIN escalation x ON s.kind = 'ESCALATED' AND x.id = s.link_id
      WHERE s.event_id = ? ORDER BY s.at, s.rowid`, eventId,
  ).map((s) => ({ ...s, kind: String(s.kind), kindLabel: KINDS[String(s.kind)], roleLabel: s.roleKey ? ROLE_BY_KEY.get(String(s.roleKey))?.label ?? String(s.roleKey) : null }));
}

function shape(store: Store, ctx: WorkContext, r: Row, canManage: boolean, canRecord: boolean) {
  const state = String(r.state);
  const list = steps(store, String(r.id));
  const actions: string[] = [];
  if (state !== 'CLOSED') {
    if (canRecord) actions.push('escalate');
    if (canManage && state !== 'DETECTED') actions.push('response');
    if (canManage) actions.push('intervention');
    if (canManage) actions.push('reassess');
    if (canManage && state === 'REASSESSED') actions.push('close');
  }
  const { evidenceJson, ...rest } = r;
  return {
    ...rest, id: String(r.id), personId: String(r.personId), state, stateLabel: STATES[state], outcomeLabel: r.outcome ? OUTCOMES[String(r.outcome)] : null,
    evidence: evidenceJson ? JSON.parse(String(evidenceJson)) : null, steps: list,
    escalations: list.filter((s) => s.kind === 'ESCALATED').length, actions, history: history(store, 'deterioration', String(r.id)),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That is no longer in SHIFT.');
  return r;
};

// Anyone caring for them can say they are getting worse; SHIFT keeps what it held at that moment.
export function open(store: Store, ctx: WorkContext, personId: string, b: { change?: string }) {
  enforce(store, ctx, { op: 'DETERIORATION', personId, cap: 'deterioration.record' }, personId);
  const change = text(b.change);
  if (change.length < 10) throw new HttpError(400, 'CHANGE_REQUIRED', 'Say what has changed, e.g. "More short of breath, sats down to 89% on air, clammy".');
  if (store.get("SELECT 1 FROM deterioration_event WHERE person_id = ? AND state != 'CLOSED'", personId)) {
    throw new HttpError(409, 'ALREADY_OPEN', 'There is already an open deterioration for them. Add to that one.');
  }
  const id = newId();
  store.tx(() => {
    store.insert('deterioration_event', {
      id, person_id: personId, service_id: ctx.serviceId, change_text: change, evidence_json: JSON.stringify(evidence(store, personId)),
      state: 'DETECTED', detected_by: ctx.workerId, detected_at: now(),
    });
    recordInitial(store, 'deterioration', id, 'DETECTED', { actorId: ctx.workerId, workContextId: ctx.id }, change.slice(0, 200));
    addStep(store, ctx, id, 'DETECTED', change);
    logged(store, ctx, 'DETERIORATION_DETECTED', personId, id, change.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { roleKey?: string; urgency?: string; trigger?: string; note?: string; level?: string; basis?: string; outcome?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  if (state === 'CLOSED') throw new HttpError(409, 'WRONG_STATE', 'This deterioration is closed.');
  const manage = () => enforce(store, ctx, { op: 'DETERIORATION', personId, cap: 'deterioration.manage' }, personId);
  const note = text(b.note);
  switch (action) {
    case 'escalate': {
      enforce(store, ctx, { op: 'DETERIORATION', personId, cap: 'deterioration.record' }, personId);
      const further = state !== 'DETECTED';
      store.tx(() => {
        const x = raise(store, ctx, personId, { roleKey: b.roleKey, urgency: b.urgency, concern: 'Deterioration', trigger: b.trigger });
        addStep(store, ctx, id, 'ESCALATED', text(b.trigger), x.id);
        if (state !== 'ESCALATED') transition(store, 'deterioration', id, 'ESCALATED', who, further ? 'Escalated further' : 'Escalated');
        logged(store, ctx, further ? 'DETERIORATION_ESCALATE_FURTHER' : 'DETERIORATION_ESCALATE', personId, id, `${b.urgency} to ${b.roleKey}`);
      });
      break;
    }
    case 'response':
    case 'intervention': {
      manage();
      if (state === 'DETECTED' && action === 'response') throw new HttpError(409, 'ESCALATE_FIRST', 'Escalate it first, so someone is responsible for responding.');
      if (note.length < 5) {
        throw new HttpError(400, 'NOTE_REQUIRED', action === 'response'
          ? 'Write who reviewed them and what they found, e.g. "Dr Patel reviewed: likely chest infection".'
          : 'Write what was done, e.g. "Oxygen 2 L by nasal prongs; IV antibiotics started".');
      }
      store.tx(() => {
        addStep(store, ctx, id, action === 'response' ? 'RESPONSE' : 'INTERVENTION', note);
        if (state === 'ESCALATED') transition(store, 'deterioration', id, 'RESPONDING', who, action === 'response' ? 'Response recorded' : 'Intervention started');
        logged(store, ctx, action === 'response' ? 'DETERIORATION_RESPONSE' : 'DETERIORATION_INTERVENTION', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'reassess': {
      manage();
      store.tx(() => {
        assess(store, ctx, personId, { level: b.level, basis: b.basis });
        const a = store.get<{ id: string }>("SELECT id FROM acuity_assessment WHERE person_id = ? AND state = 'CURRENT'", personId)!;
        const s = statusNow(store, personId)!;
        addStep(store, ctx, id, 'REASSESSMENT', `${s.label} (${s.changeLabel.toLowerCase()}): ${text(b.basis)}`, a.id);
        if (state !== 'REASSESSED') transition(store, 'deterioration', id, 'REASSESSED', who, s.label);
        logged(store, ctx, 'DETERIORATION_REASSESS', personId, id, s.label);
      });
      break;
    }
    case 'close': {
      manage();
      if (state !== 'REASSESSED') throw new HttpError(409, 'REASSESS_FIRST', 'Reassess them before closing it.');
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose how it ended.');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how it ended, e.g. "Obs back within his usual after antibiotics; 4-hourly obs".');
      store.tx(() => {
        addStep(store, ctx, id, 'OUTCOME', `${OUTCOMES[outcome]}: ${note}`);
        transition(store, 'deterioration', id, 'CLOSED', who, `${OUTCOMES[outcome]}: ${note.slice(0, 200)}`);
        store.run('UPDATE deterioration_event SET outcome = ?, outcome_note = ?, closed_by = ?, closed_at = ? WHERE id = ?', outcome, note, ctx.workerId, now(), id);
        logged(store, ctx, `DETERIORATION_${outcome}`, personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Deterioration view: the open episode step by step, and earlier ones.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canRecord = may(store, ctx, personId, 'deterioration.record');
  const canManage = may(store, ctx, personId, 'deterioration.manage');
  const all = store.all<Row>(`${Q} WHERE d.person_id = ? ORDER BY d.detected_at DESC`, personId).map((r) => shape(store, ctx, r, canManage, canRecord));
  const esc = canRecord ? escalationOptions(store, ctx, personId) : null;
  return {
    open: all.find((d) => d.state !== 'CLOSED') ?? null, closed: all.filter((d) => d.state === 'CLOSED'), canRecord, canManage,
    evidence: evidence(store, personId), status: statusNow(store, personId),
    recipients: esc?.canRaise ? esc.recipients : [], urgencies: esc?.urgencies ?? [], escalationNote: esc?.note ?? null,
    outcomes: OUTCOMES, levels: ['STABLE', 'WATCH', 'UNWELL', 'CRITICAL'],
  };
}

// For the record header.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE d.person_id = ? AND d.state != 'CLOSED'`, personId);
  return r ? { id: String(r.id), change: String(r.change), state: String(r.state), stateLabel: STATES[String(r.state)], detectedAt: String(r.detectedAt) } : null;
}

// Home → Deterioration: open episodes in this service, those not yet escalated first.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('deterioration.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include managing deterioration`);
  const rows = store.all<Row>(`${Q} WHERE d.service_id = ? AND d.state != 'CLOSED' ORDER BY d.detected_at`, ctx.serviceId).map((r) => shape(store, ctx, r, true, true));
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const recent = store.all<Row>(`${Q} WHERE d.service_id = ? AND d.state = 'CLOSED' AND d.closed_at >= ? ORDER BY d.closed_at DESC`, ctx.serviceId, since).map((r) => shape(store, ctx, r, false, false));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_DETERIORATION', decision: 'ALLOW', outcome: 'VIEWED' });
  return { notEscalated: rows.filter((r) => r.state === 'DETECTED'), open: rows.filter((r) => r.state !== 'DETECTED'), recent };
}
