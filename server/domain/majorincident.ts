import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { register } from './identitymatch.ts';
import { SERVICES, LEVELS, STATES, PRIORITY, REFS } from '../config/majorincident.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Major incident (entry 151): declared → active → casualties registered and prioritised →
// stood down → debrief. Lives on the Emergency Department's Arrivals screen.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext) => evaluate(store, ctx, { op: 'MAJOR_INCIDENT', serviceId: ctx.serviceId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, id: string, reason?: string, personId?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'major_incident', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS, engines: [151],
  });
}
const step = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('major_incident_step', { id: newId(), incident_id: id, kind, body, by_id: ctx.workerId, at: now() });

const Q = `SELECT i.id, i.title, i.expected, i.state, i.declared_at AS declaredAt, db.display_name AS declaredBy, i.activated_at AS activatedAt,
                  i.stood_down_at AS stoodDownAt, sb.display_name AS stoodDownBy, i.stand_down_note AS standDownNote, i.debrief, i.closed_at AS closedAt
             FROM major_incident i JOIN workforce_person db ON db.id = i.declared_by LEFT JOIN workforce_person sb ON sb.id = i.stood_down_by`;

function casualties(store: Store, id: string) {
  return store.all<Row>(
    `SELECT c.id, c.person_id AS personId, c.number, c.priority, c.arrived_at AS arrivedAt, c.triaged_at AS triagedAt, tb.display_name AS triagedBy,
            p.given_name || ' ' || p.family_name AS name,
            (SELECT location FROM encounter e WHERE e.person_id = c.person_id ORDER BY e.started_at DESC LIMIT 1) AS location,
            (SELECT state FROM encounter e WHERE e.person_id = c.person_id ORDER BY e.started_at DESC LIMIT 1) AS stay
       FROM major_incident_casualty c JOIN person p ON p.id = c.person_id JOIN workforce_person tb ON tb.id = c.triaged_by
      WHERE c.incident_id = ? ORDER BY c.number`, id,
  ).map((c): Record<string, any> => ({ ...c, priorityLabel: PRIORITY[String(c.priority)], left: c.stay !== 'ACTIVE' }));
}

function shape(store: Store, ctx: WorkContext, r: Row, canManage: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const list = casualties(store, id);
  const counts = Object.fromEntries(Object.keys(PRIORITY).map((k) => [k, list.filter((c) => c.priority === k).length]));
  const can: string[] = [];
  if (canManage) {
    if (state === 'STANDBY') can.push('activate', 'standdown');
    if (state === 'ACTIVE') can.push('casualty', 'add', 'retriage', 'standdown');
    if (state === 'STOOD_DOWN') can.push('close');
  }
  return {
    ...r, id, state, stateLabel: STATES[state], casualties: list, counts, can,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM major_incident_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.incident_id = ? ORDER BY s.at, s.rowid`, id),
  };
}

// Arrivals screen: the incident in progress (or waiting for its debrief), and ED patients who
// could be added as casualties.
export function board(store: Store, ctx: WorkContext) {
  if (!SERVICES.includes(ctx.serviceId)) return null;
  const canManage = may(store, ctx);
  const r = store.get<Row>(`${Q} WHERE i.service_id = ? AND i.state != 'CLOSED' ORDER BY i.declared_at DESC LIMIT 1`, ctx.serviceId);
  const incident = r ? shape(store, ctx, r, canManage) : null;
  const here = incident && incident.state === 'ACTIVE'
    ? store.all<Row>(`SELECT p.id AS personId, p.given_name || ' ' || p.family_name AS name, e.location FROM encounter e JOIN person p ON p.id = e.person_id
        WHERE e.service_id = ? AND e.state = 'ACTIVE' AND p.id NOT IN (SELECT person_id FROM major_incident_casualty WHERE incident_id = ?) ORDER BY p.family_name`, ctx.serviceId, incident.id)
    : [];
  return { incident, here, canManage, canDeclare: canManage && !incident, options: { levels: LEVELS, priority: PRIORITY } };
}

// For the record header.
export function current(store: Store, personId: string) {
  const c = store.get<Row>(
    `SELECT c.number, c.priority, i.title FROM major_incident_casualty c JOIN major_incident i ON i.id = c.incident_id
      WHERE c.person_id = ? AND i.state IN ('ACTIVE', 'STOOD_DOWN') ORDER BY c.arrived_at DESC LIMIT 1`, personId,
  );
  return c ? { ...c, priorityLabel: PRIORITY[String(c.priority)] } : null;
}

export function declare(store: Store, ctx: WorkContext, b: { title?: string; expected?: string; level?: string }) {
  enforce(store, ctx, { op: 'MAJOR_INCIDENT', serviceId: ctx.serviceId });
  if (!SERVICES.includes(ctx.serviceId)) throw new HttpError(403, 'BLOCK', 'Major incidents are declared in the Emergency Department.');
  if (store.get("SELECT 1 FROM major_incident WHERE service_id = ? AND state != 'CLOSED'", ctx.serviceId)) throw new HttpError(409, 'ALREADY', 'A major incident is already declared. Close it before declaring another.');
  const title = text(b.title, 300);
  if (title.length < 5) throw new HttpError(400, 'TITLE_REQUIRED', 'Say what has happened, e.g. "Bus crash on State Highway 1 at Pukerua Bay".');
  const level = LEVELS[String(b.level)] ? String(b.level) : '';
  if (!level) throw new HttpError(400, 'LEVEL_REQUIRED', 'Choose standby or active.');
  const expected = Math.max(0, Math.min(500, Number(b.expected) || 0)) || null;
  const id = newId();
  const at = now();
  store.tx(() => {
    store.insert('major_incident', { id, service_id: ctx.serviceId, title, expected, state: level, declared_by: ctx.workerId, declared_at: at, activated_at: level === 'ACTIVE' ? at : null });
    recordInitial(store, 'major_incident', id, level, { actorId: ctx.workerId, workContextId: ctx.id }, title);
    step(store, ctx, id, 'DECLARED', `${LEVELS[level]}. ${title}${expected ? `. About ${expected} casualties expected.` : ''}`);
    logged(store, ctx, 'MAJOR_INCIDENT_DECLARE', id, title);
  });
  return board(store, ctx);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Record<string, string | undefined>) {
  enforce(store, ctx, { op: 'MAJOR_INCIDENT', serviceId: ctx.serviceId });
  const r = store.get<Row>(`${Q} WHERE i.id = ? AND i.service_id = ?`, id, ctx.serviceId);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That major incident is not in your service.');
  const state = String(r.state);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const need = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This major incident is ${STATES[state].toLowerCase()}.`); };
  const priorityOf = () => {
    const p = PRIORITY[String(b.priority)] ? String(b.priority) : '';
    if (!p) throw new HttpError(400, 'PRIORITY_REQUIRED', 'Choose their priority.');
    return p;
  };
  const addCasualty = (personId: string, priority: string) => {
    const n = store.get<{ n: number }>('SELECT count(*) AS n FROM major_incident_casualty WHERE incident_id = ?', id)!.n + 1;
    const number = `MI-${String(n).padStart(2, '0')}`;
    store.insert('major_incident_casualty', { id: newId(), incident_id: id, person_id: personId, number, priority, arrived_at: at, triaged_by: ctx.workerId, triaged_at: at });
    store.insert('major_incident_triage', { id: newId(), incident_id: id, person_id: personId, priority, note: null, by_id: ctx.workerId, at });
    return number;
  };
  switch (action) {
    case 'activate':
      need('STANDBY');
      store.tx(() => {
        transition(store, 'major_incident', id, 'ACTIVE', who, 'Activated');
        store.run('UPDATE major_incident SET activated_at = ? WHERE id = ?', at, id);
        step(store, ctx, id, 'ACTIVATED', 'Active: casualties coming.');
        logged(store, ctx, 'MAJOR_INCIDENT_ACTIVATE', id);
      });
      break;
    case 'casualty': {
      need('ACTIVE');
      const priority = priorityOf();
      const description = text(b.description, 500);
      if (description.length < 5) throw new HttpError(400, 'DESCRIPTION_REQUIRED', 'Describe them so they can be told apart, e.g. "Woman about 30, red jacket, leg injury".');
      store.tx(() => {
        const reg = register(store, ctx, { decision: 'UNKNOWN', source: 'AMBULANCE', description: `Major incident casualty. ${description}`, gender: b.gender ?? 'UNKNOWN', location: b.location ?? '' });
        const number = addCasualty(reg.personId, priority);
        step(store, ctx, id, 'CASUALTY', `${number}: ${PRIORITY[priority]}. ${description}`);
        logged(store, ctx, 'MAJOR_INCIDENT_CASUALTY', id, PRIORITY[priority], reg.personId);
      });
      break;
    }
    case 'add': {
      need('ACTIVE');
      const priority = priorityOf();
      const personId = b.personId ?? '';
      if (!store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId)) throw new HttpError(404, 'NOT_HERE', 'Choose someone who is in the department now.');
      if (store.get('SELECT 1 FROM major_incident_casualty WHERE incident_id = ? AND person_id = ?', id, personId)) throw new HttpError(409, 'ALREADY', 'They are already a casualty of this incident.');
      store.tx(() => {
        const number = addCasualty(personId, priority);
        step(store, ctx, id, 'CASUALTY', `${number}: ${PRIORITY[priority]}. Already registered in the department.`);
        logged(store, ctx, 'MAJOR_INCIDENT_CASUALTY', id, PRIORITY[priority], personId);
      });
      break;
    }
    case 'retriage': {
      need('ACTIVE');
      const priority = priorityOf();
      const c = store.get<Row>('SELECT * FROM major_incident_casualty WHERE id = ? AND incident_id = ?', b.casualtyId ?? '', id);
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'That casualty is not part of this incident.');
      if (c.priority === priority) throw new HttpError(409, 'SAME', `They are already ${PRIORITY[priority].toLowerCase()}.`);
      const note = text(b.note, 500);
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what changed, e.g. "Now drowsy, GCS 12".');
      store.tx(() => {
        store.run('UPDATE major_incident_casualty SET priority = ?, triaged_by = ?, triaged_at = ? WHERE id = ?', priority, ctx.workerId, at, c.id);
        store.insert('major_incident_triage', { id: newId(), incident_id: id, person_id: c.person_id, priority, note, by_id: ctx.workerId, at });
        step(store, ctx, id, 'RETRIAGE', `${c.number}: ${PRIORITY[String(c.priority)]} to ${PRIORITY[priority]}. ${note}`);
        logged(store, ctx, 'MAJOR_INCIDENT_RETRIAGE', id, PRIORITY[priority], String(c.person_id));
      });
      break;
    }
    case 'standdown': {
      need('STANDBY', 'ACTIVE');
      const note = text(b.note, 1000);
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why it is being stood down, e.g. "Last casualty arrived; scene cleared by ambulance control".');
      store.tx(() => {
        transition(store, 'major_incident', id, 'STOOD_DOWN', who, note.slice(0, 200));
        store.run('UPDATE major_incident SET stood_down_by = ?, stood_down_at = ?, stand_down_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        step(store, ctx, id, 'STOOD_DOWN', note);
        logged(store, ctx, 'MAJOR_INCIDENT_STAND_DOWN', id, note.slice(0, 200));
      });
      break;
    }
    case 'close': {
      need('STOOD_DOWN');
      const debrief = text(b.note);
      if (debrief.length < 10) throw new HttpError(400, 'DEBRIEF_REQUIRED', 'Write what the debrief found: what worked and what to change.');
      store.tx(() => {
        transition(store, 'major_incident', id, 'CLOSED', who, 'Debrief recorded');
        store.run('UPDATE major_incident SET debrief = ?, closed_by = ?, closed_at = ? WHERE id = ?', debrief, ctx.workerId, at, id);
        step(store, ctx, id, 'CLOSED', `Debrief: ${debrief}`);
        logged(store, ctx, 'MAJOR_INCIDENT_CLOSE', id);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return board(store, ctx);
}
