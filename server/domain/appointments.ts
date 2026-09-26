import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Appointment (Shared Lifecycle Object 208):
//   requested → offered → booked → confirmed → arrived → commenced → completed, or
//   cancelled / did not attend / unable to complete → follow-up requirement.
// A requested appointment is the service's waitlist entry, ordered by clinical priority.
// Accepting a referral puts the person on the waitlist; booking an appointment for a
// referral is what schedules the referral.

type Row = Record<string, string | number | null>;
const OPEN = "('REQUESTED', 'OFFERED', 'BOOKED', 'CONFIRMED', 'ARRIVED', 'COMMENCED')";
const ENDED = ['COMPLETED', 'CANCELLED', 'DID_NOT_ATTEND', 'UNABLE_TO_COMPLETE'];
const PRIORITIES = ['URGENT', 'SEMI_URGENT', 'ROUTINE'];
const MODES = ['IN_PERSON', 'PHONE', 'VIDEO'];
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const SELECT = `
  SELECT a.id, a.state, a.reason, a.priority, a.mode, a.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = a.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         a.service_id AS serviceId, s.name AS service, a.referral_id AS referralId, rs.name AS referredFrom, a.previous_id AS previousId,
         rq.display_name AS requestedBy, a.requested_at AS requestedAt, a.start_at AS startAt, a.duration_min AS duration, a.place,
         cn.display_name AS clinician, a.response_note AS responseNote, cf.display_name AS confirmedBy, a.arrived_at AS arrivedAt,
         a.commenced_at AS commencedAt, en.display_name AS endedBy, a.ended_at AS endedAt, a.end_note AS endNote, a.follow_up AS followUp
    FROM appointment a
    JOIN person p ON p.id = a.person_id
    JOIN service s ON s.id = a.service_id
    JOIN workforce_person rq ON rq.id = a.requested_by
    LEFT JOIN referral r ON r.id = a.referral_id
    LEFT JOIN service rs ON rs.id = r.from_service_id
    LEFT JOIN workforce_person cn ON cn.id = a.clinician_id
    LEFT JOIN workforce_person cf ON cf.id = a.confirmed_by
    LEFT JOIN workforce_person en ON en.id = a.ended_by`;

const manager = (store: Store, ctx: WorkContext, a: Row) =>
  evaluate(store, ctx, { op: 'APPOINTMENT_MANAGE', serviceId: String(a.serviceId), clinical: false }).decision === 'ALLOW';

function shape(store: Store, ctx: WorkContext, a: Row) {
  const actions: string[] = [];
  const state = String(a.state);
  const started = a.startAt ? String(a.startAt) <= localNow() : false;
  if (manager(store, ctx, a)) {
    if (state === 'REQUESTED') actions.push('offer', 'book');
    if (state === 'OFFERED') actions.push('accepted', 'declined');
    if (state === 'BOOKED') actions.push('confirm');
    if (state === 'BOOKED' || state === 'CONFIRMED') actions.push('arrive', 'reschedule');
    if ((state === 'BOOKED' || state === 'CONFIRMED') && started) actions.push('dna');
    if (state === 'ARRIVED') actions.push('start');
    if (state === 'COMMENCED') actions.push('complete');
    if (state === 'ARRIVED' || state === 'COMMENCED') actions.push('unable');
    if (['REQUESTED', 'OFFERED', 'BOOKED', 'CONFIRMED'].includes(state)) actions.push('cancel');
  }
  return { ...a, actions, ours: a.serviceId === ctx.serviceId, history: history(store, 'appointment', String(a.id)) };
}

function localNow() {
  const d = new Date();
  return `${todayLocal(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'appointment', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [37, 38, 39],
  });
}

// Put a person on a service's waitlist. Used directly, and when a referral is accepted.
export function addRequest(store: Store, ctx: WorkContext, personId: string, serviceId: string, v: { reason: string; priority: string; mode?: string; referralId?: string | null; previousId?: string | null }) {
  const id = newId();
  store.insert('appointment', {
    id, person_id: personId, service_id: serviceId, referral_id: v.referralId ?? null, previous_id: v.previousId ?? null,
    reason: v.reason, priority: PRIORITIES.includes(v.priority) ? v.priority : 'ROUTINE', mode: MODES.includes(String(v.mode)) ? v.mode : 'IN_PERSON',
    state: 'REQUESTED', requested_by: ctx.workerId, requested_at: now(),
  });
  recordInitial(store, 'appointment', id, 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, v.referralId ? 'From an accepted referral' : v.previousId ? 'Follow-up' : undefined);
  logged(store, ctx, 'APPOINTMENT_REQUEST', personId, id);
  return id;
}

// When a referral ends without being seen, its unbooked or booked appointments go too.
export function cancelForReferral(store: Store, ctx: WorkContext, referralId: string, reason: string) {
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  for (const a of store.all<{ id: string }>(`SELECT id FROM appointment WHERE referral_id = ? AND state IN ('REQUESTED', 'OFFERED', 'BOOKED', 'CONFIRMED')`, referralId)) {
    transition(store, 'appointment', a.id, 'CANCELLED', who, `Referral ${reason}`);
    store.run("UPDATE appointment SET ended_by = ?, ended_at = ?, end_note = ?, follow_up = 'NONE' WHERE id = ?", ctx.workerId, now(), `Referral ${reason}`, a.id);
  }
}

// Book a referral's appointment: the open one if there is one, or a new one.
export function bookForReferral(store: Store, ctx: WorkContext, referralId: string, when: string) {
  const r = store.get<{ person_id: string; to_service_id: string; request: string; priority: string; triage_priority: string | null }>(
    'SELECT person_id, to_service_id, request, priority, triage_priority FROM referral WHERE id = ?', referralId,
  );
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That referral no longer exists.');
  const a = store.get<{ id: string }>(`SELECT id FROM appointment WHERE referral_id = ? AND state IN ('REQUESTED', 'OFFERED', 'BOOKED', 'CONFIRMED') ORDER BY requested_at DESC LIMIT 1`, referralId);
  const id = a?.id ?? addRequest(store, ctx, r.person_id, r.to_service_id, { reason: r.request, priority: r.triage_priority ?? r.priority, referralId });
  const state = store.get<{ state: string }>('SELECT state FROM appointment WHERE id = ?', id)!.state;
  if (state === 'CONFIRMED') transition(store, 'appointment', id, 'BOOKED', { actorId: ctx.workerId, workContextId: ctx.id }, `Moved to ${when.replace('T', ' ')}`);
  else transition(store, 'appointment', id, 'BOOKED', { actorId: ctx.workerId, workContextId: ctx.id }, when.replace('T', ' '));
  store.run('UPDATE appointment SET start_at = ?, duration_min = COALESCE(duration_min, 45), booked_by = ?, clinician_id = COALESCE(clinician_id, ?) WHERE id = ?', when, ctx.workerId, ctx.workerId, id);
  return id;
}

// Booking an appointment for a referral schedules the referral (Object 203 "scheduled").
function scheduleReferral(store: Store, ctx: WorkContext, a: Row, when: string) {
  if (!a.referralId) return;
  const r = store.get<{ state: string }>('SELECT state FROM referral WHERE id = ?', a.referralId);
  if (r && (r.state === 'ACCEPTED' || r.state === 'SCHEDULED')) {
    transition(store, 'referral', String(a.referralId), 'SCHEDULED', { actorId: ctx.workerId, workContextId: ctx.id }, when.replace('T', ' '));
    store.run('UPDATE referral SET scheduled_for = ?, scheduled_by = ? WHERE id = ?', when, ctx.workerId, a.referralId);
  }
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(
    `${SELECT} WHERE a.person_id = ? AND (a.state IN ${OPEN} OR a.ended_at > datetime('now', '-14 days'))
      ORDER BY CASE WHEN a.state IN ${OPEN} THEN 0 ELSE 1 END, COALESCE(a.start_at, '9999'), a.requested_at`, personId,
  );
  const canRequest = ctx.role.capabilities.includes('appointment.manage') && evaluate(store, ctx, { op: 'APPOINTMENT_REQUEST', personId }).decision === 'ALLOW';
  return { appointments: rows.map((r) => shape(store, ctx, r)), canRequest, service: ctx.serviceName };
}

export function request(store: Store, ctx: WorkContext, personId: string, b: { reason?: string; priority?: string; mode?: string }) {
  enforce(store, ctx, { op: 'APPOINTMENT_REQUEST', personId }, personId);
  const reason = (b.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write what the appointment is for.');
  return store.tx(() => ({ id: addRequest(store, ctx, personId, ctx.serviceId, { reason, priority: String(b.priority), mode: String(b.mode) }) }));
}

const load = (store: Store, id: string) => {
  const a = store.get<Row>(`${SELECT} WHERE a.id = ?`, id);
  if (!a) throw new HttpError(404, 'NOT_FOUND', 'That appointment no longer exists.');
  return a;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; when?: string; duration?: string; place?: string; mode?: string; another?: boolean }) {
  const a = load(store, id);
  const personId = String(a.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = b.note?.trim().slice(0, 2000) || '';
  const manage = (clinical = false) => enforce(store, ctx, { op: 'APPOINTMENT_MANAGE', serviceId: String(a.serviceId), clinical }, personId);
  const need = (min: number, message: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', message); };
  const slot = () => {
    const when = String(b.when ?? '');
    if (!WHEN.test(when)) throw new HttpError(400, 'WHEN_REQUIRED', 'Choose the date and time.');
    const duration = Math.min(240, Math.max(5, Number(b.duration) || 45));
    const place = (b.place ?? '').trim().slice(0, 120) || null;
    const mode = MODES.includes(String(b.mode)) ? String(b.mode) : String(a.mode);
    return { when, duration, place, mode };
  };
  const end = (to: string, reason: string) => {
    transition(store, 'appointment', id, to, who, reason);
    store.run('UPDATE appointment SET ended_by = ?, ended_at = ?, end_note = ?, follow_up = ? WHERE id = ?', ctx.workerId, now(), note || null, b.another ? 'ANOTHER' : 'NONE', id);
    // A follow-up requirement goes straight back on the waitlist.
    if (b.another) addRequest(store, ctx, personId, String(a.serviceId), { reason: String(a.reason), priority: String(a.priority), mode: String(a.mode), referralId: a.referralId ? String(a.referralId) : null, previousId: id });
  };
  store.tx(() => {
    switch (action) {
      case 'offer': case 'book': case 'reschedule': {
        manage();
        const s = slot();
        const to = action === 'offer' ? 'OFFERED' : 'BOOKED';
        transition(store, 'appointment', id, to, who, `${action === 'reschedule' ? 'Moved to ' : ''}${s.when.replace('T', ' ')}`);
        store.run(`UPDATE appointment SET start_at = ?, duration_min = ?, place = ?, mode = ?, clinician_id = COALESCE(clinician_id, ?),
                   ${action === 'offer' ? 'offered_by' : 'booked_by'} = ?, confirmed_by = NULL WHERE id = ?`,
          s.when, s.duration, s.place, s.mode, ctx.workerId, ctx.workerId, id);
        if (to === 'BOOKED') scheduleReferral(store, ctx, a, s.when);
        break;
      }
      case 'accepted':
        manage();
        transition(store, 'appointment', id, 'BOOKED', who, 'Patient accepted the offer');
        store.run('UPDATE appointment SET booked_by = ?, response_note = ? WHERE id = ?', ctx.workerId, note || null, id);
        scheduleReferral(store, ctx, a, String(a.startAt));
        break;
      case 'declined':
        manage();
        need(3, 'Record what the patient said.');
        transition(store, 'appointment', id, 'REQUESTED', who, `Offer declined: ${note}`);
        store.run('UPDATE appointment SET start_at = NULL, place = NULL, response_note = ? WHERE id = ?', note, id);
        break;
      case 'confirm':
        manage();
        transition(store, 'appointment', id, 'CONFIRMED', who, note || undefined);
        store.run('UPDATE appointment SET confirmed_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'arrive':
        manage();
        transition(store, 'appointment', id, 'ARRIVED', who, String(a.mode) === 'IN_PERSON' ? 'Arrived' : 'Connected');
        store.run('UPDATE appointment SET arrived_by = ?, arrived_at = ? WHERE id = ?', ctx.workerId, now(), id);
        break;
      case 'start':
        manage(true);
        transition(store, 'appointment', id, 'COMMENCED', who);
        store.run('UPDATE appointment SET commenced_by = ?, commenced_at = ?, clinician_id = ? WHERE id = ?', ctx.workerId, now(), ctx.workerId, id);
        break;
      case 'complete':
        manage(true);
        end('COMPLETED', note || 'Completed');
        break;
      case 'unable':
        manage(true);
        need(3, 'Say why the appointment could not be completed.');
        end('UNABLE_TO_COMPLETE', note);
        break;
      case 'dna':
        manage();
        if (!a.startAt || String(a.startAt) > localNow()) throw new HttpError(409, 'NOT_YET', 'The appointment time has not come yet.');
        end('DID_NOT_ATTEND', note || 'Did not attend');
        break;
      case 'cancel':
        manage();
        need(3, 'Give the reason for cancelling.');
        end('CANCELLED', note);
        break;
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `APPOINTMENT_${action.toUpperCase()}`, personId, id, note || undefined);
  });
  return shape(store, ctx, load(store, id));
}

// This service's waitlist and diary: open appointments, and those that ended today.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('appointment.manage')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include appointments`);
  }
  const rows = store.all<Row>(
    `${SELECT} WHERE a.service_id = ? AND (a.state IN ${OPEN} OR a.ended_at > datetime('now', '-1 day'))
      ORDER BY COALESCE(a.start_at, '9999'), CASE a.priority WHEN 'URGENT' THEN 0 WHEN 'SEMI_URGENT' THEN 1 ELSE 2 END, a.requested_at`,
    ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_APPOINTMENTS', decision: 'ALLOW', outcome: 'VIEWED', engines: [37, 38, 39] });
  return { today: todayLocal(), appointments: rows.map((r) => shape(store, ctx, r)), ended: ENDED };
}
