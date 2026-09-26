import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';
import { vacate } from './locations.ts';
import { requireCoding } from './coding.ts';

// Discharge (Shared Lifecycle Object 222):
//   considered → readiness → decision → outstanding requirements → discharge.
// The decision is a clinician's; each requirement is recorded by whoever met it; and the
// person leaves only when a nurse records the discharge with every requirement accounted for.
// Nothing here assumes a receiving party has accepted responsibility.

type Cap = 'discharge.plan' | 'discharge.decide' | 'discharge.complete';
type Row = Record<string, string | number | null>;

export const REQUIREMENTS: { code: string; label: string; cap: Cap; hint: string; text?: boolean }[] = [
  { code: 'readiness', label: 'Readiness assessed', cap: 'discharge.plan', hint: 'Clinically ready and safe to leave' },
  { code: 'medicines', label: 'Medicines reconciled', cap: 'discharge.decide', hint: 'Discharge medicines checked against admission and in-hospital changes' },
  { code: 'summary', label: 'Discharge summary written', cap: 'discharge.decide', hint: 'What happened, what changed, and what happens next', text: true },
  { code: 'whanau', label: 'Patient and whānau told', cap: 'discharge.plan', hint: 'Who was told, and what they understood' },
  { code: 'followup', label: 'Follow-up and referrals arranged', cap: 'discharge.plan', hint: 'Appointments, tests and services after discharge' },
  { code: 'destination', label: 'Destination arranged', cap: 'discharge.plan', hint: 'Transport, supports and who is expecting them' },
];
const BY_CODE = new Map(REQUIREMENTS.map((r) => [r.code, r]));
export const DESTINATIONS = ['Home', 'Home with support', 'Residential care', 'Another hospital', 'Hospice', 'Other'];

const SELECT = `
  SELECT d.id, d.state, d.destination, d.expected_date AS expectedDate, d.note, d.person_id AS personId, d.service_id AS serviceId,
         p.given_name || ' ' || p.family_name AS patient, s.name AS service,
         (SELECT location FROM encounter e WHERE e.id = d.encounter_id) AS location,
         cb.display_name AS consideredBy, d.considered_at AS consideredAt, db.display_name AS decidedBy,
         xb.display_name AS dischargedBy, d.discharged_at AS dischargedAt
    FROM discharge d
    JOIN person p ON p.id = d.person_id
    JOIN service s ON s.id = d.service_id
    JOIN workforce_person cb ON cb.id = d.considered_by
    LEFT JOIN workforce_person db ON db.id = d.decided_by
    LEFT JOIN workforce_person xb ON xb.id = d.discharged_by`;

const OPEN = "('CONSIDERED', 'DECIDED')";

const can = (store: Store, ctx: WorkContext, personId: string, cap: Cap) =>
  evaluate(store, ctx, { op: 'DISCHARGE', personId, cap }).decision === 'ALLOW';

function requirements(store: Store, ctx: WorkContext, d: Row, open: boolean) {
  const done = store.all<{ code: string; status: string; note: string | null; by: string; at: string }>(
    `SELECT r.code, r.status, r.note, w.display_name AS by, r.recorded_at AS at
       FROM discharge_requirement r JOIN workforce_person w ON w.id = r.recorded_by WHERE r.discharge_id = ?`, d.id,
  );
  return REQUIREMENTS.map((r) => {
    const got = done.find((x) => x.code === r.code) ?? null;
    return {
      code: r.code, label: r.label, hint: r.hint, text: Boolean(r.text),
      status: got?.status ?? null, note: got?.note ?? null, by: got?.by ?? null, at: got?.at ?? null,
      canRecord: open && !got && can(store, ctx, String(d.personId), r.cap),
    };
  });
}

function shape(store: Store, ctx: WorkContext, d: Row) {
  const open = d.state === 'CONSIDERED' || d.state === 'DECIDED';
  const reqs = requirements(store, ctx, d, open);
  const outstanding = reqs.filter((r) => !r.status).length;
  const personId = String(d.personId);
  const actions: string[] = [];
  if (open) {
    const readiness = reqs.find((r) => r.code === 'readiness')!.status;
    if (d.state === 'CONSIDERED' && readiness && can(store, ctx, personId, 'discharge.decide')) actions.push('decide');
    if (d.state === 'DECIDED' && outstanding === 0 && can(store, ctx, personId, 'discharge.complete')) actions.push('complete');
    if (d.state === 'DECIDED' && can(store, ctx, personId, 'discharge.decide')) actions.push('reverse');
    if (can(store, ctx, personId, 'discharge.plan')) actions.push('cancel');
  }
  return { ...d, requirements: reqs, outstanding, actions, history: history(store, 'discharge', String(d.id)) };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, objectId: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'discharge', objectId, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [13, 42],
  });
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(`${SELECT} WHERE d.person_id = ? AND d.service_id = ? ORDER BY d.considered_at DESC`, personId, ctx.serviceId);
  const open = rows.some((r) => r.state === 'CONSIDERED' || r.state === 'DECIDED');
  const admitted = Boolean(store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId));
  return {
    discharges: rows.map((r) => shape(store, ctx, r)),
    canStart: admitted && !open && can(store, ctx, personId, 'discharge.plan'),
    destinations: DESTINATIONS,
  };
}

export function start(store: Store, ctx: WorkContext, personId: string, b: { destination?: string; expectedDate?: string; note?: string }) {
  enforce(store, ctx, { op: 'DISCHARGE', personId, cap: 'discharge.plan' }, personId);
  const destination = DESTINATIONS.includes(b.destination ?? '') ? b.destination! : null;
  if (!destination) throw new HttpError(400, 'DESTINATION_REQUIRED', 'Choose where they are expected to go.');
  const expected = /^\d{4}-\d{2}-\d{2}$/.test(b.expectedDate ?? '') ? b.expectedDate! : null;
  if (expected && expected < todayLocal()) throw new HttpError(400, 'INVALID_DATE', 'The expected date cannot be in the past.');
  if (store.get(`SELECT 1 FROM discharge WHERE person_id = ? AND service_id = ? AND state IN ${OPEN}`, personId, ctx.serviceId)) {
    throw new HttpError(409, 'ALREADY_OPEN', 'Discharge is already being planned for this patient.');
  }
  const enc = store.get<{ id: string }>("SELECT id FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId)!;
  const id = newId();
  const note = b.note?.trim().slice(0, 500) || null;
  store.tx(() => {
    store.insert('discharge', {
      id, person_id: personId, service_id: ctx.serviceId, encounter_id: enc.id, destination, expected_date: expected,
      state: 'CONSIDERED', considered_by: ctx.workerId, considered_at: now(), note,
    });
    recordInitial(store, 'discharge', id, 'CONSIDERED', { actorId: ctx.workerId, workContextId: ctx.id }, note ?? `Discharge considered: ${destination}`);
    logged(store, ctx, 'DISCHARGE_CONSIDER', personId, id, destination);
  });
  return { id, state: 'CONSIDERED' };
}

const load = (store: Store, id: string) => {
  const d = store.get<Row>(`${SELECT} WHERE d.id = ?`, id);
  if (!d) throw new HttpError(404, 'NOT_FOUND', 'That discharge no longer exists.');
  return d;
};

export function record(store: Store, ctx: WorkContext, id: string, code: string, b: { status?: string; note?: string }) {
  const d = load(store, id);
  const req = BY_CODE.get(code);
  if (!req) throw new HttpError(400, 'UNKNOWN_REQUIREMENT', 'Unknown discharge requirement.');
  const personId = String(d.personId);
  enforce(store, ctx, { op: 'DISCHARGE', personId, cap: req.cap }, personId);
  if (d.state !== 'CONSIDERED' && d.state !== 'DECIDED') throw new HttpError(409, 'CLOSED', 'This discharge is no longer open.');
  const status = b.status === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'DONE';
  const note = b.note?.trim().slice(0, req.text ? 4000 : 500) || null;
  if (status === 'NOT_APPLICABLE' && (!note || note.length < 5)) throw new HttpError(400, 'REASON_REQUIRED', 'Say why this does not apply.');
  if (status === 'DONE' && req.text && (!note || note.length < 20)) throw new HttpError(400, 'SUMMARY_REQUIRED', 'Write the discharge summary.');
  if (status === 'DONE' && !req.text && (!note || note.length < 3)) throw new HttpError(400, 'NOTE_REQUIRED', `Add a short note on what was done.`);
  if (store.get('SELECT 1 FROM discharge_requirement WHERE discharge_id = ? AND code = ?', id, code)) throw new HttpError(409, 'ALREADY_RECORDED', `${req.label} is already recorded.`);
  store.tx(() => {
    store.insert('discharge_requirement', { id: newId(), discharge_id: id, code, status, note, recorded_by: ctx.workerId, recorded_at: now() });
    logged(store, ctx, `DISCHARGE_${code.toUpperCase()}`, personId, id, status === 'NOT_APPLICABLE' ? `Not applicable: ${note}` : req.label);
  });
  return shape(store, ctx, load(store, id));
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const d = load(store, id);
  const personId = String(d.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = b.note?.trim().slice(0, 500) || undefined;
  return store.tx(() => {
    switch (action) {
      case 'decide': {
        enforce(store, ctx, { op: 'DISCHARGE', personId, cap: 'discharge.decide' }, personId);
        if (!store.get("SELECT 1 FROM discharge_requirement WHERE discharge_id = ? AND code = 'readiness'", id)) {
          throw new HttpError(409, 'NOT_READY', 'Readiness must be assessed before the decision to discharge.');
        }
        transition(store, 'discharge', id, 'DECIDED', who, note ?? 'Decision to discharge');
        store.run('UPDATE discharge SET decided_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      }
      case 'reverse': {
        enforce(store, ctx, { op: 'DISCHARGE', personId, cap: 'discharge.decide' }, personId);
        if (!note) throw new HttpError(400, 'REASON_REQUIRED', 'Give the reason for reversing the decision.');
        transition(store, 'discharge', id, 'CONSIDERED', who, note);
        store.run('UPDATE discharge SET decided_by = NULL WHERE id = ?', id);
        break;
      }
      case 'complete': {
        enforce(store, ctx, { op: 'DISCHARGE', personId, cap: 'discharge.complete' }, personId);
        const missing = REQUIREMENTS.filter((r) => !store.get('SELECT 1 FROM discharge_requirement WHERE discharge_id = ? AND code = ?', id, r.code));
        if (missing.length) throw new HttpError(409, 'OUTSTANDING', `Still outstanding: ${missing.map((r) => r.label.toLowerCase()).join(', ')}.`);
        transition(store, 'discharge', id, 'DISCHARGED', who, note ?? `Discharged: ${d.destination}`);
        const at = now();
        store.run('UPDATE discharge SET discharged_by = ?, discharged_at = ? WHERE id = ?', ctx.workerId, at, id);
        store.run("UPDATE encounter SET state = 'ENDED', ended_at = ? WHERE id = (SELECT encounter_id FROM discharge WHERE id = ?) AND state = 'ACTIVE'", at, id);
        requireCoding(store, String(store.get<{ e: string }>('SELECT encounter_id AS e FROM discharge WHERE id = ?', id)?.e), `Discharged: ${d.destination}`, who);
        vacate(store, personId, ctx.serviceId, 'Discharged', at);
        store.run("UPDATE bed SET state = 'CLEANING', person_id = NULL, updated_at = ? WHERE person_id = ? AND service_id = ?", at, personId, ctx.serviceId);
        // Hospital services sharing this person's care (e.g. physiotherapy) end with the stay.
        store.run(
          'UPDATE care_relationship SET ended_at = ? WHERE person_id = ? AND ended_at IS NULL AND service_id IN (SELECT id FROM service WHERE organisation_id = ?)',
          at, personId, ctx.organisationId,
        );
        break;
      }
      case 'cancel': {
        enforce(store, ctx, { op: 'DISCHARGE', personId, cap: 'discharge.plan' }, personId);
        if (!note) throw new HttpError(400, 'REASON_REQUIRED', 'Give the reason for stopping discharge planning.');
        transition(store, 'discharge', id, 'CANCELLED', who, note);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `DISCHARGE_${action.toUpperCase()}`, personId, id, note);
    return shape(store, ctx, load(store, id));
  });
}

// Discharges being planned in this service, or across the organisation for patient flow.
export function list(store: Store, ctx: WorkContext) {
  const flow = !ctx.role.capabilities.includes('record.view');
  enforce(store, ctx, { op: 'TRANSFER_VIEW', serviceIds: [ctx.serviceId] });
  const recent = "(d.state IN ('CONSIDERED','DECIDED') OR (d.state = 'DISCHARGED' AND d.discharged_at > datetime('now', '-1 day')))";
  const rows = flow
    ? store.all<Row>(`${SELECT} WHERE s.organisation_id = ? AND ${recent} ORDER BY d.expected_date IS NULL, d.expected_date, d.considered_at`, ctx.organisationId)
    : store.all<Row>(`${SELECT} WHERE d.service_id = ? AND ${recent} ORDER BY d.expected_date IS NULL, d.expected_date, d.considered_at`, ctx.serviceId);
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_DISCHARGES', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  // Patient flow sees progress, not clinical content: the summary and notes stay in the record.
  return rows.map((r) => {
    const d = shape(store, ctx, r);
    if (!flow) return { ...d, flow: false };
    return { ...d, note: null, flow: true, history: [], requirements: d.requirements.map((q) => ({ ...q, note: null })) };
  });
}
