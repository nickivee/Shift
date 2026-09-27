import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ASSIGNMENT_KINDS, KIND_BY_ID, type AssignmentKind } from '../config/assignments.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Named clinician / team assignment (Shared Lifecycle Object 265):
//   assignment required → proposed → confirmed → active → changed/covered → ended.
// Who is named for a person (responsible senior doctor, named nurse, key worker, physio, GP or
// team) is proposed, then confirmed by the person named or by a senior clinician. It becomes
// active when it starts. Someone can cover for a set time, or it can be handed over to someone
// else, and it ends with a reason, including when the stay ends. The person named can accept or
// decline; arranging cover and ending it are for a senior clinician. A SHIFT worker can only be
// named for a kind their role allows, and only while their practising authority is current.

type Row = Record<string, string | number | null>;
type Who = { actorId: string | null; workContextId: string | null };
const STATES: Record<string, string> = { PROPOSED: 'Proposed', CONFIRMED: 'Confirmed', ACTIVE: 'Active', ENDED: 'Ended', DECLINED: 'Declined' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-007'];

const ASSIGNMENT = `
  SELECT a.id, a.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = a.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         a.service_id AS serviceId, s.name AS service, a.kind, a.assignee_id AS assigneeId, w.display_name AS assignee,
         a.external_name AS externalName, a.external_org AS externalOrg, a.team_name AS teamName, a.state,
         pb.display_name AS proposedBy, a.proposed_by AS proposedById, a.proposed_at AS proposedAt, a.reason, a.starts_at AS startsAt, a.ends_at AS endsAt,
         cb.display_name AS confirmedBy, a.confirmed_at AS confirmedAt, a.confirm_note AS confirmNote, a.activated_at AS activatedAt,
         eb.display_name AS endedBy, a.ended_at AS endedAt, a.end_reason AS endReason, a.replaces, a.cover_for AS coverFor,
         db.display_name AS declinedBy, a.declined_at AS declinedAt, a.decline_reason AS declineReason
    FROM assignment a
    JOIN person p ON p.id = a.person_id
    JOIN service s ON s.id = a.service_id
    JOIN workforce_person pb ON pb.id = a.proposed_by
    LEFT JOIN workforce_person w ON w.id = a.assignee_id
    LEFT JOIN workforce_person cb ON cb.id = a.confirmed_by
    LEFT JOIN workforce_person eb ON eb.id = a.ended_by
    LEFT JOIN workforce_person db ON db.id = a.declined_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const kindOf = (id: unknown): AssignmentKind => {
  const k = KIND_BY_ID.get(String(id));
  if (!k) throw new HttpError(400, 'KIND_REQUIRED', 'Choose who is being named, e.g. named nurse.');
  return k;
};
const may = (store: Store, ctx: WorkContext, personId: string, cap: 'assignment.propose' | 'assignment.confirm') =>
  evaluate(store, ctx, { op: 'ASSIGNMENT', personId, cap }).decision === 'ALLOW';
const nameOf = (r: Row) => String(r.assignee ?? (r.externalName ? `${r.externalName}${r.externalOrg ? `, ${r.externalOrg}` : ''}` : r.teamName ?? ''));

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'assignment', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

// SHIFT workers who can be named for a kind: a current position in a role the kind allows, and
// current practising authority where the role needs one.
function eligible(store: Store, kind: AssignmentKind) {
  if (kind.named !== 'WORKER') return [];
  const today = todayLocal();
  const rows = store.all<{ id: string; name: string; title: string; roleKey: string; service: string }>(
    `SELECT w.id, w.display_name AS name, pos.title, pos.role_key AS roleKey, s.name AS service
       FROM position pos JOIN employment em ON em.id = pos.employment_id JOIN workforce_person w ON w.id = em.workforce_person_id JOIN service s ON s.id = pos.service_id
      WHERE pos.role_key IN (${kind.roles.map(() => '?').join(',')}) AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE'
      ORDER BY w.display_name`, ...kind.roles, today, today);
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    const profession = ROLE_BY_KEY.get(r.roleKey)?.profession;
    if (profession) {
      const a = store.get<{ status: string; valid_from: string; valid_to: string | null }>(
        'SELECT status, valid_from, valid_to FROM professional_authority WHERE workforce_person_id = ? AND profession = ? ORDER BY valid_from DESC LIMIT 1', r.id, profession);
      if (!a || a.status !== 'CURRENT' || a.valid_from > today || (a.valid_to !== null && a.valid_to < today)) return false;
    }
    seen.add(r.id);
    return true;
  }).map((r) => ({ id: r.id, name: r.name, title: `${r.title}, ${r.service}` }));
}

// Confirmed ones start when their time comes, and covers end when theirs does. Both are applied
// whenever assignments are read, with the time they were due recorded as the reason.
function settle(store: Store, personIds: string[]) {
  if (!personIds.length) return;
  const at = now();
  const marks = personIds.map(() => '?').join(',');
  const system: Who = { actorId: null, workContextId: null };
  const due = store.all<Row>(`SELECT id, person_id AS personId, kind, cover_for AS coverFor, replaces, starts_at AS startsAt FROM assignment WHERE person_id IN (${marks}) AND state = 'CONFIRMED' AND starts_at <= ?`, ...personIds, at);
  const ending = store.all<Row>(`SELECT id, ends_at AS endsAt FROM assignment WHERE person_id IN (${marks}) AND state IN ('ACTIVE', 'CONFIRMED') AND ends_at IS NOT NULL AND ends_at <= ?`, ...personIds, at);
  if (!due.length && !ending.length) return;
  store.tx(() => {
    for (const r of due) activate(store, r, system, `Start time reached (${String(r.startsAt).slice(0, 16).replace('T', ' ')})`);
    for (const r of ending) end(store, String(r.id), system, 'Cover period finished');
  });
}

function end(store: Store, id: string, who: Who, reason: string) {
  const r = store.get<{ state: string }>('SELECT state FROM assignment WHERE id = ?', id);
  if (!r || !['ACTIVE', 'CONFIRMED'].includes(r.state)) return;
  transition(store, 'assignment', id, 'ENDED', who, reason);
  store.run('UPDATE assignment SET ended_by = ?, ended_at = ?, end_reason = ? WHERE id = ?', who.actorId, now(), reason, id);
  // Covers for it end with it.
  for (const c of store.all<{ id: string }>("SELECT id FROM assignment WHERE cover_for = ? AND state IN ('ACTIVE', 'CONFIRMED')", id)) end(store, c.id, who, 'The assignment it covered ended');
}

function activate(store: Store, r: Row, who: Who, reason: string) {
  transition(store, 'assignment', String(r.id), 'ACTIVE', who, reason);
  store.run('UPDATE assignment SET activated_at = ? WHERE id = ?', now(), String(r.id));
  if (r.replaces) end(store, String(r.replaces), who, 'Handed over');
}

// When a stay ends, everything named for it in that service ends too.
export function endForService(store: Store, personId: string, serviceId: string, reason: string, who: Who) {
  for (const r of store.all<{ id: string }>("SELECT id FROM assignment WHERE person_id = ? AND service_id = ? AND state IN ('ACTIVE', 'CONFIRMED') AND cover_for IS NULL", personId, serviceId)) {
    end(store, r.id, who, reason);
  }
  for (const r of store.all<{ id: string }>("SELECT id FROM assignment WHERE person_id = ? AND service_id = ? AND state = 'PROPOSED'", personId, serviceId)) {
    transition(store, 'assignment', r.id, 'DECLINED', who, reason);
    store.run('UPDATE assignment SET declined_by = ?, declined_at = ?, decline_reason = ? WHERE id = ?', who.actorId, now(), reason, r.id);
  }
}

function shape(store: Store, ctx: WorkContext, r: Row, canPropose: boolean, canConfirm: boolean) {
  const k = KIND_BY_ID.get(String(r.kind));
  const mine = r.assigneeId === ctx.workerId;
  const actions: string[] = [];
  if (r.state === 'PROPOSED') {
    if (mine || canConfirm) actions.push('confirm');
    if (mine || canConfirm || r.proposedById === ctx.workerId) actions.push('decline');
  }
  if (r.state === 'ACTIVE' && !r.coverFor) {
    if (canPropose) actions.push('handover');
    if (canConfirm) actions.push('cover');
  }
  if (['ACTIVE', 'CONFIRMED'].includes(String(r.state)) && canConfirm) actions.push('end');
  return {
    ...r, id: String(r.id), coverFor: r.coverFor ? String(r.coverFor) : null, state: String(r.state), kind: String(r.kind), label: k?.label ?? String(r.kind), name: nameOf(r), stateLabel: STATES[String(r.state)], mine,
    actions, history: history(store, 'assignment', String(r.id)),
  };
}

const encounterKinds = (store: Store, personId: string) =>
  store.all<{ kind: string; serviceId: string }>("SELECT kind, service_id AS serviceId FROM encounter WHERE person_id = ? AND state = 'ACTIVE'", personId);

function gaps(store: Store, personId: string, serviceId?: string) {
  const encounters = encounterKinds(store, personId).filter((e) => !serviceId || e.serviceId === serviceId);
  return ASSIGNMENT_KINDS.filter((k) => encounters.some((e) => k.requiredFor.includes(e.kind)) &&
    !store.get("SELECT 1 FROM assignment WHERE person_id = ? AND kind = ? AND state = 'ACTIVE' AND cover_for IS NULL", personId, k.id)).map((k) => k.label);
}

export function propose(store: Store, ctx: WorkContext, personId: string,
  b: { kind?: string; assigneeId?: string; externalName?: string; externalOrg?: string; teamName?: string; reason?: string; startsAt?: string; replaces?: string }) {
  enforce(store, ctx, { op: 'ASSIGNMENT', personId, cap: 'assignment.propose' }, personId);
  settle(store, [personId]);
  const k = kindOf(b.kind);
  let assigneeId: string | null = null;
  let externalName: string | null = null;
  let externalOrg: string | null = null;
  let teamName: string | null = null;
  if (k.named === 'WORKER') {
    const person = eligible(store, k).find((e) => e.id === b.assigneeId);
    if (!person) throw new HttpError(400, 'NOT_ELIGIBLE', `Choose someone who can be the ${k.label.toLowerCase()}: the right role and a current practising certificate.`);
    assigneeId = person.id;
  } else if (k.named === 'EXTERNAL') {
    externalName = text(b.externalName, 120);
    externalOrg = text(b.externalOrg, 120) || null;
    if (externalName.length < 3) throw new HttpError(400, 'NAME_REQUIRED', 'Write their name, e.g. "Dr Anna Whyte".');
    if (!externalOrg) throw new HttpError(400, 'ORG_REQUIRED', 'Write their practice, e.g. "Cornwall Medical Centre".');
  } else {
    teamName = text(b.teamName, 120);
    if (teamName.length < 3) throw new HttpError(400, 'TEAM_REQUIRED', 'Write the team\'s name, e.g. "General Medicine Team B".');
  }
  const starts = b.startsAt ? new Date(String(b.startsAt)) : new Date();
  if (Number.isNaN(starts.getTime())) throw new HttpError(400, 'START_INVALID', 'Choose when it starts.');
  const replaces = b.replaces ? store.get<Row>("SELECT id, kind, person_id AS personId FROM assignment WHERE id = ? AND state = 'ACTIVE' AND cover_for IS NULL", String(b.replaces)) : null;
  if (b.replaces && (!replaces || replaces.personId !== personId || replaces.kind !== k.id)) throw new HttpError(409, 'WRONG_STATE', 'That assignment is no longer active.');
  if (!replaces && store.get("SELECT 1 FROM assignment WHERE person_id = ? AND kind = ? AND state IN ('ACTIVE', 'CONFIRMED') AND cover_for IS NULL", personId, k.id)) {
    throw new HttpError(409, 'ALREADY_NAMED', `They already have a ${k.label.toLowerCase()}. Use Hand over to change it.`);
  }
  if (store.get("SELECT 1 FROM assignment WHERE person_id = ? AND kind = ? AND state = 'PROPOSED'", personId, k.id)) {
    throw new HttpError(409, 'ALREADY_PROPOSED', `Someone is already proposed as ${k.label.toLowerCase()}. Confirm or decline that first.`);
  }
  if (assigneeId && replaces && store.get('SELECT 1 FROM assignment WHERE id = ? AND assignee_id = ?', String(replaces.id), assigneeId)) {
    throw new HttpError(400, 'SAME_PERSON', 'That is who it is now. Choose someone else.');
  }
  const reason = text(b.reason, 500) || null;
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('assignment', {
      id, person_id: personId, service_id: ctx.serviceId, kind: k.id, assignee_id: assigneeId, external_name: externalName, external_org: externalOrg, team_name: teamName,
      state: 'PROPOSED', proposed_by: ctx.workerId, proposed_at: now(), reason, starts_at: starts.toISOString(), replaces: replaces ? String(replaces.id) : null,
    });
    recordInitial(store, 'assignment', id, 'PROPOSED', who, `${k.label}: ${assigneeId ? eligible(store, k).find((e) => e.id === assigneeId)?.name : externalName ?? teamName}`);
    logged(store, ctx, 'ASSIGNMENT_PROPOSE', personId, id, `${k.label}${reason ? `: ${reason}` : ''}`);
    // Naming yourself is accepting it.
    if (assigneeId === ctx.workerId) confirmNow(store, ctx, id, 'Named themselves');
  });
  return forPerson(store, ctx, personId);
}

function confirmNow(store: Store, ctx: WorkContext, id: string, note: string) {
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  transition(store, 'assignment', id, 'CONFIRMED', who, note);
  store.run('UPDATE assignment SET confirmed_by = ?, confirmed_at = ?, confirm_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
  const r = store.get<Row>('SELECT id, starts_at AS startsAt, replaces FROM assignment WHERE id = ?', id)!;
  if (String(r.startsAt) <= now()) activate(store, r, who, 'Starts now');
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; coverId?: string; coverName?: string; until?: string }) {
  const r = store.get<Row>(`${ASSIGNMENT} WHERE a.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That assignment is no longer in SHIFT.');
  const personId = String(r.personId);
  settle(store, [personId]);
  const fresh = store.get<Row>(`${ASSIGNMENT} WHERE a.id = ?`, id)!;
  const mine = fresh.assigneeId === ctx.workerId;
  const k = kindOf(fresh.kind);
  const needConfirm = (orMine = true) => { if (!(orMine && mine)) enforce(store, ctx, { op: 'ASSIGNMENT', personId, cap: 'assignment.confirm' }, personId); };
  const note = text(b.note, 500);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  switch (action) {
    case 'confirm': {
      if (fresh.state !== 'PROPOSED') throw new HttpError(409, 'WRONG_STATE', 'This has already been confirmed or declined.');
      needConfirm();
      if (!mine && k.named === 'WORKER' && fresh.assigneeId && !note) throw new HttpError(400, 'NOTE_REQUIRED', `Write how ${fresh.assignee} agreed, e.g. "Agreed at the board round".`);
      if (k.named === 'EXTERNAL' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how it was confirmed, e.g. "Practice confirmed by phone".');
      store.tx(() => {
        confirmNow(store, ctx, id, note || (mine ? 'Accepted by them' : 'Confirmed'));
        logged(store, ctx, 'ASSIGNMENT_CONFIRM', personId, id, note);
      });
      break;
    }
    case 'decline': {
      if (fresh.state !== 'PROPOSED') throw new HttpError(409, 'WRONG_STATE', 'Only a proposal can be declined.');
      if (fresh.proposedById !== ctx.workerId) needConfirm();
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why.');
      store.tx(() => {
        transition(store, 'assignment', id, 'DECLINED', who, note);
        store.run('UPDATE assignment SET declined_by = ?, declined_at = ?, decline_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
        logged(store, ctx, 'ASSIGNMENT_DECLINE', personId, id, note);
      });
      break;
    }
    case 'cover': {
      if (fresh.state !== 'ACTIVE' || fresh.coverFor) throw new HttpError(409, 'WRONG_STATE', 'Only an active assignment can be covered.');
      needConfirm(false);
      const until = b.until ? new Date(String(b.until)) : null;
      if (!until || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) throw new HttpError(400, 'UNTIL_REQUIRED', 'Choose when the cover ends. It must be in the future.');
      if (until.getTime() > Date.now() + 90 * 24 * 3600_000) throw new HttpError(400, 'UNTIL_RANGE', 'Cover can be up to 90 days. For longer, hand over instead.');
      if (store.get("SELECT 1 FROM assignment WHERE cover_for = ? AND state = 'ACTIVE'", id)) throw new HttpError(409, 'ALREADY_COVERED', 'Someone is already covering. End that cover first.');
      let assigneeId: string | null = null;
      let externalName: string | null = null;
      if (k.named === 'WORKER') {
        const c = eligible(store, k).find((e) => e.id === b.coverId);
        if (!c) throw new HttpError(400, 'NOT_ELIGIBLE', `Choose someone who can cover as ${k.label.toLowerCase()}.`);
        if (c.id === fresh.assigneeId) throw new HttpError(400, 'SAME_PERSON', 'Choose someone else to cover.');
        assigneeId = c.id;
      } else {
        externalName = text(b.coverName, 120);
        if (externalName.length < 3) throw new HttpError(400, 'NAME_REQUIRED', 'Write who is covering.');
      }
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why, e.g. "Annual leave".');
      const cid = newId();
      const at = now();
      store.tx(() => {
        store.insert('assignment', {
          id: cid, person_id: personId, service_id: String(fresh.serviceId), kind: k.id, assignee_id: assigneeId, external_name: externalName, external_org: externalName ? fresh.externalOrg : null,
          team_name: null, state: 'PROPOSED', proposed_by: ctx.workerId, proposed_at: at, reason: note, starts_at: at, ends_at: until.toISOString(), cover_for: id,
        });
        recordInitial(store, 'assignment', cid, 'PROPOSED', who, `Cover for ${nameOf(fresh)}: ${note}`);
        transition(store, 'assignment', cid, 'CONFIRMED', who, 'Cover arranged');
        store.run('UPDATE assignment SET confirmed_by = ?, confirmed_at = ?, confirm_note = ? WHERE id = ?', ctx.workerId, at, note, cid);
        activate(store, { id: cid, replaces: null }, who, 'Cover starts');
        logged(store, ctx, 'ASSIGNMENT_COVER', personId, cid, `${note}, until ${until.toISOString().slice(0, 10)}`);
      });
      break;
    }
    case 'end': {
      if (!['ACTIVE', 'CONFIRMED'].includes(String(fresh.state))) throw new HttpError(409, 'WRONG_STATE', 'This has already ended.');
      needConfirm(false);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is ending.');
      store.tx(() => {
        end(store, id, who, note);
        logged(store, ctx, 'ASSIGNMENT_END', personId, id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Care team view: each kind with who is active, covering, confirmed to start, or proposed.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  settle(store, [personId]);
  const canPropose = may(store, ctx, personId, 'assignment.propose');
  const canConfirm = may(store, ctx, personId, 'assignment.confirm');
  const rows = store.all<Row>(`${ASSIGNMENT} WHERE a.person_id = ? ORDER BY a.proposed_at DESC`, personId).map((r) => shape(store, ctx, r, canPropose, canConfirm));
  const kinds = ASSIGNMENT_KINDS.map((k) => {
    const active = rows.find((r) => r.kind === k.id && r.state === 'ACTIVE' && !r.coverFor) ?? null;
    return {
      kind: k.id, label: k.label, named: k.named,
      active, cover: active ? rows.find((r) => r.coverFor === active.id && r.state === 'ACTIVE') ?? null : null,
      upcoming: rows.find((r) => r.kind === k.id && r.state === 'CONFIRMED' && !r.coverFor) ?? null,
      proposed: rows.find((r) => r.kind === k.id && r.state === 'PROPOSED') ?? null,
    };
  });
  return {
    kinds, required: gaps(store, personId), past: rows.filter((r) => ['ENDED', 'DECLINED'].includes(r.state)), canPropose, canConfirm,
    options: { people: Object.fromEntries(ASSIGNMENT_KINDS.map((k) => [k.id, eligible(store, k)])) },
  };
}

// For the record header: who is named now, with any cover, and what is required but missing.
export function current(store: Store, personId: string) {
  settle(store, [personId]);
  const rows = store.all<Row>(`${ASSIGNMENT} WHERE a.person_id = ? AND a.state = 'ACTIVE'`, personId);
  const named = ASSIGNMENT_KINDS.flatMap((k) => {
    const a = rows.find((r) => r.kind === k.id && !r.coverFor);
    if (!a) return [];
    const c = rows.find((r) => r.coverFor === a.id);
    return [{ label: k.short, name: nameOf(a), cover: c ? nameOf(c) : null, until: c ? c.endsAt : null }];
  });
  const missing = gaps(store, personId);
  return named.length || missing.length ? { named, missing } : null;
}

// Home → Care team: proposals waiting for me, then for a senior to confirm, then people missing a required name, then covers ending soon.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('assignment.propose')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include naming clinicians`);
  const people = store.all<{ id: string }>(
    "SELECT person_id AS id FROM encounter WHERE service_id = ? AND state = 'ACTIVE' UNION SELECT person_id AS id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL",
    ctx.serviceId, ctx.serviceId).map((p) => p.id);
  settle(store, people);
  const canConfirm = ctx.role.capabilities.includes('assignment.confirm');
  const marks = people.map(() => '?').join(',') || "''";
  const proposed = store.all<Row>(`${ASSIGNMENT} WHERE (a.person_id IN (${marks}) OR a.assignee_id = ?) AND a.state = 'PROPOSED' ORDER BY a.proposed_at`, ...people, ctx.workerId)
    .map((r) => shape(store, ctx, r, true, canConfirm));
  const soon = new Date(Date.now() + 24 * 3600_000).toISOString();
  const endingSoon = store.all<Row>(`${ASSIGNMENT} WHERE a.person_id IN (${marks}) AND a.state = 'ACTIVE' AND a.cover_for IS NOT NULL AND a.ends_at <= ? ORDER BY a.ends_at`, ...people, soon)
    .map((r) => shape(store, ctx, r, true, canConfirm));
  const missing = people.flatMap((pid) => {
    const g = gaps(store, pid, ctx.serviceId);
    if (!g.length) return [];
    const p = store.get<Row>(`SELECT p.given_name || ' ' || p.family_name AS patient,
      (SELECT location FROM encounter e WHERE e.person_id = p.id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location FROM person p WHERE p.id = ?`, pid);
    return [{ personId: pid, patient: p?.patient, location: p?.location, missing: g }];
  });
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_ASSIGNMENTS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    forMe: proposed.filter((r) => r.mine), toConfirm: proposed.filter((r) => !r.mine && r.actions.includes('confirm')),
    waiting: proposed.filter((r) => !r.mine && !r.actions.includes('confirm')), missing, endingSoon,
  };
}
