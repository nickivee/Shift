import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, revise } from './lifecycle.ts';
import { TYPES, ROOMS, STATES, CEASE, REVIEW_HOURS, OUTBREAK_STATES, PERSON_STATES, REFS } from '../config/isolation.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Isolation / Transmission Precaution (Shared Lifecycle Object 235):
//   transmission concern → IPC assessment → precaution requirement → precaution type →
//   implementation → location/environmental requirements → review → modification → cessation.
// Infection prevention and control (Build 99):
//   infection/transmission signal → IPC assessment → precaution requirement → isolation/cohorting →
//   exposure identification → contact tracing → service response → outbreak linkage → review →
//   precaution cessation → surveillance.
// A nurse or doctor records the concern and the precautions they have decided on, and says when the
// precautions are actually in place and where. Precautions show on the record for everyone who opens
// it, caregivers and therapists included. They are reviewed by a set time, changed with what they
// were kept, and stopped only by a person with a reason. An outbreak is declared for a service,
// with its cases, the contacts being watched, and what the service did, until it is closed.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const typesLabel = (v: string | null) => list(v).map((t) => TYPES[t] ?? t).join(' and ');
const hoursFrom = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'PRECAUTION', personId }).decision === 'ALLOW';
const mayOutbreak = (store: Store, ctx: WorkContext) => evaluate(store, ctx, { op: 'OUTBREAK', serviceId: ctx.serviceId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string | null, objectType: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const note = (store: Store, table: 'precaution_log' | 'outbreak_log', key: string, id: string, kind: string, body: string, by: string) =>
  store.insert(table, { id: newId(), [key]: id, kind, body, by_id: by, at: now() });

const P = `
  SELECT c.id, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = c.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         c.service_id AS serviceId, c.infection_id AS infectionId, i.site AS infectionSite, i.suspicion AS infectionSuspicion,
         c.outbreak_id AS outbreakId, o.what AS outbreak, c.concern, c.types, c.room, c.state, c.review_due AS reviewDue,
         rb.display_name AS requiredBy, c.required_at AS requiredAt, pb.display_name AS placedBy, c.placed_at AS placedAt, c.place_note AS placeNote,
         cb.display_name AS ceasedBy, c.ceased_at AS ceasedAt, c.cease_reason AS ceaseReason, c.cease_note AS ceaseNote
    FROM precaution c
    JOIN person p ON p.id = c.person_id
    LEFT JOIN infection i ON i.id = c.infection_id
    LEFT JOIN outbreak o ON o.id = c.outbreak_id
    JOIN workforce_person rb ON rb.id = c.required_by
    LEFT JOIN workforce_person pb ON pb.id = c.placed_by
    LEFT JOIN workforce_person cb ON cb.id = c.ceased_by`;

function steps(store: Store, table: string, key: string, id: string) {
  return store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM ${table} l JOIN workforce_person w ON w.id = l.by_id WHERE l.${key} = ? ORDER BY l.at, l.rowid`, id);
}

function shape(store: Store, r: Row, can: boolean) {
  const state = String(r.state);
  const overdue = state !== 'CEASED' && !!r.reviewDue && String(r.reviewDue) < now();
  const actions: string[] = [];
  if (can && state === 'REQUIRED') actions.push('place', 'review', 'change', 'stop');
  if (can && state === 'IN_PLACE') actions.push('review', 'change', 'stop');
  return {
    ...r, state, personId: String(r.personId), typeList: list(r.types as string | null), typesLabel: typesLabel(r.types as string | null), roomLabel: ROOMS[String(r.room)] ?? r.room,
    stateLabel: STATES[state], ceaseLabel: r.ceaseReason ? CEASE[String(r.ceaseReason)] : null, overdue, actions,
    log: steps(store, 'precaution_log', 'precaution_id', String(r.id)),
  };
}

// For the record header, shown to everyone who can open the record.
export function current(store: Store, personId: string) {
  const rows = store.all<Row>("SELECT types, room, state FROM precaution WHERE person_id = ? AND state IN ('REQUIRED', 'IN_PLACE') ORDER BY required_at", personId)
    .map((r) => `${typesLabel(r.types as string)} precautions${r.room !== 'NONE' ? `, ${String(ROOMS[String(r.room)]).toLowerCase()}` : ''}${r.state === 'REQUIRED' ? ' (not yet in place)' : ''}`);
  const watch = store.all<Row>(
    `SELECT o.what, x.state, x.watch_until AS until FROM outbreak_person x JOIN outbreak o ON o.id = x.outbreak_id
      WHERE x.person_id = ? AND o.state = 'DECLARED' AND x.state IN ('CASE', 'WATCHING')`, personId)
    .map((x) => x.state === 'CASE' ? `Case in the ${x.what} outbreak` : `Contact in the ${x.what} outbreak, watching until ${String(x.until).slice(0, 10)}`);
  const all = [...rows, ...watch];
  return all.length ? all : null;
}

function validTypes(v: unknown) {
  const t = (Array.isArray(v) ? v : String(v ?? '').split(',')).map(String).filter((k) => TYPES[k]);
  if (!t.length) throw new HttpError(400, 'TYPE_REQUIRED', 'Choose the precautions: contact, droplet or airborne.');
  return Object.keys(TYPES).filter((k) => t.includes(k)).join(',');
}
function validRoom(v: unknown) {
  if (!ROOMS[String(v)]) throw new HttpError(400, 'ROOM_REQUIRED', 'Choose where they need to be.');
  return String(v);
}
function validReview(v: unknown) {
  const h = Number(v);
  if (!REVIEW_HOURS.includes(h)) throw new HttpError(400, 'REVIEW_REQUIRED', 'Choose when the precautions will be looked at again.');
  return hoursFrom(h);
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${P} WHERE c.person_id = ? ORDER BY c.required_at DESC`, personId).map((r) => shape(store, r, can));
  return {
    active: all.filter((x) => x.state !== 'CEASED'),
    ended: all.filter((x) => x.state === 'CEASED'),
    canManage: can,
    infections: store.all<Row>("SELECT id, site, suspicion FROM infection WHERE person_id = ? AND state IN ('SUSPECTED', 'CONFIRMED', 'ONGOING') ORDER BY raised_at DESC", personId),
    outbreaks: store.all<Row>("SELECT id, what FROM outbreak WHERE service_id = ? AND state = 'DECLARED'", ctx.serviceId),
    options: { types: TYPES, rooms: ROOMS, reviewHours: REVIEW_HOURS, cease: CEASE },
  };
}

export function start(store: Store, ctx: WorkContext, personId: string, b: { concern?: string; types?: unknown; room?: string; reviewHours?: unknown; infectionId?: string; outbreakId?: string }) {
  enforce(store, ctx, { op: 'PRECAUTION', personId }, personId);
  const concern = text(b.concern);
  if (concern.length < 5) throw new HttpError(400, 'CONCERN_REQUIRED', 'Write what the concern is, e.g. "Diarrhoea and vomiting since last night".');
  const types = validTypes(b.types);
  const room = validRoom(b.room);
  const due = validReview(b.reviewHours);
  const infectionId = text(b.infectionId, 64) || null;
  if (infectionId && !store.get("SELECT 1 FROM infection WHERE id = ? AND person_id = ?", infectionId, personId)) throw new HttpError(400, 'BAD_INFECTION', 'That infection is not in their record.');
  const outbreakId = text(b.outbreakId, 64) || null;
  if (outbreakId && !store.get("SELECT 1 FROM outbreak WHERE id = ? AND service_id = ? AND state = 'DECLARED'", outbreakId, ctx.serviceId)) throw new HttpError(400, 'BAD_OUTBREAK', 'That outbreak is not open in your service.');
  if (store.get("SELECT 1 FROM precaution WHERE person_id = ? AND state IN ('REQUIRED', 'IN_PLACE') AND types = ?", personId, types)) {
    throw new HttpError(409, 'ALREADY', `${typesLabel(types)} precautions are already in their record. Review or change those instead.`);
  }
  const id = newId();
  store.tx(() => {
    store.insert('precaution', {
      id, person_id: personId, service_id: ctx.serviceId, infection_id: infectionId, outbreak_id: outbreakId, concern, types, room, state: 'REQUIRED',
      review_due: due, required_by: ctx.workerId, required_at: now(),
    });
    recordInitial(store, 'precaution', id, 'REQUIRED', { actorId: ctx.workerId, workContextId: ctx.id }, concern);
    note(store, 'precaution_log', 'precaution_id', id, 'REQUIRED', `${typesLabel(types)} precautions; ${String(ROOMS[room]).toLowerCase()}. ${concern}`, ctx.workerId);
    logged(store, ctx, 'PRECAUTION_START', personId, 'precaution', id, `${typesLabel(types)}: ${concern}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; types?: unknown; room?: string; reviewHours?: unknown; reason?: string }) {
  const r = store.get<Row>(`${P} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Those precautions are no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'PRECAUTION', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = text(b.note);
  const open = String(r.state) !== 'CEASED';
  if (!open) throw new HttpError(409, 'STOPPED', 'These precautions have already stopped. Start new ones if they are needed again.');
  store.tx(() => {
    switch (action) {
      case 'place': {
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write where they are and what is in place, e.g. "Side room 2, sign on door, gowns and gloves at the door".');
        transition(store, 'precaution', id, 'IN_PLACE', who, say);
        store.run('UPDATE precaution SET placed_by = ?, placed_at = ?, place_note = ? WHERE id = ?', ctx.workerId, now(), say, id);
        note(store, 'precaution_log', 'precaution_id', id, 'IN_PLACE', say, ctx.workerId);
        logged(store, ctx, 'PRECAUTION_IN_PLACE', personId, 'precaution', id, say);
        break;
      }
      case 'review': {
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you found, e.g. "Still loose stools; flu swab pending".');
        const due = validReview(b.reviewHours);
        store.run('UPDATE precaution SET review_due = ? WHERE id = ?', due, id);
        note(store, 'precaution_log', 'precaution_id', id, 'REVIEWED', say, ctx.workerId);
        logged(store, ctx, 'PRECAUTION_REVIEW', personId, 'precaution', id, say);
        break;
      }
      case 'change': {
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why they are changing, e.g. "Flu confirmed; droplet precautions added".');
        const after = { types: validTypes(b.types), room: validRoom(b.room) };
        const changed = revise(store, 'precaution', id, { types: r.types, room: r.room }, after,
          { types: ['Precautions', { [String(r.types)]: typesLabel(r.types as string), [after.types]: typesLabel(after.types) }], room: ['Where', ROOMS] }, who, say);
        if (!changed) throw new HttpError(409, 'UNCHANGED', 'Nothing was changed.');
        store.run('UPDATE precaution SET types = ?, room = ? WHERE id = ?', after.types, after.room, id);
        note(store, 'precaution_log', 'precaution_id', id, 'CHANGED', `${changed}. ${say}`, ctx.workerId);
        logged(store, ctx, 'PRECAUTION_CHANGE', personId, 'precaution', id, changed);
        break;
      }
      case 'stop': {
        const reason = CEASE[String(b.reason)] ? String(b.reason) : '';
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why the precautions are stopping.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what the decision was based on, e.g. "48 hours without symptoms, as the policy says".');
        transition(store, 'precaution', id, 'CEASED', who, say);
        store.run('UPDATE precaution SET ceased_by = ?, ceased_at = ?, cease_reason = ?, cease_note = ? WHERE id = ?', ctx.workerId, now(), reason, say, id);
        note(store, 'precaution_log', 'precaution_id', id, 'CEASED', `${CEASE[reason]}. ${say}`, ctx.workerId);
        logged(store, ctx, 'PRECAUTION_STOP', personId, 'precaution', id, say);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}

// Outbreaks ------------------------------------------------------------------------------------

function people(store: Store, outbreakId: string) {
  return store.all<Row>(
    `SELECT x.id, x.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, x.state, x.exposure, x.watch_until AS watchUntil,
            ab.display_name AS addedBy, x.added_at AS addedAt, eb.display_name AS endedBy, x.ended_at AS endedAt, x.end_note AS endNote,
            (SELECT location FROM encounter e WHERE e.person_id = x.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location
       FROM outbreak_person x JOIN person p ON p.id = x.person_id
       JOIN workforce_person ab ON ab.id = x.added_by LEFT JOIN workforce_person eb ON eb.id = x.ended_by
      WHERE x.outbreak_id = ? ORDER BY x.added_at`, outbreakId)
    .map((x) => ({ ...x, state: String(x.state), stateLabel: PERSON_STATES[String(x.state)], overdue: x.state === 'WATCHING' && String(x.watchUntil) < now() }));
}

function shapeOutbreak(store: Store, o: Row, can: boolean) {
  const ps = people(store, String(o.id));
  return {
    ...o, stateLabel: OUTBREAK_STATES[String(o.state)], people: ps,
    cases: ps.filter((x) => x.state === 'CASE' || x.state === 'RECOVERED' || x.state === 'BECAME_CASE').length,
    watching: ps.filter((x) => x.state === 'WATCHING').length,
    canManage: can && o.state === 'DECLARED',
    log: steps(store, 'outbreak_log', 'outbreak_id', String(o.id)),
  };
}

const O = `SELECT o.id, o.what, o.state, db.display_name AS declaredBy, o.declared_at AS declaredAt, cb.display_name AS closedBy, o.closed_at AS closedAt, o.close_note AS closeNote
  FROM outbreak o JOIN workforce_person db ON db.id = o.declared_by LEFT JOIN workforce_person cb ON cb.id = o.closed_by`;

// Home → Infections: precautions across the service and the service's outbreaks.
export function forService(store: Store, ctx: WorkContext) {
  const rows = store.all<Row>(`${P} WHERE c.service_id = ? AND c.state IN ('REQUIRED', 'IN_PLACE') ORDER BY c.required_at`, ctx.serviceId)
    .map((r) => shape(store, r, may(store, ctx, String(r.personId))));
  const can = mayOutbreak(store, ctx);
  const fortnight = new Date(Date.now() - 14 * 86400_000).toISOString();
  return {
    precautions: rows,
    notInPlace: rows.filter((x) => x.state === 'REQUIRED').length,
    reviewDue: rows.filter((x) => x.overdue).length,
    outbreaks: store.all<Row>(`${O} WHERE o.service_id = ? AND (o.state = 'DECLARED' OR o.closed_at >= ?) ORDER BY o.declared_at DESC`, ctx.serviceId, fortnight)
      .map((o) => shapeOutbreak(store, o, can)),
    canDeclare: can,
    residents: can ? store.all<Row>(
      `SELECT DISTINCT p.id, p.given_name || ' ' || p.family_name AS name FROM encounter e JOIN person p ON p.id = e.person_id
        WHERE e.service_id = ? AND e.state = 'ACTIVE' ORDER BY p.family_name`, ctx.serviceId) : [],
  };
}

export function declare(store: Store, ctx: WorkContext, b: { what?: string; note?: string }) {
  enforce(store, ctx, { op: 'OUTBREAK', serviceId: ctx.serviceId });
  const what = text(b.what, 120);
  if (what.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what the outbreak is, e.g. "Gastroenteritis (suspected norovirus)".');
  const say = text(b.note);
  if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why you are declaring it, e.g. "Three residents with vomiting within 24 hours".');
  if (store.get("SELECT 1 FROM outbreak WHERE service_id = ? AND state = 'DECLARED' AND lower(what) = lower(?)", ctx.serviceId, what)) {
    throw new HttpError(409, 'ALREADY', 'That outbreak is already open. Add people to it instead.');
  }
  const id = newId();
  store.tx(() => {
    store.insert('outbreak', { id, service_id: ctx.serviceId, what, state: 'DECLARED', declared_by: ctx.workerId, declared_at: now() });
    recordInitial(store, 'outbreak', id, 'DECLARED', { actorId: ctx.workerId, workContextId: ctx.id }, say);
    note(store, 'outbreak_log', 'outbreak_id', id, 'DECLARED', say, ctx.workerId);
    logged(store, ctx, 'OUTBREAK_DECLARE', null, 'outbreak', id, `${what}: ${say}`);
  });
  return forService(store, ctx);
}

export function outbreakAct(store: Store, ctx: WorkContext, id: string, action: string,
  b: { personId?: string; role?: string; exposure?: string; watchDays?: unknown; entryId?: string; to?: string; note?: string }) {
  enforce(store, ctx, { op: 'OUTBREAK', serviceId: ctx.serviceId });
  const o = store.get<Row>('SELECT id, what, state, service_id AS serviceId FROM outbreak WHERE id = ?', id);
  if (!o || o.serviceId !== ctx.serviceId) throw new HttpError(404, 'NOT_FOUND', 'That outbreak is not in your service.');
  if (o.state !== 'DECLARED') throw new HttpError(409, 'CLOSED', 'This outbreak has been closed.');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = text(b.note);
  store.tx(() => {
    switch (action) {
      case 'add': {
        const personId = text(b.personId, 64);
        if (!store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId)) throw new HttpError(400, 'PERSON_REQUIRED', 'Choose someone in your service.');
        if (store.get("SELECT 1 FROM outbreak_person WHERE outbreak_id = ? AND person_id = ? AND state IN ('CASE', 'WATCHING')", id, personId)) throw new HttpError(409, 'ALREADY', 'They are already in this outbreak.');
        const role = b.role === 'CASE' ? 'CASE' : b.role === 'CONTACT' ? 'WATCHING' : '';
        if (!role) throw new HttpError(400, 'ROLE_REQUIRED', 'Say whether they are ill (a case) or were exposed (a contact).');
        const exposure = text(b.exposure, 300);
        if (exposure.length < 5) throw new HttpError(400, 'EXPOSURE_REQUIRED', role === 'CASE' ? 'Write how they are unwell and since when, e.g. "Vomiting since 03:00".' : 'Write how they were exposed, e.g. "Shares a table with William at meals".');
        const days = Number(b.watchDays);
        if (role === 'WATCHING' && !(days >= 1 && days <= 21)) throw new HttpError(400, 'WATCH_REQUIRED', 'Say how many days to watch them, as your infection prevention policy says.');
        const xid = newId();
        store.insert('outbreak_person', {
          id: xid, outbreak_id: id, person_id: personId, state: role, exposure, watch_until: role === 'WATCHING' ? new Date(Date.now() + days * 86400_000).toISOString() : null,
          added_by: ctx.workerId, added_at: now(),
        });
        recordInitial(store, 'outbreak_person', xid, role, who, exposure);
        const name = store.get<{ n: string }>("SELECT given_name || ' ' || family_name AS n FROM person WHERE id = ?", personId)!.n;
        note(store, 'outbreak_log', 'outbreak_id', id, role === 'CASE' ? 'CASE' : 'CONTACT', `${name}: ${exposure}`, ctx.workerId);
        logged(store, ctx, role === 'CASE' ? 'OUTBREAK_CASE' : 'OUTBREAK_CONTACT', personId, 'outbreak', id, exposure);
        break;
      }
      case 'person': {
        const x = store.get<Row>('SELECT id, person_id AS personId, state FROM outbreak_person WHERE id = ? AND outbreak_id = ?', text(b.entryId, 64), id);
        if (!x) throw new HttpError(404, 'NOT_FOUND', 'They are not listed in this outbreak.');
        const to = String(b.to ?? '');
        const allowedTo: Record<string, string[]> = { CASE: ['RECOVERED'], WATCHING: ['CLEARED', 'BECAME_CASE'] };
        if (!(allowedTo[String(x.state)] ?? []).includes(to)) throw new HttpError(400, 'WRONG_STEP', 'That change does not apply to them now.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', to === 'BECAME_CASE' ? 'Write how they became unwell.' : 'Write what the decision was based on, e.g. "No symptoms for 48 hours".');
        transition(store, 'outbreak_person', String(x.id), to, who, say);
        store.run('UPDATE outbreak_person SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), say, x.id);
        const name = store.get<{ n: string }>("SELECT given_name || ' ' || family_name AS n FROM person WHERE id = ?", x.personId)!.n;
        note(store, 'outbreak_log', 'outbreak_id', id, to, `${name}: ${say}`, ctx.workerId);
        logged(store, ctx, `OUTBREAK_${to}`, String(x.personId), 'outbreak', id, say);
        break;
      }
      case 'response': {
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what the service has done, e.g. "Dining room closed; meals in rooms".');
        note(store, 'outbreak_log', 'outbreak_id', id, 'RESPONSE', say, ctx.workerId);
        logged(store, ctx, 'OUTBREAK_RESPONSE', null, 'outbreak', id, say);
        break;
      }
      case 'close': {
        const watching = store.get<{ n: number }>("SELECT count(*) AS n FROM outbreak_person WHERE outbreak_id = ? AND state IN ('WATCHING', 'CASE')", id)!.n;
        if (watching) throw new HttpError(409, 'STILL_OPEN', `${watching} ${watching === 1 ? 'person is' : 'people are'} still ill or being watched. Record how each one is before closing.`);
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is over and what was learned, e.g. "No new cases for 72 hours; clean completed".');
        transition(store, 'outbreak', id, 'CLOSED', who, say);
        store.run('UPDATE outbreak SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, now(), say, id);
        note(store, 'outbreak_log', 'outbreak_id', id, 'CLOSED', say, ctx.workerId);
        logged(store, ctx, 'OUTBREAK_CLOSE', null, 'outbreak', id, say);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forService(store, ctx);
}
