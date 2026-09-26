import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ROLES } from '../config/workstations.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Clinical consultation (Shared Lifecycle Object 240):
//   requested → received → accepted or declined → advice → advice received by the
//   requesting team → actions → closed.
// A consultation gives advice; it never moves responsibility. The consulted role may read
// the record only while the consultation is open (authority.relationship: CONSULTATION).

type Row = Record<string, string | number | null>;
const OPEN = "('REQUESTED', 'RECEIVED', 'ACCEPTED', 'ADVISED', 'ADVICE_RECEIVED')";
const roleLabel = (key: string) => ROLES.find((r) => r.roleKey === key)?.label ?? key;

const SELECT = `
  SELECT c.id, c.state, c.urgency, c.question, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = c.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         c.from_service_id AS fromServiceId, fs.name AS fromService, c.to_service_id AS toServiceId, ts.name AS toService, c.to_role_key AS toRoleKey,
         rq.display_name AS requestedBy, c.requested_at AS requestedAt, rc.display_name AS receivedBy, ac.display_name AS acceptedBy,
         c.decline_reason AS declineReason, c.advice, ad.display_name AS advisedBy, c.advised_at AS advisedAt,
         ar.display_name AS adviceReceivedBy, c.actions AS followUp, cl.display_name AS closedBy, c.closed_at AS closedAt
    FROM consultation c
    JOIN person p ON p.id = c.person_id
    JOIN service fs ON fs.id = c.from_service_id
    JOIN service ts ON ts.id = c.to_service_id
    JOIN workforce_person rq ON rq.id = c.requested_by
    LEFT JOIN workforce_person rc ON rc.id = c.received_by
    LEFT JOIN workforce_person ac ON ac.id = c.accepted_by
    LEFT JOIN workforce_person ad ON ad.id = c.advised_by
    LEFT JOIN workforce_person ar ON ar.id = c.advice_received_by
    LEFT JOIN workforce_person cl ON cl.id = c.closed_by`;

// Where this role can ask for advice: each configured role, in each service of this
// organisation that has a position with that role.
function targets(store: Store, ctx: WorkContext) {
  const keys = ctx.role.consultsTo ?? [];
  if (!keys.length) return [];
  const rows = store.all<{ serviceId: string; service: string; roleKey: string }>(
    `SELECT DISTINCT s.id AS serviceId, s.name AS service, ps.role_key AS roleKey
       FROM position ps JOIN service s ON s.id = ps.service_id
      WHERE s.organisation_id = ? AND ps.role_key IN (${keys.map(() => '?').join(',')}) ORDER BY s.name`,
    ctx.organisationId, ...keys,
  );
  return rows.map((r) => ({ ...r, id: `${r.serviceId}|${r.roleKey}`, label: `${roleLabel(r.roleKey)}, ${r.service}` }));
}

const responder = (store: Store, ctx: WorkContext, c: Row) =>
  evaluate(store, ctx, { op: 'CONSULT_RESPOND', serviceId: String(c.toServiceId), roleKey: String(c.toRoleKey) }).decision === 'ALLOW';
const requester = (store: Store, ctx: WorkContext, c: Row) =>
  c.fromServiceId === ctx.serviceId && ctx.role.capabilities.includes('consult.request')
  && evaluate(store, ctx, { op: 'CONSULT_REQUEST', personId: String(c.personId) }).decision === 'ALLOW';

function shape(store: Store, ctx: WorkContext, c: Row) {
  const actions: string[] = [];
  const answer = responder(store, ctx, c);
  const ask = requester(store, ctx, c);
  if (answer && c.state === 'REQUESTED') actions.push('receive');
  if (answer && c.state === 'RECEIVED') actions.push('accept', 'decline');
  if (answer && c.state === 'ACCEPTED') actions.push('advise');
  if (ask && c.state === 'ADVISED') actions.push('acknowledge');
  if (ask && c.state === 'ADVICE_RECEIVED') actions.push('close');
  if (ask && ['REQUESTED', 'RECEIVED', 'ACCEPTED'].includes(String(c.state))) actions.push('withdraw');
  const sealed = answer && c.state === 'REQUESTED';
  return {
    ...c, toRole: roleLabel(String(c.toRoleKey)), question: sealed ? null : c.question, sealed, actions,
    incoming: c.toServiceId === ctx.serviceId && c.toRoleKey === ctx.role.roleKey,
    history: history(store, 'consultation', String(c.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'consultation', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [13, 42],
  });
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(`${SELECT} WHERE c.person_id = ? AND (c.from_service_id = ? OR c.to_service_id = ?) ORDER BY c.requested_at DESC`, personId, ctx.serviceId, ctx.serviceId);
  const allowed = ctx.role.capabilities.includes('consult.request') && evaluate(store, ctx, { op: 'CONSULT_REQUEST', personId }).decision === 'ALLOW';
  const to = allowed ? targets(store, ctx) : [];
  return { consultations: rows.map((r) => shape(store, ctx, r)), canRequest: to.length > 0, targets: to };
}

export function request(store: Store, ctx: WorkContext, personId: string, b: { target?: string; question?: string; urgency?: string }) {
  enforce(store, ctx, { op: 'CONSULT_REQUEST', personId }, personId);
  const target = targets(store, ctx).find((t) => t.id === b.target);
  if (!target) throw new HttpError(400, 'INVALID_TARGET', 'Choose who you are asking for advice.');
  const question = (b.question ?? '').trim().slice(0, 2000);
  if (question.length < 10) throw new HttpError(400, 'QUESTION_REQUIRED', 'Write the question you want answered.');
  if (store.get(`SELECT 1 FROM consultation WHERE person_id = ? AND to_service_id = ? AND to_role_key = ? AND state IN ${OPEN}`, personId, target.serviceId, target.roleKey)) {
    throw new HttpError(409, 'ALREADY_OPEN', `There is already an open consultation with ${target.label} for this patient.`);
  }
  const id = newId();
  store.tx(() => {
    store.insert('consultation', {
      id, person_id: personId, from_service_id: ctx.serviceId, requested_by: ctx.workerId, requested_at: now(),
      to_service_id: target.serviceId, to_role_key: target.roleKey, question, urgency: b.urgency === 'URGENT' ? 'URGENT' : 'ROUTINE', state: 'REQUESTED',
    });
    recordInitial(store, 'consultation', id, 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, `To ${target.label}`);
    logged(store, ctx, 'CONSULT_REQUEST', personId, id, `To ${target.label}`);
  });
  return { id, state: 'REQUESTED' };
}

const load = (store: Store, id: string) => {
  const c = store.get<Row>(`${SELECT} WHERE c.id = ?`, id);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'That consultation no longer exists.');
  return c;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const c = load(store, id);
  const personId = String(c.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = b.note?.trim().slice(0, 2000) || '';
  const answer = () => enforce(store, ctx, { op: 'CONSULT_RESPOND', serviceId: String(c.toServiceId), roleKey: String(c.toRoleKey) }, personId);
  const ask = () => {
    if (c.fromServiceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the requesting service can do this.');
    enforce(store, ctx, { op: 'CONSULT_REQUEST', personId }, personId);
  };
  const need = (min: number, message: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', message); };
  return store.tx(() => {
    switch (action) {
      case 'receive':
        answer();
        transition(store, 'consultation', id, 'RECEIVED', who);
        store.run('UPDATE consultation SET received_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'accept':
        answer();
        transition(store, 'consultation', id, 'ACCEPTED', who, note || undefined);
        store.run('UPDATE consultation SET accepted_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'decline':
        answer();
        need(5, 'Give the reason for declining, and where to ask instead if you know.');
        transition(store, 'consultation', id, 'DECLINED', who, note);
        store.run('UPDATE consultation SET decline_reason = ?, closed_at = ? WHERE id = ?', note, now(), id);
        break;
      case 'advise':
        answer();
        need(10, 'Write your advice or recommendation.');
        transition(store, 'consultation', id, 'ADVISED', who);
        store.run('UPDATE consultation SET advice = ?, advised_by = ?, advised_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        break;
      case 'acknowledge':
        ask();
        transition(store, 'consultation', id, 'ADVICE_RECEIVED', who);
        store.run('UPDATE consultation SET advice_received_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'close':
        ask();
        need(3, 'Record what your team is doing with the advice.');
        transition(store, 'consultation', id, 'CLOSED', who, note);
        store.run('UPDATE consultation SET actions = ?, closed_by = ?, closed_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        break;
      case 'withdraw':
        ask();
        need(5, 'Give the reason for withdrawing.');
        transition(store, 'consultation', id, 'WITHDRAWN', who, note);
        store.run('UPDATE consultation SET closed_at = ? WHERE id = ?', now(), id);
        break;
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `CONSULT_${action.toUpperCase()}`, personId, id, note || undefined);
    return shape(store, ctx, load(store, id));
  });
}

// Consultations this service asked for, and those addressed to this worker's role.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('consult.request') && !ctx.role.capabilities.includes('consult.respond')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include consultations`);
  }
  const rows = store.all<Row>(
    `${SELECT} WHERE (c.state IN ${OPEN} OR c.closed_at > datetime('now', '-1 day'))
        AND (c.from_service_id = ? OR (c.to_service_id = ? AND c.to_role_key = ?))
      ORDER BY CASE WHEN c.state IN ${OPEN} THEN 0 ELSE 1 END, CASE c.urgency WHEN 'URGENT' THEN 0 ELSE 1 END, c.requested_at`,
    ctx.serviceId, ctx.serviceId, ctx.role.roleKey,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_CONSULTATIONS', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return rows.map((r) => shape(store, ctx, r));
}
