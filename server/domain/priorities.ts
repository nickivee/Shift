import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { SCALES, SERVICE_SCALE, SOURCES } from '../config/priorities.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Clinical Priority / Triage (Shared Lifecycle Object 300):
//   request/presentation → triage evidence → priority assigned → timeframe → reassessment →
//   changed priority → service action.
// A clinician assigns a priority on the service's own scale from the evidence in front of them; SHIFT
// never assigns one itself. The timeframe sets when the person must be seen or acted on. Anyone
// caring for them can reassess and make it more urgent; making it less urgent needs a senior and a
// reason. The service action (seen, reviewed, treated) closes it and shows whether the timeframe was met.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = { WAITING: 'Waiting', ACTIONED: 'Seen and acted on', CANCELLED: 'Cancelled', ENTERED_IN_ERROR: 'Entered in error' };
const OPEN = ['WAITING'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-TRIAGE-001'];

const Q = `
  SELECT q.id, q.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = q.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         q.service_id AS serviceId, s.name AS service, q.scale, q.source, q.what, q.evidence, q.level, q.level_at AS levelAt, q.due_at AS dueAt, q.state,
         ab.display_name AS assignedBy, q.assigned_by AS assignedById, q.assigned_at AS assignedAt,
         xb.display_name AS actedBy, q.acted_at AS actedAt, q.action_note AS actionNote,
         eb.display_name AS endedBy, q.ended_at AS endedAt, q.ended_note AS endedNote
    FROM priority q
    JOIN person p ON p.id = q.person_id
    JOIN service s ON s.id = q.service_id
    JOIN workforce_person ab ON ab.id = q.assigned_by
    LEFT JOIN workforce_person xb ON xb.id = q.acted_by
    LEFT JOIN workforce_person eb ON eb.id = q.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'PRIORITY', personId }).decision === 'ALLOW';
const senior = (ctx: WorkContext) => ctx.role.capabilities.includes('priority.downgrade');
export const scaleFor = (serviceId: string) => SERVICE_SCALE[serviceId] ?? 'WARD';
const levels = (scale: string) => SCALES[scale].levels;
const rank = (scale: string, level: string) => levels(scale).findIndex(([c]) => c === level);
const labelOf = (scale: string, level: string) => levels(scale).find(([c]) => c === level)?.[1] ?? level;
const dueFrom = (scale: string, level: string, from = Date.now()) => new Date(from + levels(scale)[rank(scale, level)][2] * 60_000).toISOString();

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'priority', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const log = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('priority_log', { id: newId(), priority_id: id, kind, body, by_id: ctx.workerId, at: now() });
const LOG_LABELS: Record<string, string> = {
  ASSIGNED: 'Priority assigned', REASSESSED: 'Reassessed', UPGRADED: 'Made more urgent', DOWNGRADED: 'Made less urgent', ACTIONED: 'Seen and acted on',
  CANCELLED: 'Cancelled', ERROR: 'Entered in error',
};

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const scale = String(r.scale);
  const level = String(r.level);
  const due = Date.parse(String(r.dueAt));
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId && state === 'WAITING') {
    actions.push('act', 'reassess', 'cancel');
    if (senior(ctx) || r.assignedById === ctx.workerId) actions.push('error');
  }
  return {
    ...r, id, state, scale, level, stateLabel: STATES[state], scaleLabel: SCALES[scale]?.label ?? scale, levelLabel: labelOf(scale, level), rank: rank(scale, level),
    sourceLabel: SOURCES[String(r.source)] ?? String(r.source), dueAt: String(r.dueAt),
    overdue: state === 'WAITING' && due < Date.now(),
    minutesLeft: state === 'WAITING' ? Math.round((due - Date.now()) / 60_000) : null,
    metTimeframe: state === 'ACTIONED' ? Date.parse(String(r.actedAt)) <= due : null,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM priority_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.priority_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'priority', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE q.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That priority is no longer in SHIFT.');
  return r;
};

export function assign(store: Store, ctx: WorkContext, personId: string, b: { source?: string; what?: string; evidence?: string; level?: string }) {
  enforce(store, ctx, { op: 'PRIORITY', personId }, personId);
  const scale = scaleFor(ctx.serviceId);
  const source = SOURCES[String(b.source)] ? String(b.source) : '';
  if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose how this came to you.');
  const what = text(b.what, 300);
  if (what.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Write what the request or presentation is, e.g. "Central chest pain for 2 hours".');
  const evidence = text(b.evidence, 1500);
  if (evidence.length < 10) throw new HttpError(400, 'EVIDENCE_REQUIRED', 'Write the evidence for the priority, e.g. "HR 110, BP 92/60, sweaty, pain 8/10".');
  const level = String(b.level ?? '');
  if (rank(scale, level) < 0) throw new HttpError(400, 'LEVEL_REQUIRED', `Choose a priority on the ${SCALES[scale].label}.`);
  const open = store.get("SELECT 1 FROM priority WHERE person_id = ? AND service_id = ? AND state = 'WAITING' AND what = ?", personId, ctx.serviceId, what);
  if (open) throw new HttpError(409, 'ALREADY_OPEN', 'This already has a priority waiting. Reassess that one instead.');
  store.tx(() => {
    const id = newId();
    const at = now();
    store.insert('priority', {
      id, person_id: personId, service_id: ctx.serviceId, scale, source, what, evidence, level, level_at: at, due_at: dueFrom(scale, level),
      state: 'WAITING', assigned_by: ctx.workerId, assigned_at: at,
    });
    recordInitial(store, 'priority', id, 'WAITING', { actorId: ctx.workerId, workContextId: ctx.id }, `${level}: ${what}`.slice(0, 200));
    log(store, ctx, id, 'ASSIGNED', `${labelOf(scale, level)}. ${SOURCES[source]}: ${what}. Evidence: ${evidence}`);
    logged(store, ctx, 'PRIORITY_ASSIGN', personId, id, level);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { level?: string; evidence?: string; note?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const scale = String(r.scale);
  enforce(store, ctx, { op: 'PRIORITY', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This priority belongs to ${r.service}.`);
  if (!OPEN.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This priority is ${STATES[state].toLowerCase()}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  switch (action) {
    case 'reassess': {
      const level = String(b.level ?? '');
      if (rank(scale, level) < 0) throw new HttpError(400, 'LEVEL_REQUIRED', 'Choose the priority now.');
      const evidence = text(b.evidence, 1500);
      if (evidence.length < 10) throw new HttpError(400, 'EVIDENCE_REQUIRED', 'Write what you found, e.g. "Pain now 3/10 after analgesia; obs normal".');
      const before = rank(scale, String(r.level));
      const after = rank(scale, level);
      const kind = after < before ? 'UPGRADED' : after > before ? 'DOWNGRADED' : 'REASSESSED';
      if (kind === 'DOWNGRADED') {
        if (!senior(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot make a priority less urgent. Ask a senior clinician.`);
        need(10, 'Say why it can be less urgent.');
      }
      // A changed priority runs its timeframe from now, but never later than the original when made more urgent.
      const due = kind === 'REASSESSED' ? String(r.dueAt) : kind === 'UPGRADED' ? [dueFrom(scale, level), String(r.dueAt)].sort()[0] : dueFrom(scale, level);
      store.tx(() => {
        store.run('UPDATE priority SET level = ?, level_at = ?, due_at = ?, evidence = ? WHERE id = ?', level, at, due, evidence, id);
        log(store, ctx, id, kind, `${kind === 'REASSESSED' ? `Still ${labelOf(scale, level)}` : `${labelOf(scale, String(r.level))} to ${labelOf(scale, level)}`}. ${evidence}${note ? ` ${note}` : ''}`);
        logged(store, ctx, `PRIORITY_${kind}`, personId, id, `${r.level} to ${level}`);
      });
      break;
    }
    case 'act': {
      need(5, 'Write what was done, e.g. "Seen by Dr Singh; ECG done".');
      store.tx(() => {
        transition(store, 'priority', id, 'ACTIONED', who, note.slice(0, 200));
        store.run('UPDATE priority SET acted_by = ?, acted_at = ?, action_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        const met = Date.parse(at) <= Date.parse(String(r.dueAt));
        log(store, ctx, id, 'ACTIONED', `${note} ${met ? 'Within the timeframe.' : 'Later than the timeframe.'}`);
        logged(store, ctx, 'PRIORITY_ACTIONED', personId, id, met ? 'MET' : 'NOT_MET');
      });
      break;
    }
    case 'cancel':
    case 'error': {
      if (action === 'error' && !senior(ctx) && r.assignedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who assigned it, or a senior clinician, can mark it as an error.');
      need(action === 'error' ? 10 : 5, action === 'error' ? 'Write why this was entered in error, e.g. "Assigned to the wrong person".' : 'Say why it is cancelled, e.g. "Left before being seen".');
      store.tx(() => {
        transition(store, 'priority', id, action === 'error' ? 'ENTERED_IN_ERROR' : 'CANCELLED', who, note.slice(0, 200));
        store.run('UPDATE priority SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, ctx, id, action === 'error' ? 'ERROR' : 'CANCELLED', note);
        logged(store, ctx, action === 'error' ? 'PRIORITY_ERROR' : 'PRIORITY_CANCEL', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

const options = (ctx: WorkContext) => {
  const scale = scaleFor(ctx.serviceId);
  return { scale, scaleLabel: SCALES[scale].label, levels: levels(scale).map(([code, label]) => [code, label]), sources: SOURCES };
};

// The person's Priority view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE q.person_id = ? ORDER BY q.assigned_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canAssign: can,
    canDowngrade: senior(ctx),
    options: options(ctx),
  };
}

// Home → Priorities for this service: most urgent and soonest due first.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('priority.assign')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include priorities`);
  const rows = store.all<Row>(`${Q} WHERE q.service_id = ? AND q.state = 'WAITING' ORDER BY q.due_at`, ctx.serviceId).map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_PRIORITIES', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    overdue: rows.filter((x) => x.overdue),
    waiting: rows.filter((x) => !x.overdue),
    options: options(ctx),
  };
}
