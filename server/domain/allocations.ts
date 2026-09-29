import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, transitionAll, recordInitial, history, type TransitionActor } from './lifecycle.ts';
import { activeRaised } from './alerts.ts';
import { current as helpNeeded } from './functional.ts';
import { current as differentNow } from './usual.ts';
import { current as statusNow } from './acuity.ts';
import { PERIODS, PERIOD_BY_ID, STAFF_ROLES, periodOf, currentPeriod, nextPeriod } from '../config/allocation.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Patient allocation (Shared Lifecycle Object 266):
//   patient requires care → staffing/team context → proposed allocation → senior/authorised
//   review → confirmed allocation → active assignment → change/reallocation → handover/end.
// A nurse drafts the allocation for a shift from the patients in the service and the staff on
// the roster, sees each patient's needs and each person's load, and submits it. A different
// nurse reviews it and confirms it or sends it back. It becomes active when the shift starts,
// ending the one before; patients can be moved during the shift with a reason; and it ends at
// handover. Only staff whose practising authority is current can take patients. Allocation is
// context for the worker; it never grants access on its own.

type Row = Record<string, string | number | null>;
type Cap = 'allocation.plan' | 'allocation.confirm';
interface Staff { id: string; onRoster: boolean; reason: string | null }
const STATES: Record<string, string> = { DRAFT: 'Draft', SUBMITTED: 'Waiting for review', CONFIRMED: 'Confirmed', ACTIVE: 'In use now', ENDED: 'Ended', CANCELLED: 'Cancelled' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-007'];

const PLAN = `
  SELECT pl.id, pl.service_id AS serviceId, s.name AS service, pl.shift_date AS shiftDate, pl.period, pl.state, pl.staff_json AS staffJson,
         db.display_name AS draftedBy, pl.drafted_by AS draftedById, pl.drafted_at AS draftedAt,
         sb.display_name AS submittedBy, pl.submitted_by AS submittedById, pl.submitted_at AS submittedAt,
         rb.display_name AS reviewedBy, pl.reviewed_at AS reviewedAt, pl.review_note AS reviewNote,
         tb.display_name AS startedBy, pl.started_at AS startedAt, eb.display_name AS endedBy, pl.ended_at AS endedAt, pl.end_note AS endNote
    FROM allocation_plan pl
    JOIN service s ON s.id = pl.service_id
    JOIN workforce_person db ON db.id = pl.drafted_by
    LEFT JOIN workforce_person sb ON sb.id = pl.submitted_by
    LEFT JOIN workforce_person rb ON rb.id = pl.reviewed_by
    LEFT JOIN workforce_person tb ON tb.id = pl.started_by
    LEFT JOIN workforce_person eb ON eb.id = pl.ended_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const can = (store: Store, ctx: WorkContext, serviceId: string, cap: Cap) => evaluate(store, ctx, { op: 'ALLOCATION', serviceId, cap }).decision === 'ALLOW';
const DAY = new Intl.DateTimeFormat('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
const label = (r: { shiftDate?: unknown; period?: unknown }) =>
  `${PERIOD_BY_ID.get(String(r.period))?.label ?? r.period} shift, ${DAY.format(new Date(`${String(r.shiftDate)}T12:00:00`)).replace(',', '')}`;
const staffOf = (r: Row): Staff[] => (r.staffJson ? JSON.parse(String(r.staffJson)) : []);

function logged(store: Store, ctx: WorkContext, operation: string, id: string, reason?: string, personId?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'allocation_plan', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${PLAN} WHERE pl.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That allocation is no longer in SHIFT.');
  return r;
};

// Staff who can take patients in a service: a current position there in a role that takes
// patients, and current practising authority where the role needs it.
function eligible(store: Store, serviceId: string) {
  const roles = STAFF_ROLES[serviceId]?.roles ?? [];
  if (!roles.length) return [];
  const today = todayLocal();
  const rows = store.all<{ id: string; name: string; roleKey: string; title: string }>(
    `SELECT w.id, w.display_name AS name, pos.role_key AS roleKey, pos.title FROM position pos JOIN employment em ON em.id = pos.employment_id
       JOIN workforce_person w ON w.id = em.workforce_person_id
      WHERE pos.service_id = ? AND pos.role_key IN (${roles.map(() => '?').join(',')}) AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE'
      ORDER BY w.display_name`, serviceId, ...roles, today, today);
  const out = new Map<string, { id: string; name: string; roleKey: string; roleLabel: string; title: string; authorityOk: boolean }>();
  for (const r of rows) {
    if (out.has(r.id)) continue;
    const profession = ROLE_BY_KEY.get(r.roleKey)?.profession;
    let ok = true;
    if (profession) {
      const a = store.get<{ status: string; valid_from: string; valid_to: string | null }>(
        'SELECT status, valid_from, valid_to FROM professional_authority WHERE workforce_person_id = ? AND profession = ? ORDER BY valid_from DESC LIMIT 1', r.id, profession);
      ok = !!a && a.status === 'CURRENT' && a.valid_from <= today && (a.valid_to === null || a.valid_to >= today);
    }
    out.set(r.id, { ...r, roleLabel: ROLE_BY_KEY.get(r.roleKey)?.label ?? r.roleKey, authorityOk: ok });
  }
  return [...out.values()];
}

// Who is on the roster for that service, date and shift.
function rostered(store: Store, serviceId: string, date: string, period: string) {
  return store.all<{ id: string; start: string; end: string }>(
    "SELECT workforce_person_id AS id, start_time AS start, end_time AS \"end\" FROM roster_shift WHERE service_id = ? AND shift_date = ? AND state = 'PLANNED'", serviceId, date,
  ).filter((r) => periodOf(r.start) === period);
}

const patients = (store: Store, serviceId: string) => store.all<{ id: string; name: string; location: string | null }>(
  `SELECT p.id, p.given_name || ' ' || p.family_name AS name, e.location FROM encounter e JOIN person p ON p.id = e.person_id
    WHERE e.service_id = ? AND e.state = 'ACTIVE' ORDER BY e.location, p.family_name`, serviceId);

const lines = (store: Store, planId: string, state?: string) => store.all<{ id: string; personId: string; workerId: string; state: string; reallocatedFrom: string | null; endReason: string | null }>(
  `SELECT id, person_id AS personId, workforce_person_id AS workerId, state, reallocated_from AS reallocatedFrom, end_reason AS endReason FROM allocation
    WHERE plan_id = ? ${state ? 'AND state = ?' : "AND state != 'ENDED'"}`, ...(state ? [planId, state] : [planId]));

function detail(store: Store, ctx: WorkContext, r: Row) {
  const serviceId = String(r.serviceId);
  const pool = eligible(store, serviceId);
  const staff = staffOf(r);
  const live = lines(store, String(r.id));
  const warnAbove = STAFF_ROLES[serviceId]?.warnAbove ?? {};
  const people = patients(store, serviceId).map((p) => {
    const help = helpNeeded(store, p.id);
    const diff = differentNow(store, p.id);
    return {
      ...p, staffIds: live.filter((l) => l.personId === p.id).map((l) => l.workerId),
      status: statusNow(store, p.id),
      needs: [...activeRaised(store, p.id).map((a) => a.title), ...(help ? [`Help: ${help.help.slice(0, 2).join('; ')}`] : []), ...(diff ? [`Different from usual: ${diff[0]}`] : [])],
    };
  });
  const staffRows = staff.map((s) => {
    const e = pool.find((p) => p.id === s.id);
    const count = live.filter((l) => l.workerId === s.id && people.some((p) => p.id === l.personId)).length;
    const limit = e ? warnAbove[e.roleKey] : undefined;
    return {
      id: s.id, name: e?.name ?? 'Unknown', roleLabel: e?.roleLabel ?? '', onRoster: s.onRoster, reason: s.reason, count,
      warn: limit !== undefined && count > limit ? `More than ${limit} patients` : null, authorityOk: e?.authorityOk ?? false,
    };
  });
  const canPlan = can(store, ctx, serviceId, 'allocation.plan');
  const canConfirm = can(store, ctx, serviceId, 'allocation.confirm');
  const state = String(r.state);
  const hist = history(store, 'allocplan', String(r.id));
  const actions: string[] = [];
  if (canPlan && state === 'DRAFT') actions.push('submit', 'cancel');
  if (canConfirm && state === 'SUBMITTED' && r.submittedById !== ctx.workerId) actions.push('confirm', 'return');
  if (canPlan && state === 'CONFIRMED') actions.push('start', 'cancel');
  if (canPlan && state === 'ACTIVE') actions.push('end');
  const { staffJson: _s, ...rest } = r;
  return {
    ...rest, id: String(r.id), state, stateLabel: STATES[state], label: label(r), staff: staffRows, patients: people,
    unallocated: people.filter((p) => !p.staffIds.length).map((p) => p.name),
    moves: store.all<Row>(`SELECT a.id, p.given_name || ' ' || p.family_name AS patient, w.display_name AS worker, f.display_name AS fromWorker, a.created_at AS at, a.move_reason AS reason
      FROM allocation a JOIN person p ON p.id = a.person_id JOIN workforce_person w ON w.id = a.workforce_person_id
      LEFT JOIN allocation o ON o.id = a.reallocated_from LEFT JOIN workforce_person f ON f.id = o.workforce_person_id
      WHERE a.plan_id = ? AND a.reallocated_from IS NOT NULL ORDER BY a.created_at`, String(r.id)),
    editable: canPlan && (state === 'DRAFT'), movable: canPlan && state === 'ACTIVE',
    addable: pool.filter((p) => !staff.some((s) => s.id === p.id)).map((p) => ({ id: p.id, name: p.name, roleLabel: p.roleLabel, authorityOk: p.authorityOk })),
    actions, history: hist,
    submitNote: [...hist].reverse().find((x) => x.to_state === 'SUBMITTED' && x.reason !== 'Submitted for review')?.reason ?? null,
  };
}

// Home → Allocation: the one in use now, those being prepared, and those waiting for my review.
export function overview(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('allocation.plan')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include allocating patients`);
  const active = store.get<Row>(`${PLAN} WHERE pl.service_id = ? AND pl.state = 'ACTIVE'`, ctx.serviceId);
  const upcoming = store.all<Row>(`${PLAN} WHERE pl.service_id = ? AND pl.state IN ('DRAFT', 'SUBMITTED', 'CONFIRMED') ORDER BY pl.shift_date, pl.period`, ctx.serviceId)
    .map((r) => detail(store, ctx, r));
  const now = currentPeriod();
  const suggest = active ? nextPeriod(String(active.shiftDate), String(active.period)) : now;
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_ALLOCATION', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    active: active ? detail(store, ctx, active) : null, upcoming, toReview: upcoming.filter((p) => p.actions.includes('confirm')),
    periods: PERIODS, suggest, canPlan: can(store, ctx, ctx.serviceId, 'allocation.plan'),
  };
}

export function get(store: Store, ctx: WorkContext, id: string) {
  const r = load(store, id);
  enforce(store, ctx, { op: 'ALLOCATION', serviceId: String(r.serviceId), cap: 'allocation.plan' });
  return detail(store, ctx, r);
}

// A new draft for a shift: staff from the roster, and where the same people are working, the
// patients they have now as a starting point.
export function create(store: Store, ctx: WorkContext, b: { date?: string; period?: string }) {
  enforce(store, ctx, { op: 'ALLOCATION', serviceId: ctx.serviceId, cap: 'allocation.plan' });
  const period = PERIOD_BY_ID.get(String(b.period));
  if (!period) throw new HttpError(400, 'PERIOD_REQUIRED', 'Choose the shift.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : '';
  if (!date) throw new HttpError(400, 'DATE_REQUIRED', 'Choose the date.');
  if (store.get("SELECT 1 FROM allocation_plan WHERE service_id = ? AND shift_date = ? AND period = ? AND state NOT IN ('CANCELLED', 'ENDED')", ctx.serviceId, date, period.id)) {
    throw new HttpError(409, 'ALREADY_PLANNED', `There is already an allocation for the ${period.label.toLowerCase()} shift on that date.`);
  }
  const pool = eligible(store, ctx.serviceId);
  const onRoster = rostered(store, ctx.serviceId, date, period.id).map((r) => r.id).filter((id) => pool.some((p) => p.id === id && p.authorityOk));
  const staff: Staff[] = [...new Set(onRoster)].map((id) => ({ id, onRoster: true, reason: null }));
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('allocation_plan', {
      id, service_id: ctx.serviceId, shift_date: date, period: period.id, state: 'DRAFT', staff_json: JSON.stringify(staff), drafted_by: ctx.workerId, drafted_at: now(),
    });
    recordInitial(store, 'allocplan', id, 'DRAFT', who, `${period.label} shift, ${date}`);
    const active = store.get<{ id: string }>("SELECT id FROM allocation_plan WHERE service_id = ? AND state = 'ACTIVE'", ctx.serviceId);
    if (active) {
      for (const l of lines(store, active.id, 'ACTIVE')) {
        if (!staff.some((s) => s.id === l.workerId)) continue;
        store.insert('allocation', { id: newId(), workforce_person_id: l.workerId, person_id: l.personId, service_id: ctx.serviceId, shift_date: date, created_at: now(), created_by: ctx.workerId, plan_id: id, state: 'PROPOSED' });
      }
    }
    logged(store, ctx, 'ALLOCATION_DRAFT', id, `${period.label} shift, ${date}`);
  });
  return detail(store, ctx, load(store, id));
}

function endLines(store: Store, planId: string, reason: string, who: TransitionActor) {
  for (const id of transitionAll(store, 'allocation', 'plan_id = ?', [planId], 'ENDED', who, reason)) store.run('UPDATE allocation SET ended_at = ?, end_reason = ? WHERE id = ?', now(), reason, id);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { workerId?: string; personId?: string; toId?: string; reason?: string; note?: string }) {
  const r = load(store, id);
  const serviceId = String(r.serviceId);
  const state = String(r.state);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const staff = staffOf(r);
  const note = text(b.note || b.reason, 500);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This allocation is ${STATES[state].toLowerCase()}.`); };
  const plan = () => enforce(store, ctx, { op: 'ALLOCATION', serviceId, cap: 'allocation.plan' });
  const pool = () => eligible(store, serviceId);
  const inPlan = (personId: string) => patients(store, serviceId).find((p) => p.id === personId);
  switch (action) {
    case 'staff-add': {
      plan(); inState('DRAFT', 'ACTIVE');
      const e = pool().find((p) => p.id === b.workerId);
      if (!e) throw new HttpError(400, 'NOT_ELIGIBLE', 'Choose someone who works in this service in a role that takes patients.');
      if (!e.authorityOk) throw new HttpError(409, 'AUTHORITY', `${e.name}'s practising certificate is not current. They cannot take patients.`);
      if (staff.some((s) => s.id === e.id)) throw new HttpError(409, 'ALREADY', `${e.name} is already on this allocation.`);
      const onRoster = rostered(store, serviceId, String(r.shiftDate), String(r.period)).some((x) => x.id === e.id);
      const reason = text(b.reason, 200);
      if (!onRoster && reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', `${e.name} is not on the roster for this shift. Write why they are working, e.g. "Called in for sick leave".`);
      store.tx(() => {
        store.run('UPDATE allocation_plan SET staff_json = ? WHERE id = ?', JSON.stringify([...staff, { id: e.id, onRoster, reason: onRoster ? null : reason }]), id);
        logged(store, ctx, 'ALLOCATION_STAFF_ADD', id, `${e.name}${onRoster ? '' : ` (not rostered: ${reason})`}`);
      });
      break;
    }
    case 'staff-remove': {
      plan(); inState('DRAFT');
      if (!staff.some((s) => s.id === b.workerId)) throw new HttpError(404, 'NOT_FOUND', 'They are not on this allocation.');
      store.tx(() => {
        store.run('UPDATE allocation_plan SET staff_json = ? WHERE id = ?', JSON.stringify(staff.filter((s) => s.id !== b.workerId)), id);
        store.run("DELETE FROM allocation WHERE plan_id = ? AND workforce_person_id = ? AND state = 'PROPOSED'", id, String(b.workerId));
        logged(store, ctx, 'ALLOCATION_STAFF_REMOVE', id);
      });
      break;
    }
    case 'toggle': {
      plan(); inState('DRAFT');
      const p = inPlan(String(b.personId));
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'That patient is no longer in this service.');
      if (!staff.some((s) => s.id === b.workerId)) throw new HttpError(400, 'NOT_ON_PLAN', 'Add them to the allocation first.');
      const existing = store.get<{ id: string }>("SELECT id FROM allocation WHERE plan_id = ? AND person_id = ? AND workforce_person_id = ? AND state = 'PROPOSED'", id, p.id, String(b.workerId));
      store.tx(() => {
        if (existing) store.run('DELETE FROM allocation WHERE id = ?', existing.id);
        else store.insert('allocation', { id: newId(), workforce_person_id: String(b.workerId), person_id: p.id, service_id: serviceId, shift_date: String(r.shiftDate), created_at: now(), created_by: ctx.workerId, plan_id: id, state: 'PROPOSED' });
      });
      break;
    }
    case 'submit': {
      plan(); inState('DRAFT');
      const d = detail(store, ctx, r);
      if (!d.staff.length) throw new HttpError(400, 'NO_STAFF', 'Add the staff working this shift.');
      if (d.unallocated.length) throw new HttpError(400, 'UNALLOCATED', `Everyone needs someone allocated. Not yet allocated: ${d.unallocated.join(', ')}.`);
      store.tx(() => {
        transition(store, 'allocplan', id, 'SUBMITTED', who, note || 'Submitted for review');
        store.run('UPDATE allocation_plan SET submitted_by = ?, submitted_at = ?, review_note = NULL WHERE id = ?', ctx.workerId, now(), id);
        logged(store, ctx, 'ALLOCATION_SUBMIT', id, d.label);
      });
      break;
    }
    case 'confirm':
    case 'return': {
      enforce(store, ctx, { op: 'ALLOCATION', serviceId, cap: 'allocation.confirm' });
      inState('SUBMITTED');
      if (r.submittedById === ctx.workerId) throw new HttpError(403, 'SAME_PERSON', 'Someone other than the person who submitted it must review it.');
      if (action === 'return' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what needs changing.');
      store.tx(() => {
        transition(store, 'allocplan', id, action === 'confirm' ? 'CONFIRMED' : 'DRAFT', who, note || 'Reviewed and confirmed');
        store.run('UPDATE allocation_plan SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?', ctx.workerId, now(), note || null, id);
        logged(store, ctx, action === 'confirm' ? 'ALLOCATION_CONFIRM' : 'ALLOCATION_RETURN', id, note);
      });
      break;
    }
    case 'start': {
      plan(); inState('CONFIRMED');
      const prior = store.get<Row>(`${PLAN} WHERE pl.service_id = ? AND pl.state = 'ACTIVE'`, serviceId);
      store.tx(() => {
        if (prior) {
          transition(store, 'allocplan', String(prior.id), 'ENDED', who, `Handed over to the ${label(r).toLowerCase()}`);
          store.run('UPDATE allocation_plan SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), `Handed over to the ${label(r).toLowerCase()}`, String(prior.id));
          endLines(store, String(prior.id), 'Shift handed over', who);
        }
        for (const a of transitionAll(store, 'allocation', "service_id = ? AND state = 'LEGACY'", [serviceId], 'ENDED', who, 'Replaced by allocation plans')) {
          store.run("UPDATE allocation SET ended_at = ?, end_reason = 'Replaced by allocation plans' WHERE id = ?", now(), a);
        }
        transition(store, 'allocplan', id, 'ACTIVE', who, 'Shift started');
        store.run('UPDATE allocation_plan SET started_by = ?, started_at = ? WHERE id = ?', ctx.workerId, now(), id);
        transitionAll(store, 'allocation', 'plan_id = ?', [id], 'ACTIVE', who, 'Shift started');
        logged(store, ctx, 'ALLOCATION_START', id, label(r));
      });
      break;
    }
    case 'move': {
      plan(); inState('ACTIVE');
      const p = inPlan(String(b.personId));
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'That patient is no longer in this service.');
      const from = store.get<{ id: string; workerId: string }>("SELECT id, workforce_person_id AS workerId FROM allocation WHERE plan_id = ? AND person_id = ? AND workforce_person_id = ? AND state = 'ACTIVE'", id, p.id, String(b.workerId ?? ''));
      const to = String(b.toId ?? '');
      if (!staff.some((s) => s.id === to)) throw new HttpError(400, 'NOT_ON_PLAN', 'Choose someone on this shift.');
      if (from && from.workerId === to) throw new HttpError(400, 'SAME_PERSON', 'They already have this patient.');
      if (store.get("SELECT 1 FROM allocation WHERE plan_id = ? AND person_id = ? AND workforce_person_id = ? AND state = 'ACTIVE'", id, p.id, to)) throw new HttpError(409, 'ALREADY', 'They already have this patient.');
      if (note.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why, e.g. "New admission to Bed 9" or "Nicki went home unwell".');
      store.tx(() => {
        if (from) {
          transition(store, 'allocation', from.id, 'ENDED', who, `Moved: ${note}`);
          store.run('UPDATE allocation SET ended_at = ?, end_reason = ? WHERE id = ?', now(), `Moved: ${note}`, from.id);
        }
        store.insert('allocation', {
          id: newId(), workforce_person_id: to, person_id: p.id, service_id: serviceId, shift_date: String(r.shiftDate), created_at: now(), created_by: ctx.workerId,
          plan_id: id, state: 'ACTIVE', reallocated_from: from?.id ?? null, move_reason: note,
        });
        logged(store, ctx, 'ALLOCATION_MOVE', id, note, p.id);
      });
      break;
    }
    case 'end': {
      plan(); inState('ACTIVE');
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write a note for the handover, e.g. "Handed over at 15:30".');
      store.tx(() => {
        transition(store, 'allocplan', id, 'ENDED', who, note);
        store.run('UPDATE allocation_plan SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
        endLines(store, id, 'Shift ended', who);
        logged(store, ctx, 'ALLOCATION_END', id, note);
      });
      break;
    }
    case 'cancel': {
      plan(); inState('DRAFT', 'CONFIRMED');
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is being cancelled.');
      store.tx(() => {
        transition(store, 'allocplan', id, 'CANCELLED', who, note);
        store.run("DELETE FROM allocation WHERE plan_id = ? AND state = 'PROPOSED'", id);
        logged(store, ctx, 'ALLOCATION_CANCEL', id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return detail(store, ctx, load(store, id));
}
