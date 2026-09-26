import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Clinical equipment (Shared Lifecycle Object 246):
//   identity → availability → allocation → patient use → setup → safety check → use → fault →
//   withdrawal / quarantine → maintenance / repair → return to service → retirement.
// Equipment past its planned service date is not set up for a patient, and a reported fault
// takes it out of use at once: both are organisational configuration (ORG-SYN-001). Settings
// are what the clinician wrote; SHIFT does not calculate infusion rates or doses.

type Row = Record<string, string | number | null>;
export const KINDS: Record<string, string> = {
  INFUSION_PUMP: 'Infusion pump', FEEDING_PUMP: 'Feeding pump', PRESSURE_MATTRESS: 'Pressure-relieving mattress', HOIST: 'Hoist',
  OBS_MONITOR: 'Observation monitor', SUCTION: 'Suction unit', OTHER: 'Other',
};
const STATES: Record<string, string> = { AVAILABLE: 'Available', IN_USE: 'In use', QUARANTINED: 'Do not use', IN_REPAIR: 'Away for repair', RETIRED: 'Retired' };
const EVENTS: Record<string, string> = {
  FAULT: 'Fault reported', SENT_FOR_REPAIR: 'Sent for repair', RETURNED: 'Back in service', NO_FAULT_FOUND: 'No fault found', SERVICED: 'Serviced',
};
const REFS = ['ORG-SYN-001 v1'];

const SELECT = `
  SELECT q.id, q.asset_tag AS assetTag, q.kind, q.description, q.service_due AS serviceDue, q.state, q.service_id AS serviceId, s.name AS service,
         q.added_at AS addedAt, rb.display_name AS retiredBy, q.retired_at AS retiredAt, q.retire_reason AS retireReason
    FROM equipment q
    JOIN service s ON s.id = q.service_id
    LEFT JOIN workforce_person rb ON rb.id = q.retired_by`;

const USE = `
  SELECT u.id, u.equipment_id AS equipmentId, u.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = u.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         u.purpose, u.settings, u.checked_note AS checkedNote, sb.display_name AS startedBy, u.started_at AS startedAt,
         eb.display_name AS endedBy, u.ended_at AS endedAt, u.end_note AS endNote
    FROM equipment_use u
    JOIN person p ON p.id = u.person_id
    JOIN workforce_person sb ON sb.id = u.started_by
    LEFT JOIN workforce_person eb ON eb.id = u.ended_by`;

const overdue = (q: Row) => !!q.serviceDue && String(q.serviceDue) < todayLocal();
const dueSoon = (q: Row) => {
  if (!q.serviceDue) return false;
  const soon = new Date(); soon.setDate(soon.getDate() + 14);
  return String(q.serviceDue) <= todayLocal(soon);
};

function shape(store: Store, ctx: WorkContext, q: Row) {
  const id = String(q.id);
  const use = store.get<Row>(`${USE} WHERE u.equipment_id = ? AND u.ended_at IS NULL`, id) ?? null;
  const events = store.all<Row>(
    `SELECT v.kind, v.note, v.patient_affected AS patientAffected, w.display_name AS by, v.at FROM equipment_event v
       JOIN workforce_person w ON w.id = v.by_id WHERE v.equipment_id = ? ORDER BY v.at DESC LIMIT 6`, id,
  ).map((v) => ({ ...v, kindLabel: EVENTS[String(v.kind)], patientAffected: v.patientAffected === 1 }));
  const mine = q.serviceId === ctx.serviceId;
  const canUse = ctx.role.capabilities.includes('equipment.use');
  const manage = mine && ctx.role.capabilities.includes('equipment.manage');
  const actions: string[] = [];
  if (q.state === 'IN_USE' && canUse) actions.push('end');
  if ((q.state === 'IN_USE' || q.state === 'AVAILABLE') && canUse) actions.push('fault');
  if (q.state === 'QUARANTINED' && manage) actions.push('repair', 'clear');
  if (q.state === 'IN_REPAIR' && manage) actions.push('return');
  if (q.state === 'AVAILABLE' && manage) actions.push('service');
  if (['AVAILABLE', 'QUARANTINED', 'IN_REPAIR'].includes(String(q.state)) && manage) actions.push('retire');
  return {
    ...q, kindLabel: KINDS[String(q.kind)], stateLabel: STATES[String(q.state)], serviceOverdue: overdue(q), serviceSoon: dueSoon(q),
    use, events, actions, history: history(store, 'equipment', id),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, id: string, personId: string | null, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'equipment', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS, engines: [42],
  });
}

const options = () => ({ kinds: KINDS });

// Available equipment this worker may set up for the person: their own service's, and the
// service where the person is staying.
function available(store: Store, ctx: WorkContext, personId: string) {
  return store.all<Row>(
    `${SELECT} WHERE q.state = 'AVAILABLE' AND (q.service_id = ?
       OR q.service_id IN (SELECT service_id FROM encounter WHERE person_id = ? AND state = 'ACTIVE')) ORDER BY q.kind, q.asset_tag`,
    ctx.serviceId, personId,
  ).map((q) => ({ id: q.id, assetTag: q.assetTag, kindLabel: KINDS[String(q.kind)], description: q.description, service: q.service, serviceOverdue: overdue(q) }));
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const current = store.all<{ equipmentId: string }>(`${USE} WHERE u.person_id = ? AND u.ended_at IS NULL ORDER BY u.started_at`, personId);
  const past = store.all<Row>(`${USE} WHERE u.person_id = ? AND u.ended_at IS NOT NULL ORDER BY u.ended_at DESC LIMIT 5`, personId);
  const canUse = evaluate(store, ctx, { op: 'EQUIPMENT_USE', personId }).decision === 'ALLOW';
  return {
    equipment: current.map((u) => shape(store, ctx, store.get<Row>(`${SELECT} WHERE q.id = ?`, u.equipmentId)!)),
    past: past.map((u) => ({ ...u, equipment: store.get<Row>('SELECT asset_tag AS assetTag, kind FROM equipment WHERE id = ?', String(u.equipmentId)) })),
    available: canUse ? available(store, ctx, personId) : [], canUse, options: options(),
  };
}

const load = (store: Store, id: string) => {
  const q = store.get<Row>(`${SELECT} WHERE q.id = ?`, id);
  if (!q) throw new HttpError(404, 'NOT_FOUND', 'That equipment is not on the register.');
  return q;
};

// Set up for a patient: the check before use and the setup are recorded with it.
export function start(store: Store, ctx: WorkContext, personId: string, b: { equipmentId?: string; purpose?: string; settings?: string; checked?: string }) {
  enforce(store, ctx, { op: 'EQUIPMENT_USE', personId }, personId);
  const q = load(store, String(b.equipmentId));
  if (!available(store, ctx, personId).some((a) => a.id === q.id)) throw new HttpError(409, 'NOT_AVAILABLE', `${q.assetTag} is not available to you for this patient.`);
  if (overdue(q)) throw new HttpError(409, 'SERVICE_OVERDUE', `${q.assetTag} was due for servicing on ${q.serviceDue}. Choose another, and tell the person in charge.`);
  const purpose = (b.purpose ?? '').trim().slice(0, 300);
  if (purpose.length < 3) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Write what it is being used for.');
  const checked = (b.checked ?? '').trim().slice(0, 500);
  if (checked.length < 3) throw new HttpError(400, 'CHECK_REQUIRED', 'Write the check you did before use.');
  const uid = newId();
  store.tx(() => {
    store.insert('equipment_use', {
      id: uid, equipment_id: q.id, person_id: personId, service_id: ctx.serviceId, purpose, settings: (b.settings ?? '').trim().slice(0, 500) || null,
      checked_note: checked, started_by: ctx.workerId, started_at: now(),
    });
    transition(store, 'equipment', String(q.id), 'IN_USE', { actorId: ctx.workerId, workContextId: ctx.id }, purpose);
    logged(store, ctx, 'EQUIPMENT_START', String(q.id), personId, purpose);
  });
  return shape(store, ctx, load(store, String(q.id)));
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; patientAffected?: boolean; serviceDue?: string }) {
  const q = load(store, id);
  const note = (b.note ?? '').trim().slice(0, 1000);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const use = store.get<{ id: string; personId: string }>('SELECT id, person_id AS personId FROM equipment_use WHERE equipment_id = ? AND ended_at IS NULL', id);
  const event = (kind: string, personId: string | null = null, affected: boolean | null = null) =>
    store.insert('equipment_event', { id: newId(), equipment_id: id, kind, note, person_id: personId, patient_affected: affected === null ? null : affected ? 1 : 0, by_id: ctx.workerId, at: now() });
  const endUse = (endNote: string) => {
    if (use) store.run('UPDATE equipment_use SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), endNote, use.id);
  };
  const manage = () => {
    if (!ctx.role.capabilities.includes('equipment.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not manage equipment`);
    if (q.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', `${q.assetTag} belongs to ${q.service}.`);
  };
  const needNote = (msg: string) => { if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  switch (action) {
    case 'end': {
      if (!use) throw new HttpError(409, 'NOT_IN_USE', `${q.assetTag} is not in use.`);
      enforce(store, ctx, { op: 'EQUIPMENT_USE', personId: use.personId }, use.personId);
      store.tx(() => {
        endUse(note || 'Finished with; cleaned and returned');
        transition(store, 'equipment', id, 'AVAILABLE', who, note || 'Returned');
        logged(store, ctx, 'EQUIPMENT_END', id, use.personId, note || undefined);
      });
      break;
    }
    case 'fault': {
      if (!ctx.role.capabilities.includes('equipment.use')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not use equipment`);
      if (!['IN_USE', 'AVAILABLE'].includes(String(q.state))) throw new HttpError(409, 'NOT_IN_SERVICE', `${q.assetTag} is already out of use.`);
      needNote('Write what went wrong.');
      store.tx(() => {
        event('FAULT', use?.personId ?? null, use ? !!b.patientAffected : null);
        endUse(`Taken out of use: ${note}`);
        transition(store, 'equipment', id, 'QUARANTINED', who, note);
        logged(store, ctx, 'EQUIPMENT_FAULT', id, use?.personId ?? null, note);
      });
      break;
    }
    case 'repair':
    case 'clear':
    case 'return': {
      manage();
      const from = action === 'return' ? 'IN_REPAIR' : 'QUARANTINED';
      if (q.state !== from) throw new HttpError(409, 'WRONG_STATE', `${q.assetTag} is ${STATES[String(q.state)].toLowerCase()}.`);
      needNote({ repair: 'Write where it is going and the job number.', clear: 'Write who checked it and what they found.', return: 'Write what was repaired.' }[action]);
      store.tx(() => {
        event({ repair: 'SENT_FOR_REPAIR', clear: 'NO_FAULT_FOUND', return: 'RETURNED' }[action]);
        transition(store, 'equipment', id, action === 'repair' ? 'IN_REPAIR' : 'AVAILABLE', who, note);
        if (action === 'return' && /^\d{4}-\d{2}-\d{2}$/.test(String(b.serviceDue))) store.run('UPDATE equipment SET service_due = ? WHERE id = ?', String(b.serviceDue), id);
        logged(store, ctx, `EQUIPMENT_${action.toUpperCase()}`, id, null, note);
      });
      break;
    }
    case 'service': {
      manage();
      if (q.state !== 'AVAILABLE') throw new HttpError(409, 'WRONG_STATE', `${q.assetTag} must be available to record a service.`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.serviceDue))) throw new HttpError(400, 'DATE_REQUIRED', 'Choose when the next service is due.');
      needNote('Write who serviced it.');
      store.tx(() => {
        event('SERVICED');
        store.run('UPDATE equipment SET service_due = ? WHERE id = ?', String(b.serviceDue), id);
        logged(store, ctx, 'EQUIPMENT_SERVICED', id, null, note);
      });
      break;
    }
    case 'retire': {
      manage();
      needNote('Write why it is being retired.');
      store.tx(() => {
        transition(store, 'equipment', id, 'RETIRED', who, note);
        store.run('UPDATE equipment SET retired_by = ?, retired_at = ?, retire_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
        logged(store, ctx, 'EQUIPMENT_RETIRE', id, null, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do with equipment.');
  }
  return shape(store, ctx, load(store, id));
}

export function add(store: Store, ctx: WorkContext, b: { assetTag?: string; kind?: string; description?: string; serviceDue?: string }) {
  if (!ctx.role.capabilities.includes('equipment.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not manage equipment`);
  const tag = (b.assetTag ?? '').trim().toUpperCase().slice(0, 20);
  if (tag.length < 2) throw new HttpError(400, 'TAG_REQUIRED', 'Write the asset tag.');
  if (store.get('SELECT 1 FROM equipment WHERE asset_tag = ?', tag)) throw new HttpError(409, 'TAG_EXISTS', `${tag} is already on the register.`);
  const kind = KINDS[String(b.kind)] ? String(b.kind) : 'OTHER';
  const description = (b.description ?? '').trim().slice(0, 200);
  if (description.length < 2) throw new HttpError(400, 'DESCRIPTION_REQUIRED', 'Write what it is (make and model).');
  const id = newId();
  store.tx(() => {
    store.insert('equipment', {
      id, organisation_id: ctx.organisationId, service_id: ctx.serviceId, asset_tag: tag, kind, description,
      service_due: /^\d{4}-\d{2}-\d{2}$/.test(String(b.serviceDue)) ? String(b.serviceDue) : null, state: 'AVAILABLE', added_by: ctx.workerId, added_at: now(),
    });
    recordInitial(store, 'equipment', id, 'AVAILABLE', { actorId: ctx.workerId, workContextId: ctx.id }, 'Added to the register');
    logged(store, ctx, 'EQUIPMENT_ADD', id, null, `${tag} ${description}`);
  });
  return shape(store, ctx, load(store, id));
}

// Home → Equipment: this service's register, anything out of use first.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('equipment.use')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include equipment`);
  const rows = store.all<Row>(`${SELECT} WHERE q.service_id = ? AND q.state != 'RETIRED' ORDER BY q.kind, q.asset_tag`, ctx.serviceId).map((q) => shape(store, ctx, q));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_EQUIPMENT', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return { equipment: rows, canManage: ctx.role.capabilities.includes('equipment.manage'), options: options() };
}

// For the alert engine: equipment in use on a patient past its planned service date.
export function inUseOverdue(store: Store, serviceId: string) {
  return store.all<Row>(
    `SELECT q.id, q.asset_tag AS assetTag, q.kind, q.service_due AS serviceDue, u.person_id AS personId FROM equipment q
       JOIN equipment_use u ON u.equipment_id = q.id AND u.ended_at IS NULL
      WHERE q.service_id = ? AND q.state = 'IN_USE' AND q.service_due < ?`, serviceId, todayLocal(),
  ).map((q) => ({ personId: String(q.personId), objectId: String(q.id), title: `${KINDS[String(q.kind)]} ${q.assetTag} is past its service date`, detail: `Service was due ${q.serviceDue}. Swap it for another when you can.` }));
}
