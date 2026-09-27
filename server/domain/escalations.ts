import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ROLES } from '../config/workstations.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Escalation (Shared Lifecycle Object 225):
//   trigger → raised to a responsible role → received → acknowledged → response →
//   reassessment by the raising side → resolved OR escalated further.
// SHIFT never raises an escalation itself and applies no early-warning thresholds (RR-EWS-001);
// the trigger is the clinician's own words. Response-time targets are organisational policy
// and are not configured, so SHIFT shows elapsed time only.

type Row = Record<string, string | number | null>;
export const URGENCY = ['IMMEDIATE', 'URGENT', 'ROUTINE'] as const;
export const CONCERNS = ['Deterioration', 'Pain', 'Fall', 'Wound or skin', 'Behaviour or confusion', 'Fluid or nutrition', 'Other'];
const OPEN = "('RAISED', 'RECEIVED', 'ACKNOWLEDGED', 'RESPONDED')";
const roleLabel = (key: string) => ROLES.find((r) => r.roleKey === key)?.label ?? key;

const SELECT = `
  SELECT x.id, x.state, x.urgency, x.concern, x.trigger_text AS "trigger", x.level, x.parent_id AS parentId,
         x.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = x.person_id AND e.service_id = x.service_id AND e.state = 'ACTIVE' LIMIT 1) AS location,
         x.service_id AS serviceId, s.name AS service, x.recipient_role_key AS recipientRoleKey,
         x.raised_service_id AS raisedServiceId, rs.name AS raisedService,
         rb.display_name AS raisedBy, x.raised_at AS raisedAt, x.raised_by AS raisedById,
         rc.display_name AS receivedBy, ak.display_name AS acknowledgedBy,
         x.response, rp.display_name AS respondedBy, x.reassessment, ra.display_name AS reassessedBy, x.closed_at AS closedAt
    FROM escalation x
    JOIN person p ON p.id = x.person_id
    JOIN service s ON s.id = x.service_id
    JOIN service rs ON rs.id = x.raised_service_id
    JOIN workforce_person rb ON rb.id = x.raised_by
    LEFT JOIN workforce_person rc ON rc.id = x.received_by
    LEFT JOIN workforce_person ak ON ak.id = x.acknowledged_by
    LEFT JOIN workforce_person rp ON rp.id = x.responded_by
    LEFT JOIN workforce_person ra ON ra.id = x.reassessed_by`;

// The service responsible for this person: where they are admitted, else the worker's own.
function responsible(store: Store, ctx: WorkContext, personId: string) {
  const enc = store.get<{ service_id: string }>("SELECT service_id FROM encounter WHERE person_id = ? AND state = 'ACTIVE' ORDER BY started_at DESC LIMIT 1", personId);
  return enc?.service_id ?? ctx.serviceId;
}

export function recipients(store: Store, ctx: WorkContext, personId: string) {
  const serviceId = responsible(store, ctx, personId);
  const service = store.get<{ name: string }>('SELECT name FROM service WHERE id = ?', serviceId)?.name ?? '';
  return (ctx.role.escalatesTo ?? []).map((key) => ({ serviceId, roleKey: key, label: `${roleLabel(key)}, ${service}` }));
}

const canRespond = (store: Store, ctx: WorkContext, x: Row) =>
  evaluate(store, ctx, { op: 'ESCALATION_RESPOND', serviceId: String(x.serviceId), roleKey: String(x.recipientRoleKey) }).decision === 'ALLOW';
// Reassessment belongs to the raising side, not to the role the escalation is addressed to.
const canReassess = (store: Store, ctx: WorkContext, x: Row) =>
  x.raisedServiceId === ctx.serviceId && ctx.role.roleKey !== x.recipientRoleKey && evaluate(store, ctx, { op: 'ESCALATE', personId: String(x.personId) }).decision === 'ALLOW';

function shape(store: Store, ctx: WorkContext, x: Row) {
  const actions: string[] = [];
  const open = ['RAISED', 'RECEIVED', 'ACKNOWLEDGED', 'RESPONDED'].includes(String(x.state));
  const responder = open && canRespond(store, ctx, x);
  const reassessor = open && canReassess(store, ctx, x);
  if (responder && x.state === 'RAISED') actions.push('receive');
  if (responder && x.state === 'RECEIVED') actions.push('acknowledge');
  if (responder && x.state === 'ACKNOWLEDGED') actions.push('respond');
  if (reassessor) {
    actions.push('resolve');
    if (recipients(store, ctx, String(x.personId)).length) actions.push('escalate');
  }
  // Until it is opened, the recipient sees who and how urgent, not the detail.
  const sealed = responder && x.state === 'RAISED';
  return {
    ...x, recipient: roleLabel(String(x.recipientRoleKey)), trigger: sealed ? null : x.trigger, sealed, actions,
    mine: x.raisedServiceId === ctx.serviceId ? 'raised' : responder || x.serviceId === ctx.serviceId ? 'received' : null,
    history: history(store, 'escalation', String(x.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'escalation', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [13, 42],
  });
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(`${SELECT} WHERE x.person_id = ? ORDER BY x.raised_at DESC LIMIT 30`, personId);
  const allowed = evaluate(store, ctx, { op: 'ESCALATE', personId }).decision === 'ALLOW';
  const to = allowed ? recipients(store, ctx, personId) : [];
  return {
    escalations: rows.map((r) => shape(store, ctx, r)),
    canRaise: allowed && to.length > 0,
    recipients: to,
    urgencies: URGENCY,
    concerns: CONCERNS,
    note: allowed && !to.length
      ? 'No one to escalate to is set up inside this organisation for your role. Escalating outside it (for example to a GP) is a disclosure whose rule mapping is still a research requirement (RR-DISC-001).'
      : null,
  };
}

function insert(store: Store, ctx: WorkContext, personId: string, b: { recipient: { serviceId: string; roleKey: string }; urgency: string; concern: string; trigger: string }, parent: Row | null) {
  const id = newId();
  store.insert('escalation', {
    id, person_id: personId, service_id: b.recipient.serviceId, recipient_role_key: b.recipient.roleKey, urgency: b.urgency, concern: b.concern,
    trigger_text: b.trigger, state: 'RAISED', raised_by: ctx.workerId, raised_service_id: ctx.serviceId, raised_at: now(),
    parent_id: parent ? parent.id : null, level: parent ? Number(parent.level) + 1 : 1,
  });
  recordInitial(store, 'escalation', id, 'RAISED', { actorId: ctx.workerId, workContextId: ctx.id }, `${b.urgency.toLowerCase()} · ${b.concern}`);
  logged(store, ctx, 'ESCALATION_RAISE', personId, id, `${b.urgency} to ${b.recipient.roleKey}`);
  return id;
}

function validate(store: Store, ctx: WorkContext, personId: string, b: { roleKey?: string; urgency?: string; concern?: string; trigger?: string }) {
  const recipient = recipients(store, ctx, personId).find((r) => r.roleKey === b.roleKey);
  if (!recipient) throw new HttpError(400, 'INVALID_RECIPIENT', 'Choose who you are escalating to.');
  const urgency = (URGENCY as readonly string[]).includes(b.urgency ?? '') ? b.urgency! : null;
  if (!urgency) throw new HttpError(400, 'URGENCY_REQUIRED', 'Choose how urgent this is.');
  const concern = CONCERNS.includes(b.concern ?? '') ? b.concern! : 'Other';
  const trigger = (b.trigger ?? '').trim().slice(0, 1000);
  if (trigger.length < 10) throw new HttpError(400, 'TRIGGER_REQUIRED', 'Say what has changed and why you are worried.');
  return { recipient, urgency, concern, trigger };
}

export function raise(store: Store, ctx: WorkContext, personId: string, b: { roleKey?: string; urgency?: string; concern?: string; trigger?: string }) {
  enforce(store, ctx, { op: 'ESCALATE', personId }, personId);
  const v = validate(store, ctx, personId, b);
  return store.tx(() => ({ id: insert(store, ctx, personId, v, null), state: 'RAISED' }));
}

const load = (store: Store, id: string) => {
  const x = store.get<Row>(`${SELECT} WHERE x.id = ?`, id);
  if (!x) throw new HttpError(404, 'NOT_FOUND', 'That escalation no longer exists.');
  return x;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; roleKey?: string; urgency?: string; concern?: string; trigger?: string }) {
  const x = load(store, id);
  const personId = String(x.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = b.note?.trim().slice(0, 1000) || '';
  const respond = () => enforce(store, ctx, { op: 'ESCALATION_RESPOND', serviceId: String(x.serviceId), roleKey: String(x.recipientRoleKey) }, personId);
  const reassess = () => {
    if (x.raisedServiceId !== ctx.serviceId || ctx.role.roleKey === x.recipientRoleKey) throw new HttpError(403, 'BLOCK', 'Only the side that raised this escalation reassesses it.');
    enforce(store, ctx, { op: 'ESCALATE', personId }, personId);
  };
  return store.tx(() => {
    switch (action) {
      case 'receive':
        respond();
        transition(store, 'escalation', id, 'RECEIVED', who);
        store.run('UPDATE escalation SET received_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'acknowledge':
        respond();
        transition(store, 'escalation', id, 'ACKNOWLEDGED', who, note || undefined);
        store.run('UPDATE escalation SET acknowledged_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'respond':
        respond();
        if (note.length < 5) throw new HttpError(400, 'RESPONSE_REQUIRED', 'Record your response: what you did or advised.');
        transition(store, 'escalation', id, 'RESPONDED', who, note);
        store.run('UPDATE escalation SET response = ?, responded_by = ? WHERE id = ?', note, ctx.workerId, id);
        break;
      case 'resolve':
        reassess();
        if (note.length < 5) throw new HttpError(400, 'REASSESSMENT_REQUIRED', 'Record your reassessment.');
        transition(store, 'escalation', id, 'RESOLVED', who, note);
        store.run('UPDATE escalation SET reassessment = ?, reassessed_by = ?, closed_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        break;
      case 'escalate': {
        reassess();
        const v = validate(store, ctx, personId, { roleKey: b.roleKey, urgency: b.urgency, concern: String(x.concern), trigger: b.trigger });
        transition(store, 'escalation', id, 'ESCALATED', who, v.trigger);
        store.run('UPDATE escalation SET reassessment = ?, reassessed_by = ?, closed_at = ? WHERE id = ?', v.trigger, ctx.workerId, now(), id);
        insert(store, ctx, personId, v, x);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    if (action !== 'escalate') logged(store, ctx, `ESCALATION_${action.toUpperCase()}`, personId, id, note || undefined);
    return shape(store, ctx, load(store, id));
  });
}

// Escalations this worker's service raised, or that are addressed to this worker's role.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('escalation.raise') && !ctx.role.capabilities.includes('escalation.respond')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include escalation`);
  }
  const recent = `(x.state IN ${OPEN} OR x.closed_at > datetime('now', '-1 day'))`;
  const rows = store.all<Row>(
    `${SELECT} WHERE ${recent} AND (x.raised_service_id = ? OR (x.service_id = ? AND x.recipient_role_key = ?))
      ORDER BY CASE WHEN x.state IN ${OPEN} THEN 0 ELSE 1 END, CASE x.urgency WHEN 'IMMEDIATE' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, x.raised_at`,
    ctx.serviceId, ctx.serviceId, ctx.role.roleKey,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_ESCALATIONS', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return rows.map((r) => shape(store, ctx, r));
}
