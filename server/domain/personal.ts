import type { Store } from '../db/database.ts';
import type { Session } from './identity.ts';
import { audit } from './audit.ts';
import { transition } from './lifecycle.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// PERSONAL: the signed-in worker's own employment information. It never opens a patient
// record, never creates WORK authority, and every query is scoped to the worker.
// Roster is not attendance; availability is not a rostered shift; interest in an open
// shift never changes the roster.

function seen(store: Store, s: Session, operation: string): void {
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation, outcome: 'VIEWED', engines: [27] });
}

export function roster(store: Store, s: Session, from = todayLocal(), days = 28) {
  const to = addDays(from, days);
  seen(store, s, 'VIEW_ROSTER');
  const shifts = store.all<Record<string, string | null>>(
    `SELECT r.id, r.shift_date AS date, r.start_time AS start, r.end_time AS end, r.state, sv.name AS service, p.title AS position,
            a.started_at AS actualStart, a.ended_at AS actualEnd, a.variance,
            (SELECT o.id FROM shift_offer o WHERE o.roster_shift_id = r.id AND o.state = 'OFFERED') AS offerId
       FROM roster_shift r JOIN service sv ON sv.id = r.service_id JOIN position p ON p.id = r.position_id
       LEFT JOIN actual_shift a ON a.roster_shift_id = r.id
      WHERE r.workforce_person_id = ? AND r.state = 'PLANNED' AND r.shift_date >= ? AND r.shift_date < ?
      ORDER BY r.shift_date, r.start_time`,
    s.workerId, addDays(from, -14), to,
  );
  return { from, to, shifts };
}

export function availability(store: Store, s: Session) {
  seen(store, s, 'VIEW_AVAILABILITY');
  return store.all(
    `SELECT id, available_date AS date, period, preference, private_note AS note, recorded_at AS recordedAt
       FROM availability WHERE workforce_person_id = ? AND withdrawn_at IS NULL AND available_date >= ?
      ORDER BY available_date, period`,
    s.workerId, todayLocal(),
  );
}

const PERIODS = ['AM', 'PM', 'NIGHT', 'ALL_DAY'];
const PREFS = ['AVAILABLE', 'PREFERRED', 'UNAVAILABLE'];

export function addAvailability(store: Store, s: Session, b: { date?: string; period?: string; preference?: string; note?: string }) {
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || b.date < todayLocal()) throw new HttpError(400, 'INVALID_DATE', 'Choose today or a future date.');
  if (!PERIODS.includes(String(b.period))) throw new HttpError(400, 'INVALID_PERIOD', 'Choose AM, PM, Night or All day.');
  if (!PREFS.includes(String(b.preference))) throw new HttpError(400, 'INVALID_PREFERENCE', 'Choose available, preferred or unavailable.');
  const id = newId();
  store.tx(() => {
    store.run('UPDATE availability SET withdrawn_at = ? WHERE workforce_person_id = ? AND available_date = ? AND period = ? AND withdrawn_at IS NULL', now(), s.workerId, b.date, b.period);
    store.insert('availability', { id, workforce_person_id: s.workerId, available_date: b.date, period: b.period, preference: b.preference, private_note: b.note?.trim().slice(0, 500) || null, recorded_at: now() });
    audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: 'AVAILABILITY_SET', objectType: 'availability', objectId: id, outcome: 'COMMITTED', engines: [27] });
  });
  return { id };
}

export function withdrawAvailability(store: Store, s: Session, id: string) {
  const r = store.run('UPDATE availability SET withdrawn_at = ? WHERE id = ? AND workforce_person_id = ? AND withdrawn_at IS NULL', now(), id, s.workerId);
  if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: 'AVAILABILITY_WITHDRAW', objectType: 'availability', objectId: id, outcome: 'COMMITTED' });
  return { id };
}

// Positions the worker currently holds; eligibility for open shifts and exchanges.
function myRoles(store: Store, s: Session) {
  return store.all<{ role_key: string; service_id: string }>(
    `SELECT DISTINCT p.role_key, p.service_id FROM position p JOIN employment e ON e.id = p.employment_id
      WHERE e.workforce_person_id = ? AND (p.end_date IS NULL OR p.end_date >= ?)`,
    s.workerId, todayLocal(),
  );
}

// Open shifts are shared anonymously: service, role, date and time only. Who else is
// interested, and who vacated the shift, is never shown. A shift the worker asked for
// stays visible after the rostering decision so they can see the outcome.
export function openShifts(store: Store, s: Session) {
  seen(store, s, 'VIEW_OPEN_SHIFTS');
  const roles = myRoles(store, s);
  if (!roles.length) return [];
  const cond = roles.map(() => '(o.role_key = ? AND o.service_id = ?)').join(' OR ');
  return store.all(
    `SELECT * FROM (
       SELECT o.id, o.shift_date AS date, o.start_time AS start, o.end_time AS end, sv.name AS service, o.role_key AS roleKey, o.state,
              (SELECT state FROM open_shift_interest i WHERE i.open_shift_id = o.id AND i.workforce_person_id = ? ORDER BY i.at DESC LIMIT 1) AS myInterest
         FROM open_shift o JOIN service sv ON sv.id = o.service_id
        WHERE o.shift_date >= ? AND (${cond}))
      WHERE state = 'OPEN' OR myInterest IN ('ACCEPTED', 'DECLINED')
      ORDER BY date, start`,
    s.workerId, todayLocal(), ...roles.flatMap((r) => [r.role_key, r.service_id]),
  );
}

export function shiftInterest(store: Store, s: Session, openShiftId: string, interested: boolean) {
  const visible = (openShifts(store, s) as { id: string; state: string }[]).some((o) => o.id === openShiftId && o.state === 'OPEN');
  if (!visible) throw new HttpError(404, 'NOT_FOUND', 'That shift is no longer open to you.');
  const clash = store.get(
    `SELECT 1 FROM roster_shift r JOIN open_shift o ON o.shift_date = r.shift_date
      WHERE o.id = ? AND r.workforce_person_id = ? AND r.state = 'PLANNED'`, openShiftId, s.workerId,
  );
  if (interested && clash) throw new HttpError(409, 'ROSTER_CLASH', 'You are already rostered that day.');
  const id = newId();
  store.insert('open_shift_interest', { id, open_shift_id: openShiftId, workforce_person_id: s.workerId, state: interested ? 'INTERESTED' : 'WITHDRAWN', at: now() });
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: interested ? 'OPEN_SHIFT_INTEREST' : 'OPEN_SHIFT_WITHDRAW', objectType: 'open_shift', objectId: openShiftId, outcome: 'COMMITTED', reason: 'Roster unchanged until a rostering decision is recorded', engines: [27] });
  return { state: interested ? 'INTERESTED' : 'WITHDRAWN', rosterChanged: false };
}

// Shift exchange: a worker offers one of their own rostered shifts. Eligible colleagues
// (same role in the same service) see the shift, never who offered it; the offerer sees
// how many colleagues would take it, never who. The roster changes only when the
// rostering decision is recorded.
export function offerShift(store: Store, s: Session, rosterShiftId: string) {
  const r = store.get<{ id: string }>(
    "SELECT id FROM roster_shift WHERE id = ? AND workforce_person_id = ? AND state = 'PLANNED' AND shift_date > ?", rosterShiftId, s.workerId, todayLocal(),
  );
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Only your own future rostered shifts can be offered.');
  if (store.get("SELECT 1 FROM shift_offer WHERE roster_shift_id = ? AND state = 'OFFERED'", rosterShiftId)) throw new HttpError(409, 'ALREADY_OFFERED', 'That shift is already offered.');
  const id = newId();
  store.insert('shift_offer', { id, roster_shift_id: rosterShiftId, offered_by: s.workerId, state: 'OFFERED', created_at: now() });
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: 'SHIFT_OFFER', objectType: 'shift_offer', objectId: id, outcome: 'COMMITTED', reason: 'Roster unchanged until a rostering decision is recorded', engines: [27] });
  return { id, state: 'OFFERED', rosterChanged: false };
}

export function withdrawOffer(store: Store, s: Session, offerId: string) {
  if (!store.get("SELECT 1 FROM shift_offer WHERE id = ? AND offered_by = ? AND state = 'OFFERED'", offerId, s.workerId)) throw new HttpError(409, 'NOT_OPEN', 'That offer is no longer open.');
  store.tx(() => {
    transition(store, 'shift_offer', offerId, 'WITHDRAWN', { actorId: s.workerId, workContextId: null }, 'Withdrawn by the worker');
    store.run('UPDATE shift_offer SET decided_at = ? WHERE id = ?', now(), offerId);
  });
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: 'SHIFT_OFFER_WITHDRAW', objectType: 'shift_offer', objectId: offerId, outcome: 'COMMITTED' });
  return { id: offerId, state: 'WITHDRAWN' };
}

export function exchange(store: Store, s: Session) {
  seen(store, s, 'VIEW_SHIFT_EXCHANGE');
  const roles = myRoles(store, s);
  const cond = roles.length ? roles.map(() => '(p.role_key = ? AND r.service_id = ?)').join(' OR ') : '0';
  const offered = store.all(
    `SELECT o.id, r.shift_date AS date, r.start_time AS start, r.end_time AS end, sv.name AS service,
            (SELECT state FROM shift_offer_take t WHERE t.offer_id = o.id AND t.workforce_person_id = ? ORDER BY t.at DESC LIMIT 1) AS myTake
       FROM shift_offer o JOIN roster_shift r ON r.id = o.roster_shift_id JOIN position p ON p.id = r.position_id JOIN service sv ON sv.id = r.service_id
      WHERE o.offered_by <> ? AND r.shift_date >= ? AND (${cond})
        AND (o.state = 'OFFERED' OR EXISTS (SELECT 1 FROM shift_offer_take t WHERE t.offer_id = o.id AND t.workforce_person_id = ? AND t.state IN ('ACCEPTED', 'DECLINED')))
      ORDER BY r.shift_date, r.start_time`,
    s.workerId, s.workerId, todayLocal(), ...roles.flatMap((x) => [x.role_key, x.service_id]), s.workerId,
  );
  const mine = store.all(
    `SELECT o.id, o.state, r.shift_date AS date, r.start_time AS start, r.end_time AS end, sv.name AS service,
            (SELECT count(*) FROM shift_offer_take t WHERE t.offer_id = o.id AND t.state = 'INTERESTED'
               AND t.at = (SELECT max(t2.at) FROM shift_offer_take t2 WHERE t2.offer_id = o.id AND t2.workforce_person_id = t.workforce_person_id)) AS takers
       FROM shift_offer o JOIN roster_shift r ON r.id = o.roster_shift_id JOIN service sv ON sv.id = r.service_id
      WHERE o.offered_by = ? AND o.state <> 'WITHDRAWN' AND r.shift_date >= ?
      ORDER BY r.shift_date`,
    s.workerId, todayLocal(),
  );
  return { openShifts: openShifts(store, s), offered, mine };
}

export function takeOffer(store: Store, s: Session, offerId: string, take: boolean) {
  const offered = exchange(store, s).offered as { id: string; date: string }[];
  const o = offered.find((x) => x.id === offerId);
  const open = o && store.get("SELECT 1 FROM shift_offer WHERE id = ? AND state = 'OFFERED'", offerId);
  if (!o || !open) throw new HttpError(404, 'NOT_FOUND', 'That shift is no longer offered to you.');
  if (take && store.get("SELECT 1 FROM roster_shift WHERE workforce_person_id = ? AND shift_date = ? AND state = 'PLANNED'", s.workerId, o.date)) {
    throw new HttpError(409, 'ROSTER_CLASH', 'You are already rostered that day.');
  }
  const id = newId();
  store.insert('shift_offer_take', { id, offer_id: offerId, workforce_person_id: s.workerId, state: take ? 'INTERESTED' : 'WITHDRAWN', at: now() });
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: take ? 'SHIFT_TAKE_OFFER' : 'SHIFT_TAKE_WITHDRAW', objectType: 'shift_offer', objectId: offerId, outcome: 'COMMITTED', reason: 'Roster unchanged until a rostering decision is recorded', engines: [27] });
  return { state: take ? 'INTERESTED' : 'WITHDRAWN', rosterChanged: false };
}

export function payslips(store: Store, s: Session) {
  seen(store, s, 'VIEW_PAYSLIPS');
  return store.all(
    `SELECT p.id, p.period_start AS periodStart, p.period_end AS periodEnd, p.pay_date AS payDate, p.gross_cents AS gross,
            p.deductions_cents AS deductions, p.net_cents AS net, o.name AS employer, p.data_source AS dataSource
       FROM payslip p JOIN employment e ON e.id = p.employment_id JOIN organisation o ON o.id = e.organisation_id
      WHERE p.workforce_person_id = ? ORDER BY p.pay_date DESC`,
    s.workerId,
  );
}

export function payslip(store: Store, s: Session, id: string) {
  const p = store.get<Record<string, string | number>>(
    `SELECT p.*, o.name AS employer FROM payslip p JOIN employment e ON e.id = p.employment_id JOIN organisation o ON o.id = e.organisation_id
      WHERE p.id = ? AND p.workforce_person_id = ?`, id, s.workerId,
  );
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Payslip not found.');
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: 'VIEW_PAYSLIP', objectType: 'payslip', objectId: id, outcome: 'VIEWED' });
  return {
    id: p.id, employer: p.employer, periodStart: p.period_start, periodEnd: p.period_end, payDate: p.pay_date,
    lines: JSON.parse(String(p.lines_json)), gross: p.gross_cents, deductions: p.deductions_cents, net: p.net_cents, dataSource: p.data_source,
  };
}

export function leave(store: Store, s: Session) {
  seen(store, s, 'VIEW_LEAVE');
  return {
    balances: store.all('SELECT leave_type AS type, hours, as_at AS asAt FROM leave_balance WHERE workforce_person_id = ? ORDER BY leave_type', s.workerId),
    requests: store.all(
      `SELECT id, leave_type AS type, start_date AS startDate, end_date AS endDate, private_reason AS reason, state, requested_at AS requestedAt
         FROM leave_request WHERE workforce_person_id = ? ORDER BY start_date DESC`, s.workerId,
    ),
  };
}

export function requestLeave(store: Store, s: Session, b: { type?: string; startDate?: string; endDate?: string; reason?: string }) {
  const types = store.all<{ leave_type: string }>('SELECT leave_type FROM leave_balance WHERE workforce_person_id = ?', s.workerId).map((r) => r.leave_type);
  if (!b.type || !types.includes(b.type)) throw new HttpError(400, 'INVALID_TYPE', 'Choose a leave type.');
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!b.startDate || !b.endDate || !d.test(b.startDate) || !d.test(b.endDate) || b.endDate < b.startDate) throw new HttpError(400, 'INVALID_DATES', 'Choose a start date and an end date on or after it.');
  const id = newId();
  store.insert('leave_request', { id, workforce_person_id: s.workerId, leave_type: b.type, start_date: b.startDate, end_date: b.endDate, private_reason: b.reason?.trim().slice(0, 500) || null, state: 'REQUESTED', requested_at: now() });
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: 'LEAVE_REQUEST', objectType: 'leave_request', objectId: id, outcome: 'COMMITTED' });
  return { id, state: 'REQUESTED' };
}

export function cancelLeave(store: Store, s: Session, id: string) {
  if (!store.get("SELECT 1 FROM leave_request WHERE id = ? AND workforce_person_id = ? AND state = 'REQUESTED'", id, s.workerId)) throw new HttpError(409, 'NOT_CANCELLABLE', 'Only a request still awaiting a decision can be cancelled here.');
  transition(store, 'leave_request', id, 'CANCELLED', { actorId: s.workerId, workContextId: null }, 'Cancelled by the worker');
  audit(store, { actorId: s.workerId, sessionId: s.id, space: 'PERSONAL', operation: 'LEAVE_CANCEL', objectType: 'leave_request', objectId: id, outcome: 'COMMITTED' });
  return { id, state: 'CANCELLED' };
}

export function credentials(store: Store, s: Session) {
  seen(store, s, 'VIEW_CREDENTIALS');
  const today = todayLocal();
  const authority = store.all<Record<string, string | null>>(
    `SELECT profession, regulator, registration_number AS registration, scope, conditions, valid_from AS validFrom, valid_to AS validTo, status
       FROM professional_authority WHERE workforce_person_id = ? ORDER BY valid_from DESC`, s.workerId,
  ).map((a) => ({ ...a, effective: a.status === 'CURRENT' && (a.validFrom ?? '') <= today && (!a.validTo || a.validTo >= today) }));
  const other = store.all(
    `SELECT kind, title, issuer, reference, valid_from AS validFrom, valid_to AS validTo FROM credential WHERE workforce_person_id = ? ORDER BY valid_to IS NULL, valid_to`,
    s.workerId,
  );
  return { authority, other };
}

export function training(store: Store, s: Session) {
  seen(store, s, 'VIEW_TRAINING');
  return store.all(
    `SELECT course, provider, completed_at AS completedAt, expires_at AS expiresAt, state FROM training_record
      WHERE workforce_person_id = ? ORDER BY CASE state WHEN 'DUE' THEN 0 WHEN 'ENROLLED' THEN 1 ELSE 2 END, expires_at`,
    s.workerId,
  );
}
