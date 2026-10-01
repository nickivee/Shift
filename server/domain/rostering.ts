import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition } from './lifecycle.ts';
import { evaluate } from './authority.ts';
import { PERIOD_BY_ID, periodOf, currentPeriod, nextPeriod } from '../config/allocation.ts';
import { PLAN, ROLE_WORDS, ABSENCE, DAYS_AHEAD } from '../config/staffing.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Rostering decisions for one service. This is the only place a roster changes: interest in
// an open shift, a colleague's willingness to take an offered shift, availability and leave
// requests are all inputs, never changes in themselves. The rosterer sees the minimum
// operational information (name, recorded availability for that day, roster clash), never
// private notes or personal reasons.

type Row = Record<string, string | number | null>;
type ShiftRow = Row & { id: string; date: string; roleKey: string };

function decided(store: Store, ctx: WorkContext, d: { kind: string; objectId: string; outcome: string; subject?: string | null; rosterShiftId?: string | null; note?: string | null }) {
  const id = newId();
  store.insert('roster_decision', {
    id, kind: d.kind, object_id: d.objectId, outcome: d.outcome, subject_worker_id: d.subject ?? null, roster_shift_id: d.rosterShiftId ?? null,
    decided_by: ctx.workerId, work_context_id: ctx.id, note: d.note?.trim().slice(0, 500) || null, at: now(),
  });
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: `ROSTER_${d.kind}_${d.outcome}`,
    objectType: d.kind.toLowerCase(), objectId: d.objectId, decision: 'ALLOW', outcome: 'COMMITTED', ruleRefs: ['ORG-SYN-001 v1'], engines: [27],
  });
}

function candidate(store: Store, ctx: WorkContext, workerId: string, date: string) {
  const w = store.get<{ display_name: string }>('SELECT display_name FROM workforce_person WHERE id = ?', workerId);
  const avail = store.get<{ preference: string; period: string }>(
    'SELECT preference, period FROM availability WHERE workforce_person_id = ? AND available_date = ? AND withdrawn_at IS NULL ORDER BY recorded_at DESC LIMIT 1', workerId, date,
  );
  const clash = store.get("SELECT 1 FROM roster_shift WHERE workforce_person_id = ? AND shift_date = ? AND state = 'PLANNED'", workerId, date);
  return { workerId, name: w?.display_name ?? 'Unknown', availability: avail ? { preference: avail.preference, period: avail.period } : null, rosteredThatDay: Boolean(clash) };
}

function positionFor(store: Store, ctx: WorkContext, workerId: string, roleKey: string) {
  return store.get<{ id: string }>(
    `SELECT p.id FROM position p JOIN employment e ON e.id = p.employment_id
      WHERE e.workforce_person_id = ? AND p.service_id = ? AND p.role_key = ? AND (p.end_date IS NULL OR p.end_date >= ?)`,
    workerId, ctx.serviceId, roleKey, todayLocal(),
  );
}

function latest(rows: Row[], key: string) {
  const out = new Map<string, Row>();
  for (const r of rows) out.set(String(r[key]), r);
  return [...out.values()];
}

export function vacancies(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  const shifts = store.all<ShiftRow>(
    `SELECT o.id, o.shift_date AS date, o.start_time AS start, o.end_time AS end, o.role_key AS roleKey, o.state
       FROM open_shift o WHERE o.service_id = ? AND o.shift_date >= ? AND o.state = 'OPEN' ORDER BY o.shift_date, o.start_time`,
    ctx.serviceId, todayLocal(),
  );
  return shifts.map((o) => {
    const interest = latest(store.all<Row>('SELECT workforce_person_id AS w, state FROM open_shift_interest WHERE open_shift_id = ? ORDER BY at', o.id), 'w');
    return { ...o, candidates: interest.filter((i) => i.state === 'INTERESTED').map((i) => candidate(store, ctx, String(i.w), String(o.date))) };
  });
}

export function decideVacancy(store: Store, ctx: WorkContext, openShiftId: string, b: { workerId?: string; note?: string }) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  const o = store.get<Row>("SELECT * FROM open_shift WHERE id = ? AND service_id = ? AND state = 'OPEN'", openShiftId, ctx.serviceId);
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'That vacancy is no longer open.');
  const chosen = vacancies(store, ctx).find((v) => v.id === openShiftId)?.candidates.find((c) => c.workerId === b.workerId);
  if (!chosen) throw new HttpError(400, 'NOT_A_CANDIDATE', 'Choose someone who asked for this shift.');
  if (chosen.rosteredThatDay) throw new HttpError(409, 'ROSTER_CLASH', `${chosen.name} is already rostered that day.`);
  const position = positionFor(store, ctx, chosen.workerId, String(o.role_key));
  if (!position) throw new HttpError(409, 'NO_POSITION', `${chosen.name} does not hold this position in ${ctx.serviceName}.`);
  const rid = newId();
  store.tx(() => {
    store.insert('roster_shift', { id: rid, workforce_person_id: chosen.workerId, position_id: position.id, service_id: ctx.serviceId, shift_date: o.shift_date, start_time: o.start_time, end_time: o.end_time, state: 'PLANNED', data_source: 'SHIFT' });
    transition(store, 'open_shift', openShiftId, 'FILLED', { actorId: ctx.workerId, workContextId: ctx.id }, `Filled by ${chosen.name}`);
    for (const c of store.all<{ w: string }>('SELECT DISTINCT workforce_person_id AS w FROM open_shift_interest WHERE open_shift_id = ?', openShiftId)) {
      store.insert('open_shift_interest', { id: newId(), open_shift_id: openShiftId, workforce_person_id: c.w, state: c.w === chosen.workerId ? 'ACCEPTED' : 'DECLINED', at: now() });
    }
    decided(store, ctx, { kind: 'OPEN_SHIFT', objectId: openShiftId, outcome: 'ASSIGNED', subject: chosen.workerId, rosterShiftId: rid, note: b.note });
  });
  return { state: 'FILLED', assignedTo: chosen.name, rosterChanged: true };
}

export function swaps(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  const offers = store.all<ShiftRow>(
    `SELECT o.id, r.shift_date AS date, r.start_time AS start, r.end_time AS end, p.role_key AS roleKey, p.title AS position, w.display_name AS offeredBy, o.created_at AS offeredAt
       FROM shift_offer o JOIN roster_shift r ON r.id = o.roster_shift_id JOIN position p ON p.id = r.position_id
       JOIN workforce_person w ON w.id = o.offered_by
      WHERE r.service_id = ? AND o.state = 'OFFERED' AND r.shift_date >= ? ORDER BY r.shift_date, r.start_time`,
    ctx.serviceId, todayLocal(),
  );
  return offers.map((o) => {
    const takes = latest(store.all<Row>('SELECT workforce_person_id AS w, state FROM shift_offer_take WHERE offer_id = ? ORDER BY at', o.id), 'w');
    return { ...o, candidates: takes.filter((t) => t.state === 'INTERESTED').map((t) => candidate(store, ctx, String(t.w), String(o.date))) };
  });
}

export function decideSwap(store: Store, ctx: WorkContext, offerId: string, b: { workerId?: string | null; decline?: boolean; note?: string }) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  const offer = swaps(store, ctx).find((o) => o.id === offerId);
  if (!offer) throw new HttpError(404, 'NOT_FOUND', 'That offer is no longer open.');
  const takers = store.all<{ w: string }>('SELECT DISTINCT workforce_person_id AS w FROM shift_offer_take WHERE offer_id = ?', offerId);
  if (b.decline) {
    store.tx(() => {
      transition(store, 'shift_offer', offerId, 'DECLINED', { actorId: ctx.workerId, workContextId: ctx.id }, b.note || undefined);
      store.run('UPDATE shift_offer SET decided_at = ?, decided_by = ? WHERE id = ?', now(), ctx.workerId, offerId);
      for (const t of takers) store.insert('shift_offer_take', { id: newId(), offer_id: offerId, workforce_person_id: t.w, state: 'DECLINED', at: now() });
      decided(store, ctx, { kind: 'EXCHANGE', objectId: offerId, outcome: 'DECLINED', note: b.note });
    });
    return { state: 'DECLINED', rosterChanged: false };
  }
  const chosen = offer.candidates.find((c) => c.workerId === b.workerId);
  if (!chosen) throw new HttpError(400, 'NOT_A_CANDIDATE', 'Choose a colleague who offered to take this shift.');
  if (chosen.rosteredThatDay) throw new HttpError(409, 'ROSTER_CLASH', `${chosen.name} is already rostered that day.`);
  const position = positionFor(store, ctx, chosen.workerId, String(offer.roleKey));
  if (!position) throw new HttpError(409, 'NO_POSITION', `${chosen.name} does not hold this position in ${ctx.serviceName}.`);
  const original = store.get<Row>('SELECT r.* FROM roster_shift r JOIN shift_offer o ON o.roster_shift_id = r.id WHERE o.id = ?', offerId)!;
  const rid = newId();
  store.tx(() => {
    transition(store, 'roster_shift', String(original.id), 'REASSIGNED', { actorId: ctx.workerId, workContextId: ctx.id }, `Swapped to ${chosen.name}`);
    store.insert('roster_shift', { id: rid, workforce_person_id: chosen.workerId, position_id: position.id, service_id: ctx.serviceId, shift_date: original.shift_date, start_time: original.start_time, end_time: original.end_time, state: 'PLANNED', data_source: 'SHIFT' });
    transition(store, 'shift_offer', offerId, 'REASSIGNED', { actorId: ctx.workerId, workContextId: ctx.id }, `Swapped to ${chosen.name}`);
    store.run('UPDATE shift_offer SET decided_at = ?, decided_by = ? WHERE id = ?', now(), ctx.workerId, offerId);
    for (const t of takers) store.insert('shift_offer_take', { id: newId(), offer_id: offerId, workforce_person_id: t.w, state: t.w === chosen.workerId ? 'ACCEPTED' : 'DECLINED', at: now() });
    decided(store, ctx, { kind: 'EXCHANGE', objectId: offerId, outcome: 'REASSIGNED', subject: chosen.workerId, rosterShiftId: rid, note: b.note });
  });
  return { state: 'REASSIGNED', assignedTo: chosen.name, rosterChanged: true };
}

// Leave requests from people who hold a position in this service. The worker's private
// reason stays in PERSONAL and is not shown here.
export function leaveRequests(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  return store.all<Row>(
    `SELECT l.id, l.leave_type AS type, l.start_date AS startDate, l.end_date AS endDate, l.requested_at AS requestedAt, w.display_name AS name,
            (SELECT count(*) FROM roster_shift r WHERE r.workforce_person_id = l.workforce_person_id AND r.state = 'PLANNED'
               AND r.service_id = ? AND r.shift_date BETWEEN l.start_date AND l.end_date) AS rosteredShifts
       FROM leave_request l JOIN workforce_person w ON w.id = l.workforce_person_id
      WHERE l.state = 'REQUESTED' AND EXISTS (
        SELECT 1 FROM position p JOIN employment e ON e.id = p.employment_id
         WHERE e.workforce_person_id = l.workforce_person_id AND p.service_id = ? AND (p.end_date IS NULL OR p.end_date >= ?))
      ORDER BY l.start_date`,
    ctx.serviceId, ctx.serviceId, todayLocal(),
  );
}

export function decideLeave(store: Store, ctx: WorkContext, id: string, approve: boolean, note?: string) {
  if (!leaveRequests(store, ctx).some((l) => l.id === id)) throw new HttpError(404, 'NOT_FOUND', 'That leave request is no longer waiting for a decision.');
  store.tx(() => {
    transition(store, 'leave_request', id, approve ? 'APPROVED' : 'DECLINED', { actorId: ctx.workerId, workContextId: ctx.id }, note || undefined);
    const who = store.get<{ w: string }>('SELECT workforce_person_id AS w FROM leave_request WHERE id = ?', id)!.w;
    decided(store, ctx, { kind: 'LEAVE', objectId: id, outcome: approve ? 'APPROVED' : 'DECLINED', subject: who, note });
  });
  // Approving leave does not silently remove rostered shifts; the rosterer changes those.
  return { state: approve ? 'APPROVED' : 'DECLINED' };
}

// Safe staffing (entries 34–36). Each shift is set against the service's staffing plan: who is
// rostered, who has called in unable to work, and what the rosterer decided about any gap.
// SHIFT shows a gap and never blocks; the plan's numbers are the organisation's own.

type StaffRow = { rosterShiftId: string; workerId: string; name: string; start: string; end: string; state: string; roleKey: string };

function onShift(store: Store, serviceId: string, date: string, period: string) {
  return store.all<StaffRow>(
    `SELECT r.id AS rosterShiftId, r.workforce_person_id AS workerId, w.display_name AS name, r.start_time AS start, r.end_time AS "end", r.state, p.role_key AS roleKey
       FROM roster_shift r JOIN position p ON p.id = r.position_id JOIN workforce_person w ON w.id = r.workforce_person_id
      WHERE r.service_id = ? AND r.shift_date = ? AND r.state IN ('PLANNED', 'ABSENT') ORDER BY r.start_time, w.display_name`,
    serviceId, date,
  ).filter((r) => periodOf(r.start) === period);
}

function absence(store: Store, rosterShiftId: string) {
  return store.get<Row>(
    `SELECT a.kind, a.note, a.reported_at AS at, w.display_name AS reportedBy FROM staff_absence a JOIN workforce_person w ON w.id = a.reported_by
      WHERE a.roster_shift_id = ? ORDER BY a.reported_at DESC LIMIT 1`, rosterShiftId);
}

export function shiftStaffing(store: Store, serviceId: string, date: string, period: string) {
  const plan = PLAN[serviceId]?.[period];
  if (!plan) return null;
  const staff = onShift(store, serviceId, date, period);
  const roles = Object.entries(plan).map(([roleKey, planned]) => {
    const people = staff.filter((s) => s.roleKey === roleKey).map((s) => {
      const a = s.state === 'ABSENT' ? absence(store, s.rosterShiftId) : null;
      return { rosterShiftId: s.rosterShiftId, workerId: s.workerId, name: s.name, start: s.start, end: s.end,
        absent: a ? { kind: a.kind, label: ABSENCE[String(a.kind)] ?? 'Unplanned absence', note: a.note, reportedBy: a.reportedBy, at: a.at } : null };
    });
    const working = people.filter((p) => !p.absent).length;
    const gap = Math.max(0, planned - working);
    const advertised = store.all<{ start: string }>(
      "SELECT start_time AS start FROM open_shift WHERE service_id = ? AND role_key = ? AND shift_date = ? AND state = 'OPEN'", serviceId, roleKey, date,
    ).filter((o) => periodOf(o.start) === period).length;
    const short = store.get<Row>(
      `SELECT s.missing, s.plan, s.told, s.at, w.display_name AS decidedBy FROM staffing_short s JOIN workforce_person w ON w.id = s.decided_by
        WHERE s.service_id = ? AND s.shift_date = ? AND s.period = ? AND s.role_key = ? ORDER BY s.at DESC LIMIT 1`, serviceId, date, period, roleKey);
    const status = gap === 0 ? 'OK' : short && Number(short.missing) >= gap ? 'SHORT' : advertised >= gap ? 'ADVERTISED' : 'GAP';
    const [one, many] = ROLE_WORDS[roleKey] ?? [roleKey, roleKey];
    return { roleKey, one, many, planned, working, gap, advertised, status, short: status === 'SHORT' ? short : null, people };
  });
  const label = PERIOD_BY_ID.get(period)?.label ?? period;
  const status = ['GAP', 'SHORT', 'ADVERTISED'].find((x) => roles.some((r) => r.status === x)) ?? 'OK';
  const noNurse = roles.some((r) => r.roleKey.endsWith('-rn') && r.working === 0);
  return { date, period, label, roles, status, noNurse };
}

function upcoming(serviceId: string, days: number) {
  const out: { date: string; period: string }[] = [];
  let s = currentPeriod();
  const last = addDays(todayLocal(), days - 1);
  while (s.date <= last) {
    if (PLAN[serviceId]?.[s.period]) out.push(s);
    s = nextPeriod(s.date, s.period);
  }
  return out;
}

// Rostering → Staffing and vacancies: every shift for the days ahead, with gaps first in mind.
export function staffing(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  if (!PLAN[ctx.serviceId]) return { planned: false, shifts: [], gaps: 0 };
  const shifts = upcoming(ctx.serviceId, DAYS_AHEAD).map((s) => {
    const d = shiftStaffing(store, ctx.serviceId, s.date, s.period)!;
    const roles = d.roles.map((r) => ({
      ...r,
      candidates: r.status === 'GAP' || r.status === 'ADVERTISED'
        ? store.all<{ w: string }>(
          `SELECT DISTINCT e.workforce_person_id AS w FROM position p JOIN employment e ON e.id = p.employment_id
            WHERE p.service_id = ? AND p.role_key = ? AND (p.end_date IS NULL OR p.end_date >= ?)`, ctx.serviceId, r.roleKey, todayLocal(),
        ).filter((x) => !store.get("SELECT 1 FROM roster_shift WHERE workforce_person_id = ? AND shift_date = ? AND state = 'ABSENT'", x.w, s.date))
          .map((x) => candidate(store, ctx, x.w, s.date)).filter((c) => !c.rosteredThatDay && c.availability?.preference !== 'UNAVAILABLE')
          .sort((a, b) => Number(!a.availability) - Number(!b.availability))
        : [],
    }));
    return { ...d, roles };
  });
  return { planned: true, shifts, gaps: shifts.reduce((n, s) => n + s.roles.filter((r) => r.status === 'GAP').length, 0) };
}

// Allocation: this shift and the next, for the nurse in charge.
export function shiftsNow(store: Store, ctx: WorkContext) {
  if (!PLAN[ctx.serviceId]) return null;
  const now = currentPeriod();
  const next = nextPeriod(now.date, now.period);
  return {
    shifts: [now, next].map((s) => shiftStaffing(store, ctx.serviceId, s.date, s.period)),
    canReport: evaluate(store, ctx, { op: 'STAFF_ABSENCE', serviceId: ctx.serviceId }).decision === 'ALLOW',
  };
}

function gapFor(store: Store, ctx: WorkContext, date?: string, period?: string, roleKey?: string) {
  if (!date || !period || !roleKey) throw new HttpError(400, 'MISSING', 'Choose the shift and the role.');
  const d = shiftStaffing(store, ctx.serviceId, date, period);
  const r = d?.roles.find((x) => x.roleKey === roleKey);
  if (!d || !r) throw new HttpError(404, 'NOT_FOUND', 'That shift is not in this service’s staffing plan.');
  if (r.gap === 0) throw new HttpError(409, 'NO_GAP', `This shift already has the ${r.many} it is planned for.`);
  return { d, r };
}

export function reportAbsent(store: Store, ctx: WorkContext, rosterShiftId: string, b: { kind?: string; note?: string }) {
  enforce(store, ctx, { op: 'STAFF_ABSENCE', serviceId: ctx.serviceId });
  const s = store.get<Row>("SELECT r.*, w.display_name AS name FROM roster_shift r JOIN workforce_person w ON w.id = r.workforce_person_id WHERE r.id = ? AND r.service_id = ?", rosterShiftId, ctx.serviceId);
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'That shift is not on this service’s roster.');
  if (s.state !== 'PLANNED') throw new HttpError(409, 'NOT_PLANNED', `${s.name} is not rostered for that shift any more.`);
  if (String(s.shift_date) < addDays(todayLocal(), -1)) throw new HttpError(409, 'PAST', 'That shift has already been worked.');
  if (!b.kind || !ABSENCE[b.kind]) throw new HttpError(400, 'KIND', 'Choose sick or other unplanned absence.');
  const id = newId();
  store.tx(() => {
    store.insert('staff_absence', { id, roster_shift_id: rosterShiftId, workforce_person_id: s.workforce_person_id, service_id: ctx.serviceId, kind: b.kind, note: b.note?.trim().slice(0, 300) || null, reported_by: ctx.workerId, reported_at: now() });
    transition(store, 'roster_shift', rosterShiftId, 'ABSENT', { actorId: ctx.workerId, workContextId: ctx.id }, ABSENCE[b.kind!]);
    decided(store, ctx, { kind: 'ABSENCE', objectId: id, outcome: 'RECORDED', subject: String(s.workforce_person_id), rosterShiftId, note: b.note });
  });
  const d = shiftStaffing(store, ctx.serviceId, String(s.shift_date), periodOf(String(s.start_time)));
  return { state: 'ABSENT', name: s.name, gap: d?.roles.some((r) => r.status === 'GAP') ?? false };
}

export function callIn(store: Store, ctx: WorkContext, b: { date?: string; period?: string; roleKey?: string; workerId?: string; note?: string }) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  const { d, r } = gapFor(store, ctx, b.date, b.period, b.roleKey);
  const c = b.workerId ? candidate(store, ctx, b.workerId, d.date) : null;
  if (!c || c.name === 'Unknown') throw new HttpError(400, 'WHO', 'Choose who is coming in.');
  if (c.rosteredThatDay) throw new HttpError(409, 'ROSTER_CLASH', `${c.name} is already rostered that day.`);
  const position = positionFor(store, ctx, c.workerId, r.roleKey);
  if (!position) throw new HttpError(409, 'NO_POSITION', `${c.name} does not hold a ${r.one} position in ${ctx.serviceName}.`);
  const p = PERIOD_BY_ID.get(d.period)!;
  const rid = newId();
  store.tx(() => {
    store.insert('roster_shift', { id: rid, workforce_person_id: c.workerId, position_id: position.id, service_id: ctx.serviceId, shift_date: d.date, start_time: p.start, end_time: p.end, state: 'PLANNED', data_source: 'SHIFT' });
    decided(store, ctx, { kind: 'CALL_IN', objectId: rid, outcome: 'ASSIGNED', subject: c.workerId, rosterShiftId: rid, note: b.note });
  });
  return { state: 'ROSTERED', name: c.name, rosterChanged: true };
}

export function advertise(store: Store, ctx: WorkContext, b: { date?: string; period?: string; roleKey?: string }) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  const { d, r } = gapFor(store, ctx, b.date, b.period, b.roleKey);
  if (r.advertised >= r.gap) throw new HttpError(409, 'ADVERTISED', 'This gap is already advertised as a vacancy.');
  const p = PERIOD_BY_ID.get(d.period)!;
  const id = newId();
  store.tx(() => {
    store.insert('open_shift', { id, service_id: ctx.serviceId, role_key: r.roleKey, shift_date: d.date, start_time: p.start, end_time: p.end, state: 'OPEN', created_at: now(), data_source: 'SHIFT' });
    decided(store, ctx, { kind: 'ADVERTISE', objectId: id, outcome: 'OPENED' });
  });
  return { state: 'OPEN' };
}

export function runShort(store: Store, ctx: WorkContext, b: { date?: string; period?: string; roleKey?: string; plan?: string; told?: string }) {
  enforce(store, ctx, { op: 'ROSTER_DECIDE', serviceId: ctx.serviceId });
  const { d, r } = gapFor(store, ctx, b.date, b.period, b.roleKey);
  const plan = b.plan?.trim() ?? '';
  const told = b.told?.trim() ?? '';
  if (plan.length < 10) throw new HttpError(400, 'PLAN', 'Say how the shift will be covered while it runs short.');
  if (!told) throw new HttpError(400, 'TOLD', 'Say who you told that this shift will run short.');
  const id = newId();
  store.tx(() => {
    store.insert('staffing_short', { id, service_id: ctx.serviceId, shift_date: d.date, period: d.period, role_key: r.roleKey, missing: r.gap, plan: plan.slice(0, 600), told: told.slice(0, 200), decided_by: ctx.workerId, at: now() });
    decided(store, ctx, { kind: 'SHORT', objectId: id, outcome: 'ACCEPTED', note: plan });
  });
  return { state: 'SHORT' };
}
