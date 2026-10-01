import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { LOANABLE, CONDITION, REFS as LOAN_REFS } from '../config/loans.ts';
import { NOTICE_KINDS, NOTICE_STATES, REFS as NOTICE_REFS } from '../config/notices.ts';
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
  OBS_MONITOR: 'Observation monitor', SUCTION: 'Suction unit', ...LOANABLE, OTHER: 'Other',
};
const STATES: Record<string, string> = {
  NEW: 'Waiting for its acceptance check', AVAILABLE: 'Available', IN_USE: 'In use', ON_LOAN: 'Lent for home', CLEANING: 'Back: clean before reuse', QUARANTINED: 'Do not use', IN_REPAIR: 'Away for repair', RETIRED: 'Retired',
};
const EVENTS: Record<string, string> = {
  FAULT: 'Fault reported', SENT_FOR_REPAIR: 'Sent for repair', RETURNED: 'Back in service', NO_FAULT_FOUND: 'No fault found', SERVICED: 'Serviced',
  LENT: 'Lent for home', BACK: 'Returned from loan', CLEANED: 'Cleaned', LOST: 'Not returned',
  ACCEPTED: 'Acceptance check passed', NOTICE: 'Safety notice', NOTICE_DONE: 'Safety notice action done',
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

const LOAN = `
  SELECT l.id, l.equipment_id AS equipmentId, l.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         l.purpose, l.fitted, l.return_by AS returnBy, lb.display_name AS lentBy, l.lent_at AS lentAt,
         rb.display_name AS returnedBy, l.returned_at AS returnedAt, l.condition, l.return_note AS returnNote,
         cb.display_name AS cleanedBy, l.cleaned_at AS cleanedAt, l.clean_note AS cleanNote
    FROM equipment_loan l
    JOIN person p ON p.id = l.person_id
    JOIN workforce_person lb ON lb.id = l.lent_by
    LEFT JOIN workforce_person rb ON rb.id = l.returned_by
    LEFT JOIN workforce_person cb ON cb.id = l.cleaned_by`;
const loanShape = (l: Row | undefined | null) => l ? { ...l, overdue: !l.returnedAt && !!l.returnBy && String(l.returnBy) < todayLocal(), conditionLabel: l.condition ? CONDITION[String(l.condition)] ?? 'Not returned' : null } : null;
const lends = (ctx: WorkContext) => ctx.role.capabilities.includes('equipment.lend');

const overdue = (q: Row) => !!q.serviceDue && String(q.serviceDue) < todayLocal();
const dueSoon = (q: Row) => {
  if (!q.serviceDue) return false;
  const soon = new Date(); soon.setDate(soon.getDate() + 14);
  return String(q.serviceDue) <= todayLocal(soon);
};

// Safety notices still open for one item, with whether its action is overdue.
const openNotices = (store: Store, id: string) => store.all<Row>(
  `SELECT n.id, n.kind, n.title, n.action, n.due_date AS dueDate FROM equipment_notice_item i JOIN equipment_notice n ON n.id = i.notice_id
    WHERE i.equipment_id = ? AND i.done_at IS NULL AND n.state = 'OPEN' ORDER BY n.issued_at`, id,
).map((n): Record<string, any> => ({ ...n, kindLabel: NOTICE_KINDS[String(n.kind)], overdue: n.kind === 'ACT' && !!n.dueDate && String(n.dueDate) < todayLocal() }));

function shape(store: Store, ctx: WorkContext, q: Row) {
  const id = String(q.id);
  const notices = openNotices(store, id);
  const use = store.get<Row>(`${USE} WHERE u.equipment_id = ? AND u.ended_at IS NULL`, id) ?? null;
  const events = store.all<Row>(
    `SELECT v.kind, v.note, v.patient_affected AS patientAffected, w.display_name AS by, v.at FROM equipment_event v
       JOIN workforce_person w ON w.id = v.by_id WHERE v.equipment_id = ? ORDER BY v.at DESC LIMIT 6`, id,
  ).map((v) => ({ ...v, kindLabel: EVENTS[String(v.kind)], patientAffected: v.patientAffected === 1 }));
  const mine = q.serviceId === ctx.serviceId;
  const canUse = ctx.role.capabilities.includes('equipment.use');
  const loan = ['ON_LOAN', 'CLEANING'].includes(String(q.state)) ? loanShape(store.get<Row>(`${LOAN} WHERE l.equipment_id = ? AND l.cleaned_at IS NULL ORDER BY l.lent_at DESC LIMIT 1`, id)) : null;
  const loanable = !!LOANABLE[String(q.kind)];
  const manage = mine && ctx.role.capabilities.includes('equipment.manage');
  const actions: string[] = [];
  if (q.state === 'NEW' && manage) actions.push('accept');
  if (q.state === 'ON_LOAN' && mine && lends(ctx)) actions.push('back', 'lost');
  if (q.state === 'CLEANING' && mine && (lends(ctx) || ctx.role.capabilities.includes('equipment.manage'))) actions.push('cleaned');
  if (q.state === 'IN_USE' && canUse) actions.push('end');
  if ((q.state === 'IN_USE' || q.state === 'AVAILABLE') && canUse) actions.push('fault');
  if (q.state === 'QUARANTINED' && manage) actions.push(...(notices.some((n) => n.kind === 'STOP') ? ['repair'] : ['repair', 'clear']));
  if (q.state === 'IN_REPAIR' && manage) actions.push('return');
  if (q.state === 'AVAILABLE' && manage) actions.push('service');
  if (['NEW', 'AVAILABLE', 'QUARANTINED', 'IN_REPAIR'].includes(String(q.state)) && manage) actions.push('retire');
  return {
    ...q, kindLabel: KINDS[String(q.kind)], stateLabel: STATES[String(q.state)], serviceOverdue: overdue(q), serviceSoon: dueSoon(q),
    notices, use, loan, loanable, conditionOptions: loanable ? CONDITION : null, events, actions, history: history(store, 'equipment', id),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, id: string, personId: string | null, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'equipment', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS, engines: [42],
  });
}

const options = () => ({ kinds: KINDS, condition: CONDITION });

// Available equipment this worker may set up for the person: their own service's, and the
// service where the person is staying.
function available(store: Store, ctx: WorkContext, personId: string) {
  return store.all<Row>(
    `${SELECT} WHERE q.state = 'AVAILABLE' AND q.kind NOT IN (${Object.keys(LOANABLE).map(() => '?').join(',')}) AND (q.service_id = ?
       OR q.service_id IN (SELECT service_id FROM encounter WHERE person_id = ? AND state = 'ACTIVE')) ORDER BY q.kind, q.asset_tag`,
    ...Object.keys(LOANABLE), ctx.serviceId, personId,
  ).map((q) => ({ id: q.id, assetTag: q.assetTag, kindLabel: KINDS[String(q.kind)], description: q.description, service: q.service, serviceOverdue: overdue(q) }));
}

// Aids this worker's service can lend to take home.
function lendable(store: Store, ctx: WorkContext) {
  return store.all<Row>(`${SELECT} WHERE q.state = 'AVAILABLE' AND q.service_id = ? AND q.kind IN (${Object.keys(LOANABLE).map(() => '?').join(',')}) ORDER BY q.kind, q.asset_tag`,
    ctx.serviceId, ...Object.keys(LOANABLE),
  ).map((q) => ({ id: q.id, assetTag: q.assetTag, kindLabel: KINDS[String(q.kind)], description: q.description, serviceOverdue: overdue(q) }));
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const current = store.all<{ equipmentId: string }>(`${USE} WHERE u.person_id = ? AND u.ended_at IS NULL ORDER BY u.started_at`, personId);
  const past = store.all<Row>(`${USE} WHERE u.person_id = ? AND u.ended_at IS NOT NULL ORDER BY u.ended_at DESC LIMIT 5`, personId);
  const canUse = evaluate(store, ctx, { op: 'EQUIPMENT_USE', personId }).decision === 'ALLOW';
  const canLend = lends(ctx) && evaluate(store, ctx, { op: 'EQUIPMENT_LEND', personId }).decision === 'ALLOW';
  const loans = store.all<Row>(`${LOAN} WHERE l.person_id = ? AND l.returned_at IS NULL ORDER BY l.lent_at`, personId)
    .map((l) => ({ ...loanShape(l), equipment: shape(store, ctx, store.get<Row>(`${SELECT} WHERE q.id = ?`, String(l.equipmentId))!) }));
  const loansPast = store.all<Row>(`${LOAN} WHERE l.person_id = ? AND l.returned_at IS NOT NULL ORDER BY l.returned_at DESC LIMIT 5`, personId)
    .map((l) => ({ ...loanShape(l), equipment: store.get<Row>('SELECT asset_tag AS assetTag, kind FROM equipment WHERE id = ?', String(l.equipmentId)) }));
  return {
    loans, loansPast, canLend, lendable: canLend ? lendable(store, ctx) : [],
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
  const late = openNotices(store, String(q.id)).find((n) => n.overdue);
  if (late) throw new HttpError(409, 'NOTICE_OVERDUE', `${q.assetTag} has a safety notice action that was due ${late.dueDate}: ${late.title}. Choose another, and tell the person in charge.`);
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

// Lend an aid to take home: fitted, shown how to use it, and when it is due back.
export function lend(store: Store, ctx: WorkContext, personId: string, b: { equipmentId?: string; purpose?: string; fitted?: string; returnBy?: string }) {
  enforce(store, ctx, { op: 'EQUIPMENT_LEND', personId }, personId);
  const q = load(store, String(b.equipmentId));
  if (!lendable(store, ctx).some((a) => a.id === q.id)) throw new HttpError(409, 'NOT_AVAILABLE', `${q.assetTag} is not available for you to lend.`);
  if (overdue(q)) throw new HttpError(409, 'SERVICE_OVERDUE', `${q.assetTag} was due for servicing on ${q.serviceDue}. Choose another, and tell the person in charge.`);
  const purpose = (b.purpose ?? '').trim().slice(0, 300);
  if (purpose.length < 3) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Write what it is for at home, e.g. "Walking indoors until her knee settles".');
  const fitted = (b.fitted ?? '').trim().slice(0, 500);
  if (fitted.length < 5) throw new HttpError(400, 'FITTED_REQUIRED', 'Write how it was fitted and what they were shown, e.g. "Height set to wrist crease; practised stairs with daughter".');
  const returnBy = /^\d{4}-\d{2}-\d{2}$/.test(String(b.returnBy)) ? String(b.returnBy) : null;
  if (returnBy && returnBy < todayLocal()) throw new HttpError(400, 'RETURN_BY', 'The return date cannot be in the past.');
  store.tx(() => {
    store.insert('equipment_loan', { id: newId(), equipment_id: q.id, person_id: personId, service_id: ctx.serviceId, purpose, fitted, return_by: returnBy, lent_by: ctx.workerId, lent_at: now() });
    store.insert('equipment_event', { id: newId(), equipment_id: String(q.id), kind: 'LENT', note: `${purpose}. ${fitted}`, person_id: personId, patient_affected: null, by_id: ctx.workerId, at: now() });
    transition(store, 'equipment', String(q.id), 'ON_LOAN', { actorId: ctx.workerId, workContextId: ctx.id }, purpose);
    audit(store, {
      actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
      operation: 'EQUIPMENT_LEND', objectType: 'equipment', objectId: String(q.id), decision: 'ALLOW', outcome: 'COMMITTED', reason: purpose, ruleRefs: LOAN_REFS, engines: [198],
    });
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; patientAffected?: boolean; serviceDue?: string; condition?: string }) {
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
  const loan = store.get<{ id: string; personId: string }>('SELECT id, person_id AS personId FROM equipment_loan WHERE equipment_id = ? AND cleaned_at IS NULL ORDER BY lent_at DESC LIMIT 1', id);
  const lender = () => {
    if (!lends(ctx) && !(action === 'cleaned' && ctx.role.capabilities.includes('equipment.manage'))) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not lend equipment`);
    if (q.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', `${q.assetTag} belongs to ${q.service}.`);
    if (!loan) throw new HttpError(409, 'NOT_ON_LOAN', `${q.assetTag} is not on loan.`);
  };
  const loanLog = (operation: string, reason: string) => audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: loan?.personId ?? null,
    operation, objectType: 'equipment', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: LOAN_REFS, engines: [198],
  });
  switch (action) {
    case 'back': {
      lender();
      if (q.state !== 'ON_LOAN') throw new HttpError(409, 'WRONG_STATE', `${q.assetTag} is ${STATES[String(q.state)].toLowerCase()}.`);
      const condition = CONDITION[String(b.condition)] ? String(b.condition) : '';
      if (!condition) throw new HttpError(400, 'CONDITION_REQUIRED', 'Choose what condition it came back in.');
      if (condition !== 'GOOD') needNote('Write what is wrong with it.');
      store.tx(() => {
        store.run('UPDATE equipment_loan SET returned_by = ?, returned_at = ?, condition = ?, return_note = ? WHERE id = ?', ctx.workerId, now(), condition, note || null, loan!.id);
        event('BACK', loan!.personId);
        if (condition === 'GOOD') transition(store, 'equipment', id, 'CLEANING', who, 'Returned; to be cleaned');
        else {
          event('FAULT', loan!.personId, false);
          store.run('UPDATE equipment_loan SET cleaned_by = ?, cleaned_at = ?, clean_note = ? WHERE id = ?', ctx.workerId, now(), 'Taken out of use instead', loan!.id);
          transition(store, 'equipment', id, 'QUARANTINED', who, note);
        }
        loanLog('EQUIPMENT_LOAN_BACK', `${CONDITION[condition]}${note ? `: ${note}` : ''}`);
      });
      break;
    }
    case 'cleaned': {
      lender();
      if (q.state !== 'CLEANING') throw new HttpError(409, 'WRONG_STATE', `${q.assetTag} is ${STATES[String(q.state)].toLowerCase()}.`);
      needNote('Write how it was cleaned and checked, e.g. "Detergent wipe then disinfectant; ferrules and brakes checked".');
      store.tx(() => {
        store.run('UPDATE equipment_loan SET cleaned_by = ?, cleaned_at = ?, clean_note = ? WHERE id = ?', ctx.workerId, now(), note, loan!.id);
        event('CLEANED');
        transition(store, 'equipment', id, 'AVAILABLE', who, 'Cleaned and checked');
        loanLog('EQUIPMENT_CLEANED', note);
      });
      break;
    }
    case 'lost': {
      lender();
      if (q.state !== 'ON_LOAN') throw new HttpError(409, 'WRONG_STATE', `${q.assetTag} is ${STATES[String(q.state)].toLowerCase()}.`);
      needNote('Write what was tried to get it back.');
      store.tx(() => {
        store.run('UPDATE equipment_loan SET returned_by = ?, returned_at = ?, condition = ?, return_note = ?, cleaned_at = ? WHERE id = ?', ctx.workerId, now(), 'LOST', note, now(), loan!.id);
        event('LOST', loan!.personId);
        transition(store, 'equipment', id, 'RETIRED', who, `Not returned: ${note}`);
        store.run('UPDATE equipment SET retired_by = ?, retired_at = ?, retire_reason = ? WHERE id = ?', ctx.workerId, now(), `Not returned: ${note}`, id);
        loanLog('EQUIPMENT_LOAN_LOST', note);
      });
      break;
    }
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
    case 'accept': {
      manage();
      if (q.state !== 'NEW') throw new HttpError(409, 'WRONG_STATE', `${q.assetTag} has already been accepted.`);
      needNote('Write who checked it and what they checked, e.g. "Electrical safety tag in date, self-test passed, alarms work".');
      store.tx(() => {
        event('ACCEPTED');
        transition(store, 'equipment', id, 'AVAILABLE', who, note);
        logged(store, ctx, 'EQUIPMENT_ACCEPT', id, null, note);
      });
      break;
    }
    case 'repair':
    case 'clear':
    case 'return': {
      manage();
      if (action !== 'repair' && openNotices(store, id).some((n) => n.kind === 'STOP')) throw new HttpError(409, 'NOTICE_OPEN', `${q.assetTag} has a safety notice that stops its use. Record the notice's action as done first.`);
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
      service_due: /^\d{4}-\d{2}-\d{2}$/.test(String(b.serviceDue)) ? String(b.serviceDue) : null, state: 'NEW', added_by: ctx.workerId, added_at: now(),
    });
    recordInitial(store, 'equipment', id, 'NEW', { actorId: ctx.workerId, workContextId: ctx.id }, 'Added to the register; acceptance check before first use');
    logged(store, ctx, 'EQUIPMENT_ADD', id, null, `${tag} ${description}`);
  });
  return shape(store, ctx, load(store, id));
}

// Home → Equipment: this service's register, anything out of use first.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('equipment.use')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include equipment`);
  const rows = store.all<Row>(`${SELECT} WHERE q.service_id = ? AND q.state != 'RETIRED' ORDER BY q.kind, q.asset_tag`, ctx.serviceId).map((q) => shape(store, ctx, q));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_EQUIPMENT', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return { equipment: rows, notices: notices(store, ctx), canManage: ctx.role.capabilities.includes('equipment.manage'), options: options() };
}

// Safety notices this service has recorded: open first, then the last few closed.
function notices(store: Store, ctx: WorkContext) {
  const rows = store.all<Row>(
    `SELECT n.id, n.kind, n.title, n.source, n.action, n.due_date AS dueDate, n.state, w.display_name AS issuedBy, n.issued_at AS issuedAt, n.closed_at AS closedAt
       FROM equipment_notice n JOIN workforce_person w ON w.id = n.issued_by WHERE n.service_id = ?
      ORDER BY n.state = 'OPEN' DESC, n.issued_at DESC LIMIT 20`, ctx.serviceId);
  const manage = ctx.role.capabilities.includes('equipment.manage');
  return rows.map((n) => {
    const items = store.all<Row>(
      `SELECT i.equipment_id AS equipmentId, q.asset_tag AS assetTag, q.kind, q.state, w.display_name AS doneBy, i.done_at AS doneAt, i.done_note AS doneNote
         FROM equipment_notice_item i JOIN equipment q ON q.id = i.equipment_id LEFT JOIN workforce_person w ON w.id = i.done_by
        WHERE i.notice_id = ? ORDER BY q.asset_tag`, String(n.id),
    ).map((i): Record<string, any> => ({ ...i, kindLabel: KINDS[String(i.kind)], stateLabel: STATES[String(i.state)], canDo: manage && n.state === 'OPEN' && !i.doneAt }));
    return {
      ...n, kindLabel: NOTICE_KINDS[String(n.kind)], stateLabel: NOTICE_STATES[String(n.state)], items, done: items.filter((i) => i.doneAt).length,
      overdue: n.state === 'OPEN' && n.kind === 'ACT' && !!n.dueDate && String(n.dueDate) < todayLocal(),
    };
  });
}

const noticeLog = (store: Store, ctx: WorkContext, operation: string, id: string, reason: string) => audit(store, {
  actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation, objectType: 'equipment_notice', objectId: id,
  decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: NOTICE_REFS, engines: [135],
});

// Record a safety notice against the items it covers. "Stop using now" takes each one out of
// use at once, ending its use with any patient.
export function notice(store: Store, ctx: WorkContext, b: { kind?: string; title?: string; source?: string; action?: string; dueDate?: string; equipmentIds?: string }) {
  if (!ctx.role.capabilities.includes('equipment.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not manage equipment`);
  const kind = NOTICE_KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose whether it stops use now or needs an action by a date.');
  const title = (b.title ?? '').trim().slice(0, 200);
  if (title.length < 5) throw new HttpError(400, 'TITLE_REQUIRED', 'Write what the notice is about, e.g. "Battery may fail without alarm".');
  const source = (b.source ?? '').trim().slice(0, 200);
  if (source.length < 3) throw new HttpError(400, 'SOURCE_REQUIRED', 'Write who issued it and its reference, e.g. "Manufacturer field safety notice FSN-2026-114".');
  const action = (b.action ?? '').trim().slice(0, 1000);
  if (action.length < 5) throw new HttpError(400, 'ACTION_REQUIRED', 'Write what the notice says to do, word for word where you can.');
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate)) ? String(b.dueDate) : null;
  if (kind === 'ACT' && !dueDate) throw new HttpError(400, 'DUE_REQUIRED', 'Choose the date the action is needed by.');
  const ids = [...new Set(String(b.equipmentIds ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  const items = ids.map((x) => store.get<Row>(`${SELECT} WHERE q.id = ?`, x)).filter((q): q is Row => !!q && q.serviceId === ctx.serviceId && q.state !== 'RETIRED');
  if (!items.length || items.length !== ids.length) throw new HttpError(400, 'ITEMS_REQUIRED', 'Choose the equipment on your register that the notice covers.');
  const nid = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('equipment_notice', { id: nid, service_id: ctx.serviceId, kind, title, source, action, due_date: kind === 'ACT' ? dueDate : null, state: 'OPEN', issued_by: ctx.workerId, issued_at: now() });
    for (const q of items) {
      const qid = String(q.id);
      const stop = kind === 'STOP' && ['AVAILABLE', 'IN_USE', 'NEW'].includes(String(q.state));
      store.insert('equipment_notice_item', { id: newId(), notice_id: nid, equipment_id: qid, stopped: stop ? 1 : 0 });
      const use = store.get<{ id: string; personId: string }>('SELECT id, person_id AS personId FROM equipment_use WHERE equipment_id = ? AND ended_at IS NULL', qid);
      store.insert('equipment_event', { id: newId(), equipment_id: qid, kind: 'NOTICE', note: `${NOTICE_KINDS[kind]}: ${title}. ${action}`, person_id: use?.personId ?? null, patient_affected: null, by_id: ctx.workerId, at: now() });
      if (stop) {
        if (use) store.run('UPDATE equipment_use SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), `Taken out of use: safety notice, ${title}`, use.id);
        transition(store, 'equipment', qid, 'QUARANTINED', who, `Safety notice: ${title}`);
      }
    }
    noticeLog(store, ctx, 'EQUIPMENT_NOTICE', nid, `${NOTICE_KINDS[kind]}: ${title}`);
  });
  return list(store, ctx);
}

// The notice's action is done for one item. One the notice stopped goes back into use; when
// every item is done the notice closes.
export function noticeDone(store: Store, ctx: WorkContext, noticeId: string, b: { equipmentId?: string; note?: string }) {
  if (!ctx.role.capabilities.includes('equipment.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not manage equipment`);
  const n = store.get<Row>('SELECT id, kind, title, state, service_id AS serviceId FROM equipment_notice WHERE id = ?', noticeId);
  if (!n || n.serviceId !== ctx.serviceId) throw new HttpError(404, 'NOT_FOUND', 'That safety notice is not on your register.');
  if (n.state !== 'OPEN') throw new HttpError(409, 'CLOSED', 'That safety notice is already closed.');
  const item = store.get<Row>('SELECT id, stopped, done_at AS doneAt FROM equipment_notice_item WHERE notice_id = ? AND equipment_id = ?', noticeId, String(b.equipmentId));
  if (!item) throw new HttpError(404, 'NOT_FOUND', 'That equipment is not covered by this notice.');
  if (item.doneAt) throw new HttpError(409, 'DONE', 'Already recorded as done.');
  const note = (b.note ?? '').trim().slice(0, 1000);
  if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was done and who did it, e.g. "Firmware 4.2 installed by clinical engineering, job 8812".');
  const qid = String(b.equipmentId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.run('UPDATE equipment_notice_item SET done_by = ?, done_at = ?, done_note = ? WHERE id = ?', ctx.workerId, now(), note, String(item.id));
    store.insert('equipment_event', { id: newId(), equipment_id: qid, kind: 'NOTICE_DONE', note: `${n.title}: ${note}`, person_id: null, patient_affected: null, by_id: ctx.workerId, at: now() });
    const state = store.get<{ s: string }>('SELECT state AS s FROM equipment WHERE id = ?', qid)?.s;
    if (item.stopped === 1 && state === 'QUARANTINED' && !openNotices(store, qid).some((x) => x.kind === 'STOP')) {
      transition(store, 'equipment', qid, 'AVAILABLE', who, `Safety notice action done: ${note}`);
    }
    if (!store.get('SELECT 1 FROM equipment_notice_item WHERE notice_id = ? AND done_at IS NULL', noticeId)) {
      store.run("UPDATE equipment_notice SET state = 'CLOSED', closed_at = ? WHERE id = ?", now(), noticeId);
    }
    noticeLog(store, ctx, 'EQUIPMENT_NOTICE_DONE', noticeId, note);
  });
  return list(store, ctx);
}

// For the alert engine: equipment in use on a patient past its planned service date.
export function inUseOverdue(store: Store, serviceId: string) {
  return store.all<Row>(
    `SELECT q.id, q.asset_tag AS assetTag, q.kind, q.service_due AS serviceDue, u.person_id AS personId FROM equipment q
       JOIN equipment_use u ON u.equipment_id = q.id AND u.ended_at IS NULL
      WHERE q.service_id = ? AND q.state = 'IN_USE' AND q.service_due < ?`, serviceId, todayLocal(),
  ).map((q) => ({ personId: String(q.personId), objectId: String(q.id), title: `${KINDS[String(q.kind)]} ${q.assetTag} is past its service date`, detail: `Service was due ${q.serviceDue}. Swap it for another when you can.` }));
}
