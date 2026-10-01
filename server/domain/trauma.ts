import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, TEAM_CALL, PRIMARY, FOUND_BY, NEXT, REFS } from '../config/trauma.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Major trauma (entry 118):
//   trauma call: how they were injured, when, and what the ambulance found → primary survey
//   (airway, breathing, circulation, disability, exposure) → secondary survey, head to toe →
//   injuries found, and how → where they go next: admitted (a tertiary survey is then due on the
//   ward, to find anything missed), transferred, or home → tertiary survey → complete.
// ED nurses and doctors make the call; ED doctors do the surveys and decide where next; ward
// doctors do the tertiary survey. Ward nurses see it.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
type Op = 'TRAUMA' | 'TRAUMA_MANAGE' | 'TRAUMA_TERTIARY';

const may = (store: Store, ctx: WorkContext, personId: string, op: Op) => evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'trauma_case', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [118],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('trauma_step', { id: newId(), case_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT t.id, t.person_id AS personId, t.state, t.team_call AS teamCall, t.mechanism, t.injured_at AS injuredAt, t.prehospital,
         ab.display_name AS activatedBy, t.activated_at AS activatedAt, t.next, t.next_note AS nextNote, hb.display_name AS nextBy, t.next_at AS nextAt
    FROM trauma_case t
    JOIN workforce_person ab ON ab.id = t.activated_by
    LEFT JOIN workforce_person hb ON hb.id = t.next_by`;

const surveys = (store: Store, id: string) => store.all<Row>(
  `SELECT s.kind, s.airway, s.breathing, s.circulation, s.disability, s.exposure, s.findings, s.actions, w.display_name AS "by", s.at
     FROM trauma_survey s JOIN workforce_person w ON w.id = s.by_id WHERE s.case_id = ? ORDER BY s.at, s.rowid`, id);

function shape(store: Store, r: Row, can: { ed: boolean; tertiary: boolean }): Record<string, any> {
  const state = String(r.state);
  const done = surveys(store, String(r.id));
  const has = (k: string) => done.some((s) => s.kind === k);
  const acts: string[] = [];
  if (state === 'ACTIVE' && can.ed) {
    acts.push(has('PRIMARY') ? 'secondary' : 'primary');
    if (has('PRIMARY')) acts.push('injury');
    if (has('PRIMARY') && has('SECONDARY')) acts.push('next');
  }
  if (state === 'ADMITTED' && can.tertiary) acts.push('injury', 'tertiary');
  const missing = state === 'ACTIVE' ? [!has('PRIMARY') ? 'primary survey' : null, !has('SECONDARY') ? 'secondary survey' : null].filter(Boolean) : [];
  return {
    ...r, state, stateLabel: STATES[state], teamCallLabel: TEAM_CALL[String(r.teamCall)], nextLabel: r.next ? NEXT[String(r.next)] : null,
    surveys: done.map((s): Record<string, any> => ({ ...s, kindLabel: s.kind === 'PRIMARY' ? 'Primary survey' : s.kind === 'SECONDARY' ? 'Secondary survey' : 'Tertiary survey' })),
    injuries: store.all<Row>('SELECT i.injury, i.found_by AS foundBy, w.display_name AS "by", i.at FROM trauma_injury i JOIN workforce_person w ON w.id = i.by_id WHERE i.case_id = ? ORDER BY i.at, i.rowid', String(r.id))
      .map((i): Record<string, any> => ({ ...i, foundByLabel: FOUND_BY[String(i.foundBy)] })),
    missing, acts,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM trauma_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.case_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  if (!['trauma.manage', 'trauma.record', 'trauma.tertiary', 'trauma.view'].some((c) => caps.includes(c))) return null;
  const canCall = may(store, ctx, personId, 'TRAUMA');
  const can = { ed: may(store, ctx, personId, 'TRAUMA_MANAGE'), tertiary: may(store, ctx, personId, 'TRAUMA_TERTIARY') };
  const all = store.all<Row>(`${Q} WHERE t.person_id = ? ORDER BY t.activated_at DESC`, personId).map((r) => shape(store, r, can));
  if (!canCall && !all.length) return null;
  return {
    current: all.filter((x) => x.state !== 'COMPLETE'),
    past: all.filter((x) => x.state === 'COMPLETE'),
    canCall,
    options: { teamCall: TEAM_CALL, primary: PRIMARY, foundBy: FOUND_BY, next: NEXT },
  };
}

// For the record header: a trauma call still in ED, or a tertiary survey due on the ward.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE t.person_id = ? AND t.state IN ('ACTIVE', 'ADMITTED') ORDER BY t.activated_at DESC LIMIT 1`, personId);
  if (!r) return null;
  const kinds = surveys(store, String(r.id)).map((s) => s.kind);
  const missing = r.state === 'ACTIVE' ? (!kinds.includes('PRIMARY') ? 'primary survey not done' : !kinds.includes('SECONDARY') ? 'secondary survey not done' : 'surveys done') : `admitted: ${r.nextNote}`;
  return { state: r.state, teamCall: TEAM_CALL[String(r.teamCall)], mechanism: r.mechanism, missing };
}

interface Body {
  teamCall?: string; mechanism?: string; injuredAt?: string; prehospital?: string;
  airway?: string; breathing?: string; circulation?: string; disability?: string; exposure?: string; findings?: string; actions?: string;
  injury?: string; foundBy?: string; next?: string; note?: string;
}

export function activate(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'TRAUMA', personId }, personId);
  if (store.get("SELECT 1 FROM trauma_case WHERE person_id = ? AND state IN ('ACTIVE', 'ADMITTED')", personId)) throw new HttpError(409, 'ALREADY', 'A trauma call is already open for them.');
  const teamCall = pick(TEAM_CALL, b.teamCall);
  if (!teamCall) throw new HttpError(400, 'CALL_REQUIRED', 'Choose the kind of trauma call.');
  const mechanism = text(b.mechanism, 400);
  if (mechanism.length < 5) throw new HttpError(400, 'MECHANISM_REQUIRED', 'Write how they were injured, e.g. "Motorbike v car, about 60 km/h, helmet on".');
  const injuredAt = text(b.injuredAt, 30);
  if (injuredAt && (!STAMP.test(injuredAt) || Date.parse(injuredAt) > Date.now() + 5 * 60_000)) throw new HttpError(400, 'WHEN', 'Choose when they were injured, or leave it empty if not known.');
  const prehospital = text(b.prehospital, 1000);
  const id = newId();
  store.tx(() => {
    store.insert('trauma_case', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'ACTIVE', team_call: teamCall, mechanism, injured_at: injuredAt ? new Date(injuredAt).toISOString() : null,
      prehospital: prehospital || null, activated_by: ctx.workerId, activated_at: now(),
    });
    recordInitial(store, 'trauma_case', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, mechanism);
    step(store, id, 'CALLED', `${TEAM_CALL[teamCall]}: ${sentence(mechanism)}${prehospital ? ` Ambulance: ${sentence(prehospital)}` : ''}`, ctx.workerId);
    logged(store, ctx, 'TRAUMA_CALL', personId, id, mechanism);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE t.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That trauma call is no longer in SHIFT.');
  const personId = String(r.personId);
  const state = String(r.state);
  const wardWork = action === 'tertiary' || (action === 'injury' && state === 'ADMITTED');
  enforce(store, ctx, { op: wardWork ? 'TRAUMA_TERTIARY' : 'TRAUMA_MANAGE', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const must = (ok: boolean) => { if (!ok) throw new HttpError(409, 'STATE', `This trauma call is ${STATES[state].toLowerCase()}; that cannot be done now.`); };
  const kinds = surveys(store, id).map((s) => s.kind);
  const note = text(b.note, 1000);
  store.tx(() => {
    switch (action) {
      case 'primary': {
        must(state === 'ACTIVE' && !kinds.includes('PRIMARY'));
        const v = Object.fromEntries(Object.keys(PRIMARY).map((k) => [k, text((b as Record<string, unknown>)[k], 600)]));
        const gap = Object.keys(PRIMARY).find((k) => v[k].length < 2);
        if (gap) throw new HttpError(400, 'PRIMARY_REQUIRED', `Write what you found for ${PRIMARY[gap].toLowerCase()}.`);
        const actions = text(b.actions, 1000);
        store.insert('trauma_survey', { id: newId(), case_id: id, kind: 'PRIMARY', ...v, findings: null, actions: actions || null, by_id: ctx.workerId, at: now() });
        step(store, id, 'PRIMARY', `Primary survey. ${Object.keys(PRIMARY).map((k) => `${PRIMARY[k].split(' (')[0]}: ${sentence(v[k])}`).join(' ')}${actions ? ` Done: ${sentence(actions)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'TRAUMA_PRIMARY', personId, id, 'Primary survey');
        break;
      }
      case 'secondary':
      case 'tertiary': {
        if (action === 'secondary') must(state === 'ACTIVE' && kinds.includes('PRIMARY') && !kinds.includes('SECONDARY'));
        else must(state === 'ADMITTED');
        const findings = text(b.findings, 2000);
        if (findings.length < 10) throw new HttpError(400, 'FINDINGS_REQUIRED', 'Write what you found, head to toe, including anything normal that matters.');
        const kind = action.toUpperCase();
        store.insert('trauma_survey', { id: newId(), case_id: id, kind, findings, by_id: ctx.workerId, at: now() });
        step(store, id, kind, `${kind === 'SECONDARY' ? 'Secondary' : 'Tertiary'} survey: ${sentence(findings)}`, ctx.workerId);
        if (action === 'tertiary') {
          transition(store, 'trauma_case', id, 'COMPLETE', who, 'Tertiary survey done');
          step(store, id, 'COMPLETE', 'Complete.', ctx.workerId);
        }
        logged(store, ctx, `TRAUMA_${kind}`, personId, id, findings);
        break;
      }
      case 'injury': {
        must(state === 'ACTIVE' || state === 'ADMITTED');
        const injury = text(b.injury, 300);
        if (injury.length < 3) throw new HttpError(400, 'INJURY_REQUIRED', 'Write the injury, e.g. "Fractured left femur".');
        const foundBy = pick(FOUND_BY, b.foundBy);
        if (!foundBy) throw new HttpError(400, 'FOUND_BY_REQUIRED', 'Choose how it was found.');
        store.insert('trauma_injury', { id: newId(), case_id: id, injury, found_by: foundBy, by_id: ctx.workerId, at: now() });
        step(store, id, 'INJURY', `Injury (${FOUND_BY[foundBy].toLowerCase()}): ${sentence(injury)}`, ctx.workerId);
        logged(store, ctx, 'TRAUMA_INJURY', personId, id, injury);
        break;
      }
      case 'next': {
        must(state === 'ACTIVE');
        if (!kinds.includes('PRIMARY') || !kinds.includes('SECONDARY')) throw new HttpError(409, 'SURVEYS', 'Record the primary and secondary surveys first.');
        const next = pick(NEXT, b.next);
        if (!next) throw new HttpError(400, 'NEXT_REQUIRED', 'Choose where they go next.');
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', next === 'HOME' ? 'Write the advice and follow-up given.' : 'Write which team or hospital, and who accepted them.');
        transition(store, 'trauma_case', id, next === 'ADMITTED' ? 'ADMITTED' : 'COMPLETE', who, NEXT[next]);
        store.run('UPDATE trauma_case SET next = ?, next_note = ?, next_by = ?, next_at = ? WHERE id = ?', next, note, ctx.workerId, now(), id);
        step(store, id, 'NEXT', `${NEXT[next]}: ${sentence(note)}${next === 'ADMITTED' ? ' Tertiary survey due on the ward.' : ''}`, ctx.workerId);
        logged(store, ctx, 'TRAUMA_NEXT', personId, id, NEXT[next]);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
