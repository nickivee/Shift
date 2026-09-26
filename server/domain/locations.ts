import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Location / bed / care space (Shared Lifecycle Object 247):
//   location requirement → placement request → bed allocated → patient movement → arrival →
//   occupied / current location → movement / transfer → vacated.
// Every stay in a bed is kept, from arrival to leaving, so where a patient was and who was in a
// bed can be answered later. Placement needs are matched against the bed's features and shown;
// the person allocating decides.

type Row = Record<string, string | number | null>;
export const FEATURES: Record<string, string> = {
  SINGLE_ROOM: 'Single room', ENSUITE: 'Own bathroom', NEAR_STATION: 'Near the nurses\' station', OXYGEN: 'Piped oxygen',
  SUCTION: 'Piped suction', BARIATRIC: 'Bariatric bed', LOW_BED: 'Low bed',
};
const URGENCY: Record<string, string> = { NOW: 'Now', TODAY: 'Today', ROUTINE: 'When a bed is free' };
const RANK: Record<string, number> = { NOW: 0, TODAY: 1, ROUTINE: 2 };

const list = (v: unknown) => String(v ?? '').split(',').map((x) => x.trim()).filter((x) => FEATURES[x]);
const labels = (v: unknown) => list(v).map((x) => FEATURES[x]);
const bedOrder = "CAST(substr(b.label, instr(b.label, 'Bed ') + 4) AS INTEGER), b.label";

// Called by admission, transfer, discharge and moves so that the bed history is complete.
export function occupy(store: Store, bedId: string, personId: string, serviceId: string, reason: string, at = now()) {
  store.insert('bed_occupancy', { id: newId(), bed_id: bedId, person_id: personId, service_id: serviceId, from_at: at, reason_in: reason });
}
export function vacate(store: Store, personId: string, serviceId: string, reason: string, at = now()) {
  store.run('UPDATE bed_occupancy SET until_at = ?, reason_out = ? WHERE person_id = ? AND service_id = ? AND until_at IS NULL', at, reason, personId, serviceId);
}

const MOVE = `
  SELECT m.id, m.state, m.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, m.service_id AS serviceId,
         m.needs, m.reason, m.urgency, fb.label AS fromBed, nb.label AS bed, m.bed_id AS bedId,
         rb.display_name AS requestedBy, m.requested_at AS requestedAt, ab.display_name AS allocatedBy, m.allocated_at AS allocatedAt,
         m.allocation_note AS allocationNote, mb.display_name AS movedBy, m.moved_at AS movedAt,
         cb.display_name AS closedBy, m.closed_at AS closedAt, m.close_reason AS closeReason
    FROM bed_move m
    JOIN person p ON p.id = m.person_id
    JOIN workforce_person rb ON rb.id = m.requested_by
    LEFT JOIN bed fb ON fb.id = m.from_bed_id
    LEFT JOIN bed nb ON nb.id = m.bed_id
    LEFT JOIN workforce_person ab ON ab.id = m.allocated_by
    LEFT JOIN workforce_person mb ON mb.id = m.moved_by
    LEFT JOIN workforce_person cb ON cb.id = m.closed_by`;

function freeBeds(store: Store, serviceId: string, needs: string[]) {
  return store.all<Row>(`SELECT b.id, b.label, b.features FROM bed b WHERE b.service_id = ? AND b.state = 'AVAILABLE' ORDER BY ${bedOrder}`, serviceId)
    .map((b) => {
      const has = list(b.features);
      const missing = needs.filter((n) => !has.includes(n));
      return { id: b.id, label: b.label, features: labels(b.features), missing: missing.map((x) => FEATURES[x]), matches: missing.length === 0 };
    })
    .sort((a, b) => Number(b.matches) - Number(a.matches));
}

function shapeMove(store: Store, ctx: WorkContext, m: Row) {
  const needs = list(m.needs);
  const manage = evaluate(store, ctx, { op: 'BED_MANAGE', serviceId: String(m.serviceId), organisationId: ctx.organisationId }).decision === 'ALLOW';
  const actions: string[] = [];
  if (m.state === 'REQUESTED' && manage) actions.push('allocate');
  if (m.state === 'ALLOCATED' && manage && ctx.role.capabilities.includes('record.view')) actions.push('move');
  if (m.state === 'ALLOCATED' && manage) actions.push('release');
  if (['REQUESTED', 'ALLOCATED'].includes(String(m.state)) && (manage || ctx.role.capabilities.includes('bed.request'))) actions.push('cancel');
  return {
    ...m, state: String(m.state), urgency: String(m.urgency), requestedAt: String(m.requestedAt),
    needLabels: labels(m.needs), urgencyLabel: URGENCY[String(m.urgency)], actions,
    beds: m.state === 'REQUESTED' && manage ? freeBeds(store, String(m.serviceId), needs) : [],
    history: history(store, 'bedmove', String(m.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, id: string, personId: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'bed_move', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [42],
  });
}

const options = () => ({ features: FEATURES, urgency: URGENCY });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const bed = store.get<Row>(
    `SELECT b.id, b.label, b.features, s.name AS service, o.from_at AS since FROM bed b JOIN service s ON s.id = b.service_id
       LEFT JOIN bed_occupancy o ON o.bed_id = b.id AND o.person_id = b.person_id AND o.until_at IS NULL
      WHERE b.person_id = ? AND b.state = 'OCCUPIED'`, personId,
  );
  const stays = store.all<Row>(
    `SELECT b.label AS bed, s.name AS service, o.from_at AS fromAt, o.until_at AS untilAt, o.reason_in AS reasonIn, o.reason_out AS reasonOut
       FROM bed_occupancy o JOIN bed b ON b.id = o.bed_id JOIN service s ON s.id = o.service_id
      WHERE o.person_id = ? ORDER BY o.from_at DESC LIMIT 20`, personId,
  );
  const moves = store.all<Row>(`${MOVE} WHERE m.person_id = ? ORDER BY m.requested_at DESC LIMIT 10`, personId).map((m) => shapeMove(store, ctx, m));
  const canRequest = !!bed && evaluate(store, ctx, { op: 'BED_MOVE_REQUEST', personId }).decision === 'ALLOW'
    && !moves.some((m) => ['REQUESTED', 'ALLOCATED'].includes(String(m.state)));
  return { bed: bed ? { ...bed, features: labels(bed.features) } : null, stays, moves, canRequest, options: options() };
}

export function request(store: Store, ctx: WorkContext, personId: string, b: { needs?: string; reason?: string; urgency?: string }) {
  enforce(store, ctx, { op: 'BED_MOVE_REQUEST', personId }, personId);
  const bed = store.get<{ id: string }>("SELECT id FROM bed WHERE person_id = ? AND service_id = ? AND state = 'OCCUPIED'", personId, ctx.serviceId);
  if (!bed) throw new HttpError(409, 'NO_BED', 'This patient is not in one of your service\'s beds.');
  if (store.get("SELECT 1 FROM bed_move WHERE person_id = ? AND state IN ('REQUESTED', 'ALLOCATED')", personId)) {
    throw new HttpError(409, 'ALREADY_REQUESTED', 'A move is already asked for. Change or cancel that one.');
  }
  const reason = (b.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why they need to move.');
  const needs = list(b.needs).join(',') || null;
  const urgency = URGENCY[String(b.urgency)] ? String(b.urgency) : 'ROUTINE';
  const id = newId();
  store.tx(() => {
    store.insert('bed_move', {
      id, person_id: personId, service_id: ctx.serviceId, needs, reason, urgency, state: 'REQUESTED', from_bed_id: bed.id, requested_by: ctx.workerId, requested_at: now(),
    });
    recordInitial(store, 'bedmove', id, 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, reason);
    logged(store, ctx, 'BED_MOVE_REQUEST', id, personId, reason);
  });
  return { id };
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { bedId?: string; note?: string }) {
  const m = store.get<Row>(`${MOVE} WHERE m.id = ?`, id);
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'That move no longer exists.');
  const personId = String(m.personId);
  const serviceId = String(m.serviceId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = (b.note ?? '').trim().slice(0, 500);
  const manage = () => enforce(store, ctx, { op: 'BED_MANAGE', serviceId, organisationId: ctx.organisationId }, personId);
  store.tx(() => {
    switch (action) {
      case 'allocate': {
        manage();
        if (m.state !== 'REQUESTED') throw new HttpError(409, 'WRONG_STATE', 'A bed has already been found.');
        const bed = store.get<{ id: string; label: string; features: string | null }>("SELECT id, label, features FROM bed WHERE id = ? AND service_id = ? AND state = 'AVAILABLE'", b.bedId ?? '', serviceId);
        if (!bed) throw new HttpError(409, 'BED_UNAVAILABLE', 'That bed is no longer available.');
        const missing = list(m.needs).filter((n) => !list(bed.features).includes(n));
        if (missing.length && note.length < 3) {
          throw new HttpError(400, 'NOTE_REQUIRED', `${bed.label} has no ${missing.map((x) => FEATURES[x].toLowerCase()).join(' or ')}. Write why it is still the right bed.`);
        }
        store.run("UPDATE bed SET state = 'RESERVED', person_id = ?, updated_at = ? WHERE id = ?", personId, now(), bed.id);
        store.run('UPDATE bed_move SET bed_id = ?, allocated_by = ?, allocated_at = ?, allocation_note = ? WHERE id = ?', bed.id, ctx.workerId, now(), note || null, id);
        transition(store, 'bedmove', id, 'ALLOCATED', who, `${bed.label}${note ? `: ${note}` : ''}`);
        logged(store, ctx, 'BED_MOVE_ALLOCATE', id, personId, bed.label);
        break;
      }
      case 'release': {
        manage();
        if (m.state !== 'ALLOCATED') throw new HttpError(409, 'WRONG_STATE', 'No bed is held for this move.');
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the bed is being given back.');
        store.run("UPDATE bed SET state = 'AVAILABLE', person_id = NULL, updated_at = ? WHERE id = ? AND state = 'RESERVED'", now(), m.bedId);
        store.run('UPDATE bed_move SET bed_id = NULL, allocated_by = NULL, allocated_at = NULL, allocation_note = NULL WHERE id = ?', id);
        transition(store, 'bedmove', id, 'REQUESTED', who, note);
        logged(store, ctx, 'BED_MOVE_RELEASE', id, personId, note);
        break;
      }
      case 'move': {
        manage();
        if (!ctx.role.capabilities.includes('record.view')) throw new HttpError(403, 'BLOCK', 'The move is recorded by the staff moving the patient.');
        if (m.state !== 'ALLOCATED') throw new HttpError(409, 'WRONG_STATE', 'Find a bed first.');
        const at = now();
        const reason = `Moved from ${m.fromBed ?? 'another bed'}: ${m.reason}`;
        vacate(store, personId, serviceId, `Moved to ${m.bed}`, at);
        store.run("UPDATE bed SET state = 'CLEANING', person_id = NULL, updated_at = ? WHERE person_id = ? AND service_id = ? AND state = 'OCCUPIED'", at, personId, serviceId);
        store.run("UPDATE bed SET state = 'OCCUPIED', updated_at = ? WHERE id = ?", at, m.bedId);
        occupy(store, String(m.bedId), personId, serviceId, reason, at);
        store.run("UPDATE encounter SET location = ? WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", m.bed, personId, serviceId);
        store.run('UPDATE bed_move SET moved_by = ?, moved_at = ? WHERE id = ?', ctx.workerId, at, id);
        transition(store, 'bedmove', id, 'MOVED', who, note || `Now in ${m.bed}`);
        logged(store, ctx, 'BED_MOVE', id, personId, `${m.fromBed} to ${m.bed}`);
        break;
      }
      case 'cancel': {
        if (!(m.serviceId === ctx.serviceId && (ctx.role.capabilities.includes('bed.manage') || ctx.role.capabilities.includes('bed.request')))) {
          throw new HttpError(403, 'BLOCK', 'Only the ward can cancel this move.');
        }
        if (!['REQUESTED', 'ALLOCATED'].includes(String(m.state))) throw new HttpError(409, 'WRONG_STATE', 'This move is finished.');
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the move is no longer needed.');
        if (m.bedId) store.run("UPDATE bed SET state = 'AVAILABLE', person_id = NULL, updated_at = ? WHERE id = ? AND state = 'RESERVED'", now(), m.bedId);
        store.run('UPDATE bed_move SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
        transition(store, 'bedmove', id, 'CANCELLED', who, note);
        logged(store, ctx, 'BED_MOVE_CANCEL', id, personId, note);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do with a bed move.');
    }
  });
  return shapeMove(store, ctx, store.get<Row>(`${MOVE} WHERE m.id = ?`, id)!);
}

// Home → Bed moves: moves waiting in this service, most urgent first, and the ward's beds.
export function board(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'BED_MANAGE', serviceId: ctx.serviceId, organisationId: ctx.organisationId });
  const services = ctx.role.capabilities.includes('record.view')
    ? [ctx.serviceId]
    : store.all<{ id: string }>("SELECT DISTINCT b.service_id AS id FROM bed b JOIN service s ON s.id = b.service_id WHERE s.organisation_id = ?", ctx.organisationId).map((s) => s.id);
  const q = services.map(() => '?').join(',');
  const moves = store.all<Row>(`${MOVE} WHERE m.service_id IN (${q}) AND m.state IN ('REQUESTED', 'ALLOCATED')`, ...services)
    .map((m) => shapeMove(store, ctx, m))
    .sort((a, b) => RANK[String(a.urgency)] - RANK[String(b.urgency)] || String(a.requestedAt).localeCompare(String(b.requestedAt)));
  const beds = store.all<Row>(
    `SELECT b.id, b.label, b.state, b.features, s.name AS service,
            CASE WHEN b.person_id IS NULL THEN NULL ELSE (SELECT given_name || ' ' || family_name FROM person WHERE id = b.person_id) END AS patient
       FROM bed b JOIN service s ON s.id = b.service_id WHERE b.service_id IN (${q}) ORDER BY s.name, ${bedOrder}`, ...services,
  ).map((b) => ({ ...b, features: labels(b.features) }));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_BED_MOVES', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return { moves, beds, options: options() };
}

// A bed's own history: who was in it, from when until when.
export function bedHistory(store: Store, ctx: WorkContext, bedId: string) {
  const bed = store.get<{ serviceId: string; label: string }>('SELECT service_id AS serviceId, label FROM bed WHERE id = ?', bedId);
  if (!bed) throw new HttpError(404, 'NOT_FOUND', 'Bed not found.');
  enforce(store, ctx, { op: 'BED_MANAGE', serviceId: bed.serviceId, organisationId: ctx.organisationId });
  return {
    label: bed.label,
    stays: store.all(
      `SELECT p.given_name || ' ' || p.family_name AS patient, o.from_at AS fromAt, o.until_at AS untilAt, o.reason_in AS reasonIn, o.reason_out AS reasonOut
         FROM bed_occupancy o JOIN person p ON p.id = o.person_id WHERE o.bed_id = ? ORDER BY o.from_at DESC LIMIT 20`, bedId,
    ),
  };
}
