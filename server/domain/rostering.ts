import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

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
    store.run("UPDATE open_shift SET state = 'FILLED' WHERE id = ?", openShiftId);
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
      store.run("UPDATE shift_offer SET state = 'DECLINED', decided_at = ?, decided_by = ? WHERE id = ?", now(), ctx.workerId, offerId);
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
    store.run("UPDATE roster_shift SET state = 'REASSIGNED' WHERE id = ?", original.id);
    store.insert('roster_shift', { id: rid, workforce_person_id: chosen.workerId, position_id: position.id, service_id: ctx.serviceId, shift_date: original.shift_date, start_time: original.start_time, end_time: original.end_time, state: 'PLANNED', data_source: 'SHIFT' });
    store.run("UPDATE shift_offer SET state = 'REASSIGNED', decided_at = ?, decided_by = ? WHERE id = ?", now(), ctx.workerId, offerId);
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
    store.run('UPDATE leave_request SET state = ? WHERE id = ?', approve ? 'APPROVED' : 'DECLINED', id);
    const who = store.get<{ w: string }>('SELECT workforce_person_id AS w FROM leave_request WHERE id = ?', id)!.w;
    decided(store, ctx, { kind: 'LEAVE', objectId: id, outcome: approve ? 'APPROVED' : 'DECLINED', subject: who, note });
  });
  // Approving leave does not silently remove rostered shifts; the rosterer changes those.
  return { state: approve ? 'APPROVED' : 'DECLINED' };
}
