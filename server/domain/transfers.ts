import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';
import { occupy, vacate } from './locations.ts';
import { requireCoding } from './coding.ts';
import { endForService } from './assignments.ts';

// Admission and transfer of care (Shared Lifecycle Objects 220 and 221):
//   requested → accepted (or declined) → bed allocated → arrived → responsibility accepted.
// Each step is a separate human act. Acceptance is not a bed, a bed is not arrival, and
// physical arrival does not move responsibility; the sending encounter stays open until
// the receiving clinician records that they have taken responsibility.

type Row = Record<string, string | number | null>;

const SELECT = `
  SELECT t.id, t.kind, t.state, t.reason, t.priority, t.requested_at AS requestedAt, t.note,
         t.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         t.from_service_id AS fromServiceId, fs.name AS fromService, t.to_service_id AS toServiceId, ts.name AS toService,
         rq.display_name AS requestedBy, ac.display_name AS acceptedBy, rs.display_name AS responsibleBy,
         b.label AS bed, b.id AS bedId,
         (SELECT location FROM encounter e WHERE e.id = t.from_encounter_id) AS fromLocation
    FROM transfer t
    JOIN person p ON p.id = t.person_id
    JOIN service fs ON fs.id = t.from_service_id JOIN service ts ON ts.id = t.to_service_id
    JOIN workforce_person rq ON rq.id = t.requested_by
    LEFT JOIN workforce_person ac ON ac.id = t.accepted_by
    LEFT JOIN workforce_person rs ON rs.id = t.responsible_by
    LEFT JOIN bed b ON b.id = t.bed_id`;

const OPEN = "('REQUESTED', 'ACCEPTED', 'BED_ALLOCATED', 'ARRIVED')";

function logged(store: Store, ctx: WorkContext, operation: string, personId: string | null, objectId: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'transfer', objectId, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [13, 42],
  });
}

// What this worker may do next on a transfer; the server re-checks every act.
function actions(store: Store, ctx: WorkContext, t: Row): string[] {
  const out: string[] = [];
  const can = (step: 'accept' | 'arrive' | 'responsibility') =>
    evaluate(store, ctx, { op: 'TRANSFER_RESPOND', toServiceId: String(t.toServiceId), step }).decision === 'ALLOW';
  const bed = () => evaluate(store, ctx, { op: 'BED_MANAGE', serviceId: String(t.toServiceId), organisationId: ctx.organisationId }).decision === 'ALLOW';
  const sender = t.fromServiceId === ctx.serviceId && ctx.role.capabilities.includes('transfer.request');
  if (t.state === 'REQUESTED' && can('accept')) out.push('accept', 'decline');
  if ((t.state === 'ACCEPTED' || t.state === 'BED_ALLOCATED') && bed() && hasBeds(store, String(t.toServiceId))) out.push('bed');
  if (t.state === 'BED_ALLOCATED' && can('arrive')) out.push('arrive');
  if (t.state === 'ARRIVED' && can('responsibility')) out.push('responsibility');
  if (['REQUESTED', 'ACCEPTED', 'BED_ALLOCATED'].includes(String(t.state)) && sender) out.push('cancel');
  return out;
}

const hasBeds = (store: Store, serviceId: string) => Boolean(store.get('SELECT 1 FROM bed WHERE service_id = ?', serviceId));

function shape(store: Store, ctx: WorkContext, t: Row) {
  return { ...t, actions: actions(store, ctx, t), history: history(store, 'transfer', String(t.id)) };
}

// Services in this organisation that can receive a patient, other than the worker's own.
function receivingServices(store: Store, ctx: WorkContext) {
  return store.all<{ id: string; name: string }>(
    `SELECT DISTINCT s.id, s.name FROM service s JOIN destination d ON d.service_id = s.id AND d.kind = 'SERVICE'
      WHERE s.organisation_id = ? AND s.id <> ? ORDER BY s.name`,
    ctx.organisationId, ctx.serviceId,
  );
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(`${SELECT} WHERE t.person_id = ? ORDER BY t.requested_at DESC`, personId);
  const canRequest = evaluate(store, ctx, { op: 'TRANSFER_REQUEST', personId }).decision === 'ALLOW';
  const open = rows.some((r) => String(r.state).match(/^(REQUESTED|ACCEPTED|BED_ALLOCATED|ARRIVED)$/));
  return {
    transfers: rows.map((r) => shape(store, ctx, r)),
    canRequest: canRequest && !open,
    services: canRequest ? receivingServices(store, ctx) : [],
  };
}

export function request(store: Store, ctx: WorkContext, personId: string, b: { toServiceId?: string; reason?: string; priority?: string }) {
  enforce(store, ctx, { op: 'TRANSFER_REQUEST', personId }, personId);
  const to = receivingServices(store, ctx).find((s) => s.id === b.toServiceId);
  if (!to) throw new HttpError(400, 'INVALID_SERVICE', 'Choose the service you are asking to take this patient.');
  const reason = (b.reason ?? '').trim().slice(0, 500);
  if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Give the reason for admission or transfer.');
  if (store.get(`SELECT 1 FROM transfer WHERE person_id = ? AND state IN ${OPEN}`, personId)) {
    throw new HttpError(409, 'ALREADY_OPEN', 'This patient already has a transfer in progress.');
  }
  const enc = store.get<{ id: string; kind: string }>("SELECT id, kind FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId);
  const id = newId();
  store.tx(() => {
    store.insert('transfer', {
      id, person_id: personId, kind: enc?.kind === 'EMERGENCY' ? 'ADMISSION' : 'TRANSFER', from_service_id: ctx.serviceId, from_encounter_id: enc?.id ?? null,
      to_service_id: to.id, reason, priority: b.priority === 'URGENT' ? 'URGENT' : 'ROUTINE', state: 'REQUESTED', requested_by: ctx.workerId, requested_at: now(),
    });
    recordInitial(store, 'transfer', id, 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, reason);
    logged(store, ctx, 'TRANSFER_REQUEST', personId, id, `To ${to.name}`);
  });
  return { id, state: 'REQUESTED' };
}

export function list(store: Store, ctx: WorkContext) {
  const flow = !ctx.role.capabilities.includes('record.view');
  enforce(store, ctx, { op: 'TRANSFER_VIEW', serviceIds: [ctx.serviceId] });
  const rows = flow
    ? store.all<Row>(`${SELECT} WHERE fs.organisation_id = ? AND (t.state IN ${OPEN} OR t.requested_at > datetime('now', '-1 day')) ORDER BY t.requested_at DESC`, ctx.organisationId)
    : store.all<Row>(`${SELECT} WHERE (t.to_service_id = ? OR t.from_service_id = ?) AND (t.state IN ${OPEN} OR t.requested_at > datetime('now', '-1 day')) ORDER BY t.requested_at DESC`, ctx.serviceId, ctx.serviceId);
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_TRANSFERS', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return rows.map((r) => ({ ...shape(store, ctx, r), incoming: flow ? null : r.toServiceId === ctx.serviceId }));
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; bedId?: string }) {
  const t = store.get<Row>(`${SELECT} WHERE t.id = ?`, id);
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'That transfer no longer exists.');
  const personId = String(t.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = b.note?.trim().slice(0, 500) || undefined;
  return store.tx(() => {
    switch (action) {
      case 'accept':
      case 'decline': {
        enforce(store, ctx, { op: 'TRANSFER_RESPOND', toServiceId: String(t.toServiceId), step: 'accept' }, personId);
        if (action === 'decline' && !note) throw new HttpError(400, 'REASON_REQUIRED', 'Give the reason for declining.');
        transition(store, 'transfer', id, action === 'accept' ? 'ACCEPTED' : 'DECLINED', who, note);
        if (action === 'accept') store.run('UPDATE transfer SET accepted_by = ? WHERE id = ?', ctx.workerId, id);
        if (note) store.run('UPDATE transfer SET note = ? WHERE id = ?', note, id);
        break;
      }
      case 'bed': {
        enforce(store, ctx, { op: 'BED_MANAGE', serviceId: String(t.toServiceId), organisationId: ctx.organisationId }, personId);
        const bed = store.get<{ id: string; label: string }>("SELECT id, label FROM bed WHERE id = ? AND service_id = ? AND state = 'AVAILABLE'", b.bedId ?? '', t.toServiceId);
        if (!bed) throw new HttpError(409, 'BED_UNAVAILABLE', 'That bed is no longer available.');
        if (t.bedId) store.run("UPDATE bed SET state = 'AVAILABLE', person_id = NULL, updated_at = ? WHERE id = ?", now(), t.bedId);
        store.run("UPDATE bed SET state = 'RESERVED', person_id = ?, updated_at = ? WHERE id = ?", personId, now(), bed.id);
        store.run('UPDATE transfer SET bed_id = ? WHERE id = ?', bed.id, id);
        transition(store, 'transfer', id, 'BED_ALLOCATED', who, bed.label);
        break;
      }
      case 'arrive': {
        enforce(store, ctx, { op: 'TRANSFER_RESPOND', toServiceId: String(t.toServiceId), step: 'arrive' }, personId);
        const encId = newId();
        store.insert('encounter', { id: encId, person_id: personId, service_id: t.toServiceId, location: t.bed, kind: 'INPATIENT', started_at: now(), state: 'ACTIVE' });
        store.run("UPDATE bed SET state = 'OCCUPIED', updated_at = ? WHERE id = ?", now(), t.bedId);
        if (t.bedId) occupy(store, String(t.bedId), personId, String(t.toServiceId), `Arrived from ${t.fromService ?? 'another service'}`);
        store.run('UPDATE transfer SET to_encounter_id = ? WHERE id = ?', encId, id);
        transition(store, 'transfer', id, 'ARRIVED', who, note ?? `Arrived in ${t.bed}`);
        break;
      }
      case 'responsibility': {
        enforce(store, ctx, { op: 'TRANSFER_RESPOND', toServiceId: String(t.toServiceId), step: 'responsibility' }, personId);
        const from = store.get<{ id: string }>('SELECT from_encounter_id AS id FROM transfer WHERE id = ?', id);
        if (from?.id) {
          store.run("UPDATE encounter SET state = 'ENDED', ended_at = ? WHERE id = ? AND state = 'ACTIVE'", now(), from.id);
          requireCoding(store, from.id, `Transferred to ${ctx.serviceName}`, who);
          vacate(store, personId, String(t.fromServiceId), `Transferred to ${ctx.serviceName}`);
          endForService(store, personId, String(t.fromServiceId), `Transferred to ${ctx.serviceName}`, who);
          store.run("UPDATE bed SET state = 'CLEANING', person_id = NULL, updated_at = ? WHERE person_id = ? AND service_id = ?", now(), personId, t.fromServiceId);
        }
        store.run('UPDATE transfer SET responsible_by = ? WHERE id = ?', ctx.workerId, id);
        transition(store, 'transfer', id, 'RESPONSIBILITY_ACCEPTED', who, note ?? `${ctx.serviceName} has taken responsibility`);
        break;
      }
      case 'cancel': {
        if (t.fromServiceId !== ctx.serviceId || !ctx.role.capabilities.includes('transfer.request')) throw new HttpError(403, 'BLOCK', 'Only the requesting service can cancel this transfer.');
        if (!note) throw new HttpError(400, 'REASON_REQUIRED', 'Give the reason for cancelling.');
        transition(store, 'transfer', id, 'CANCELLED', who, note);
        if (t.bedId) store.run("UPDATE bed SET state = 'AVAILABLE', person_id = NULL, updated_at = ? WHERE id = ?", now(), t.bedId);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `TRANSFER_${action.toUpperCase()}`, personId, id, note);
    return shape(store, ctx, store.get<Row>(`${SELECT} WHERE t.id = ?`, id)!);
  });
}

// Flow board: physical capacity across the organisation. Names appear only against beds
// that hold or await a person, which bed management needs.
export function beds(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'BED_MANAGE', serviceId: ctx.serviceId, organisationId: ctx.organisationId });
  const own = ctx.role.capabilities.includes('record.view');
  const rows = store.all<Row>(
    `SELECT b.id, b.label, b.state, s.id AS serviceId, s.name AS service, b.updated_at AS updatedAt,
            CASE WHEN b.person_id IS NULL THEN NULL ELSE (SELECT given_name || ' ' || family_name FROM person WHERE id = b.person_id) END AS patient
       FROM bed b JOIN service s ON s.id = b.service_id
      WHERE s.organisation_id = ? ${own ? 'AND s.id = ?' : ''}
      ORDER BY s.name, CAST(substr(b.label, instr(b.label, 'Bed ') + 4) AS INTEGER), b.label`,
    ...(own ? [ctx.organisationId, ctx.serviceId] : [ctx.organisationId]),
  );
  return rows;
}

export function bedsFor(store: Store, ctx: WorkContext, transferId: string) {
  const t = store.get<{ to: string }>('SELECT to_service_id AS "to" FROM transfer WHERE id = ?', transferId);
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'That transfer no longer exists.');
  enforce(store, ctx, { op: 'BED_MANAGE', serviceId: t.to, organisationId: ctx.organisationId });
  return store.all("SELECT id, label FROM bed WHERE service_id = ? AND state = 'AVAILABLE' ORDER BY CAST(substr(label, instr(label, 'Bed ') + 4) AS INTEGER)", t.to);
}

export function setBed(store: Store, ctx: WorkContext, bedId: string, state: string) {
  const bed = store.get<{ service_id: string; state: string }>('SELECT service_id, state FROM bed WHERE id = ?', bedId);
  if (!bed) throw new HttpError(404, 'NOT_FOUND', 'Bed not found.');
  enforce(store, ctx, { op: 'BED_MANAGE', serviceId: bed.service_id, organisationId: ctx.organisationId });
  const allowed: Record<string, string[]> = { CLEANING: ['AVAILABLE'], AVAILABLE: ['CLEANING'] };
  if (!allowed[bed.state]?.includes(state)) throw new HttpError(409, 'INVALID_BED_STATE', 'Occupied and reserved beds change only through admission, transfer or discharge.');
  store.run('UPDATE bed SET state = ?, updated_at = ? WHERE id = ?', state, now(), bedId);
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: `BED_${state}`, objectType: 'bed', objectId: bedId, decision: 'ALLOW', outcome: 'COMMITTED', engines: [42] });
  return { id: bedId, state };
}
