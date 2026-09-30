import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, revise } from './lifecycle.ts';
import { LEVELS, PROVIDED, KINDS, SOURCES, STATES, END, REFS } from '../config/residency.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Residential care stay (entries 51, 52):
//   place offered → accepted (or not taken) → moved in → living here, at an assessed level of care
//   → reassessment asked for when needs change → new level recorded → hospital stay with the room
//   held → back → left our care (died, moved, went home, level not provided here).
// Registered nurses record it; caregivers can read it. The level is what a needs assessment
// service decided: SHIFT records it and where it came from, and never decides it. Levels,
// funding and how long a room is held are RR-ARC-001.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const pick = (map: Record<string, string>, v: unknown) => (map[String(v)] ? String(v) : '');
const OPEN = "('OFFERED', 'ACCEPTED', 'LIVING_HERE', 'IN_HOSPITAL')";

const may = (store: Store, ctx: WorkContext, personId: string) =>
  evaluate(store, ctx, { op: 'RESIDENCY', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'residency', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const note = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('residency_log', { id: newId(), residency_id: id, kind, body, by_id: by, at: now() });
const sentence = (s: string) => s.replace(/\.?$/, '.');

const Q = `
  SELECT r.id, r.person_id AS personId, r.kind, r.state, r.room, r.level, r.level_source AS levelSource, r.level_on AS levelOn,
         r.reassess_at AS reassessAt, r.reassess_why AS reassessWhy, r.offered_at AS offeredAt, r.moved_in_at AS movedInAt,
         r.hospital_at AS hospitalAt, r.hospital_where AS hospitalWhere, r.hospital_why AS hospitalWhy,
         rb.display_name AS recordedBy, r.recorded_at AS recordedAt,
         eb.display_name AS endedBy, r.ended_at AS endedAt, r.end_reason AS endReason, r.end_note AS endNote
    FROM residency r
    JOIN workforce_person rb ON rb.id = r.recorded_by
    LEFT JOIN workforce_person eb ON eb.id = r.ended_by`;

function shape(store: Store, r: Row, manage: boolean) {
  const state = String(r.state);
  const actions: string[] = [];
  if (manage) {
    if (state === 'OFFERED') actions.push('accept', 'movein', 'decline');
    if (state === 'ACCEPTED') actions.push('movein', 'decline');
    if (state === 'LIVING_HERE') actions.push('hospital', 'reassess', 'level', 'end');
    if (state === 'IN_HOSPITAL') actions.push('back', 'reassess', 'level', 'end');
  }
  const level = String(r.level);
  return {
    ...r, state, stateLabel: STATES[state], kindLabel: KINDS[String(r.kind)], levelLabel: LEVELS[level], sourceLabel: SOURCES[String(r.levelSource)] ?? null,
    notProvided: level !== 'NOT_KNOWN' && !PROVIDED.includes(level),
    endLabel: r.endReason ? END[String(r.endReason)] : null,
    daysAway: state === 'IN_HOSPITAL' && r.hospitalAt ? Math.max(0, Math.floor((Date.now() - Date.parse(String(r.hospitalAt))) / 86_400_000)) : null,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM residency_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.residency_id = ? ORDER BY l.at, l.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE r.person_id = ? ORDER BY r.recorded_at DESC`, personId).map((r) => shape(store, r, manage));
  const stay = all.find((x) => !['DECLINED', 'ENDED'].includes(x.state)) ?? null;
  return {
    stay,
    past: all.filter((x) => x !== stay),
    canStart: manage && !stay,
    options: { levels: LEVELS, provided: PROVIDED, kinds: KINDS, sources: SOURCES, end: END },
  };
}

// For the record header, for everyone who opens it: only a hospital stay shows there.
export function current(store: Store, personId: string) {
  const r = store.get<Row>("SELECT hospital_at AS since, hospital_where AS \"where\" FROM residency WHERE person_id = ? AND state = 'IN_HOSPITAL'", personId);
  return r ? { since: String(r.since), where: r.where } : null;
}

interface Body {
  kind?: string; here?: unknown; room?: string; level?: string; source?: string; levelOn?: string; note?: string; where?: string; reason?: string;
}

function assessed(b: Body) {
  const level = pick(LEVELS, b.level);
  if (!level) throw new HttpError(400, 'LEVEL_REQUIRED', 'Choose the level of care they were assessed as needing, or "Not known yet".');
  if (level === 'NOT_KNOWN') return { level, level_source: null, level_on: null };
  const source = pick(SOURCES, b.source);
  if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose who assessed their level of care.');
  const on = text(b.levelOn, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > now().slice(0, 10)) throw new HttpError(400, 'DATE_REQUIRED', 'Enter the date of the assessment. It cannot be in the future.');
  return { level, level_source: source, level_on: on };
}

export function start(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'RESIDENCY', personId }, personId);
  if (store.get(`SELECT 1 FROM residency WHERE person_id = ? AND state IN ${OPEN}`, personId)) {
    throw new HttpError(409, 'ALREADY', 'They already have a place here. Change that one.');
  }
  const kind = pick(KINDS, b.kind);
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose whether this is a long-term place or a short stay.');
  const a = assessed(b);
  const room = text(b.room, 60) || null;
  const here = b.here === true || b.here === 'yes';
  const say = text(b.note);
  if (!here && say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write who the place was offered to and how, e.g. "Phoned her daughter Anne; room 12 from Monday".');
  const state = here ? 'LIVING_HERE' : 'OFFERED';
  const id = newId();
  const summary = `${KINDS[kind]} place${room ? `, ${room}` : ''}. Level: ${LEVELS[a.level]}${a.level_source ? ` (${SOURCES[a.level_source]}, ${a.level_on})` : ''}.`;
  store.tx(() => {
    store.insert('residency', {
      id, person_id: personId, service_id: ctx.serviceId, kind, state, room, ...a,
      offered_at: here ? null : now(), moved_in_at: here ? now() : null, recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'residency', id, state, { actorId: ctx.workerId, workContextId: ctx.id }, summary);
    note(store, id, here ? 'MOVED_IN' : 'OFFERED', say ? `${summary} ${sentence(say)}` : summary, ctx.workerId);
    logged(store, ctx, here ? 'RESIDENCY_START' : 'RESIDENCY_OFFER', personId, id, summary);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That stay is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'RESIDENCY', personId }, personId);
  const state = String(r.state);
  if (['DECLINED', 'ENDED'].includes(state)) throw new HttpError(409, 'ENDED', 'This stay has ended.');
  const say = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const need = (states: string[], msg: string) => { if (!states.includes(state)) throw new HttpError(409, 'STATE', msg); };
  store.tx(() => {
    switch (action) {
      case 'accept': {
        need(['OFFERED'], 'Only an offered place can be accepted.');
        if (say.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write who accepted and when they will move in.');
        transition(store, 'residency', id, 'ACCEPTED', who, 'Place accepted');
        note(store, id, 'ACCEPTED', say, ctx.workerId);
        logged(store, ctx, 'RESIDENCY_ACCEPT', personId, id, 'Place accepted');
        break;
      }
      case 'decline': {
        need(['OFFERED', 'ACCEPTED'], 'Only a place not yet moved into can be turned down.');
        if (say.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write who said no and why, if they said.');
        transition(store, 'residency', id, 'DECLINED', who, 'Place not taken');
        store.run('UPDATE residency SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), say, id);
        note(store, id, 'DECLINED', say, ctx.workerId);
        logged(store, ctx, 'RESIDENCY_DECLINE', personId, id, 'Place not taken');
        break;
      }
      case 'movein': {
        need(['OFFERED', 'ACCEPTED'], 'They have already moved in.');
        const room = text(b.room, 60) || r.room;
        transition(store, 'residency', id, 'LIVING_HERE', who, 'Moved in');
        store.run('UPDATE residency SET moved_in_at = ?, room = ? WHERE id = ?', now(), room, id);
        note(store, id, 'MOVED_IN', [room ? `Moved into ${room}.` : 'Moved in.', say ? sentence(say) : ''].join(' ').trim(), ctx.workerId);
        logged(store, ctx, 'RESIDENCY_MOVE_IN', personId, id, 'Moved in');
        break;
      }
      case 'reassess': {
        need(['LIVING_HERE', 'IN_HOSPITAL'], 'A reassessment is asked for once they live here.');
        if (r.reassessAt) throw new HttpError(409, 'ALREADY', 'A reassessment has already been asked for. Record the new level when it comes.');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what has changed, e.g. "Now needs two staff and the hoist for all transfers".');
        store.run('UPDATE residency SET reassess_at = ?, reassess_why = ? WHERE id = ?', now(), say, id);
        note(store, id, 'REASSESS', say, ctx.workerId);
        logged(store, ctx, 'RESIDENCY_REASSESS', personId, id, 'Reassessment asked for');
        break;
      }
      case 'level': {
        need(['LIVING_HERE', 'IN_HOSPITAL'], 'The level is changed once they live here.');
        const after = assessed(b);
        const changed = revise(store, 'residency', id,
          { level: r.level, level_source: r.levelSource, level_on: r.levelOn }, after,
          { level: ['Level of care', LEVELS], level_source: ['Assessed by', SOURCES], level_on: 'Assessed on' }, who, say || 'New assessment');
        if (!changed) throw new HttpError(409, 'UNCHANGED', 'Nothing was changed.');
        store.run('UPDATE residency SET level = ?, level_source = ?, level_on = ?, reassess_at = NULL, reassess_why = NULL WHERE id = ?', after.level, after.level_source, after.level_on, id);
        const warn = after.level !== 'NOT_KNOWN' && !PROVIDED.includes(after.level) ? ` We do not provide ${LEVELS[after.level].toLowerCase()}.` : '';
        note(store, id, 'LEVEL', `${changed}.${warn}${say ? ` ${sentence(say)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'RESIDENCY_LEVEL', personId, id, changed);
        break;
      }
      case 'hospital': {
        need(['LIVING_HERE'], 'They are already in hospital.');
        const where = text(b.where, 120);
        if (where.length < 3) throw new HttpError(400, 'WHERE_REQUIRED', 'Write which hospital they went to.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why they went, e.g. "Fall, hip pain, ambulance to ED".');
        transition(store, 'residency', id, 'IN_HOSPITAL', who, 'Went to hospital');
        store.run('UPDATE residency SET hospital_at = ?, hospital_where = ?, hospital_why = ? WHERE id = ?', now(), where, say, id);
        note(store, id, 'HOSPITAL', `To ${where}. ${sentence(say)} Room held.`, ctx.workerId);
        logged(store, ctx, 'RESIDENCY_HOSPITAL', personId, id, `To ${where}`);
        break;
      }
      case 'back': {
        need(['IN_HOSPITAL'], 'They are not in hospital.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what changed while they were away, e.g. "New walking frame; antibiotics for 5 more days".');
        transition(store, 'residency', id, 'LIVING_HERE', who, 'Back from hospital');
        store.run('UPDATE residency SET hospital_at = NULL, hospital_where = NULL, hospital_why = NULL WHERE id = ?', id);
        note(store, id, 'BACK', `Back from ${r.hospitalWhere}. ${sentence(say)}`, ctx.workerId);
        logged(store, ctx, 'RESIDENCY_BACK', personId, id, 'Back from hospital');
        break;
      }
      case 'end': {
        need(['LIVING_HERE', 'IN_HOSPITAL'], 'Only a place they live in can end.');
        const reason = pick(END, b.reason);
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why they are leaving our care.');
        if (reason === 'DIED') throw new HttpError(400, 'USE_DEATH', 'Record their death on the End of life screen. Their stay ends with it.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write where they went and who was told.');
        transition(store, 'residency', id, 'ENDED', who, END[reason]);
        store.run('UPDATE residency SET ended_by = ?, ended_at = ?, end_reason = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), reason, say, id);
        note(store, id, 'ENDED', `${END[reason]}. ${sentence(say)}`, ctx.workerId);
        logged(store, ctx, 'RESIDENCY_END', personId, id, END[reason]);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}

// Called when a death is recorded: the stay ends with it.
export function endForDeath(store: Store, ctx: WorkContext, personId: string) {
  for (const r of store.all<Row>(`SELECT id FROM residency WHERE person_id = ? AND state IN ('LIVING_HERE', 'IN_HOSPITAL')`, personId)) {
    const id = String(r.id);
    transition(store, 'residency', id, 'ENDED', { actorId: ctx.workerId, workContextId: ctx.id }, 'Died');
    store.run("UPDATE residency SET ended_by = ?, ended_at = ?, end_reason = 'DIED', end_note = 'Death recorded' WHERE id = ?", ctx.workerId, now(), id);
    note(store, id, 'ENDED', 'Died. Their death is recorded.', ctx.workerId);
  }
}
