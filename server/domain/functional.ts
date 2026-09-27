import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ACTIVITIES, LEVELS, ACTIVITY_BY_ID, LEVEL_BY_ID } from '../config/function.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Functional status (Shared Lifecycle Object 261):
//   baseline → current assessment → assistance requirement → intervention → reassessment →
//   changed/current state.
// The baseline is how they usually manage, from them, their whānau or earlier records. A current
// assessment gives the help they need now for each activity and when to look again. Comparing the
// two shows what has changed; what is being done about it is planned, put in place and stopped
// with an outcome. The help they need now shows at the top of their record for everyone caring
// for them.

type Row = Record<string, string | number | null>;
interface Entry { level: string; aid: string | null; note: string | null }
const SOURCES: Record<string, string> = {
  PERSON: 'The person themselves', WHANAU: 'Whānau or support person', PRIOR_RECORD: 'An earlier record or referral', STAFF: 'Staff who know them well',
};
const NAMED = ['WHANAU', 'PRIOR_RECORD'];
const KINDS: Record<string, string> = { BASELINE: 'Usual function', CURRENT: 'Function now' };
const STATES: Record<string, string> = { CURRENT: 'In use', SUPERSEDED: 'Replaced', ENTERED_IN_ERROR: 'Entered in error' };
const PLAN_STATES: Record<string, string> = { PLANNED: 'Planned', IN_PLACE: 'In place', STOPPED: 'Stopped' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-INSTR-001'];

const ASSESSMENT = `
  SELECT a.id, a.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = a.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         s.name AS service, a.kind, a.state, a.source, a.source_name AS sourceName, a.entries_json AS entriesJson, a.summary,
         ab.display_name AS assessedBy, a.assessed_at AS assessedAt, a.review_due AS reviewDue, a.supersedes, a.error_reason AS errorReason
    FROM function_assessment a
    JOIN person p ON p.id = a.person_id
    JOIN service s ON s.id = a.service_id
    JOIN workforce_person ab ON ab.id = a.assessed_by`;

const PLAN = `
  SELECT i.id, i.person_id AS personId, i.activity, i.what, i.state, pb.display_name AS plannedBy, i.planned_at AS plannedAt,
         sb.display_name AS startedBy, i.started_at AS startedAt, xb.display_name AS stoppedBy, i.stopped_at AS stoppedAt, i.outcome
    FROM function_intervention i
    JOIN workforce_person pb ON pb.id = i.planned_by
    LEFT JOIN workforce_person sb ON sb.id = i.started_by
    LEFT JOIN workforce_person xb ON xb.id = i.stopped_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'FUNCTION', personId }).decision === 'ALLOW';
const options = () => ({
  activities: ACTIVITIES, levels: LEVELS.map(({ id, label }) => ({ id, label })), sources: SOURCES, kinds: KINDS,
});

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, objectType: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const entriesOf = (r: Row | null | undefined): Record<string, Entry> => (r?.entriesJson ? JSON.parse(String(r.entriesJson)) : {});
const describe = (activity: string, e: Entry) =>
  `${ACTIVITY_BY_ID.get(activity)?.label ?? activity}: ${(LEVEL_BY_ID.get(e.level)?.label ?? e.level).toLowerCase()}${e.aid ? `, ${e.aid.toLowerCase()}` : ''}`;

function shape(store: Store, r: Row, canAssess: boolean) {
  const entries = entriesOf(r);
  const actions: string[] = [];
  if (canAssess && r.state === 'CURRENT') actions.push('error');
  const { entriesJson: _e, ...rest } = r;
  return {
    ...rest, state: String(r.state), kindLabel: KINDS[String(r.kind)], stateLabel: STATES[String(r.state)], sourceLabel: r.source ? SOURCES[String(r.source)] : null,
    overdue: r.kind === 'CURRENT' && r.state === 'CURRENT' && !!r.reviewDue && String(r.reviewDue) < now(),
    entries: ACTIVITIES.filter((a) => entries[a.id]).map((a) => ({
      activity: a.id, activityLabel: a.label, level: entries[a.id].level, levelLabel: LEVEL_BY_ID.get(entries[a.id].level)?.label ?? entries[a.id].level,
      aid: entries[a.id].aid, note: entries[a.id].note,
    })),
    actions, history: history(store, 'function', String(r.id)),
  };
}

function shapePlan(store: Store, r: Row, canAssess: boolean) {
  const actions: string[] = [];
  if (canAssess && r.state === 'PLANNED') actions.push('start', 'stop');
  if (canAssess && r.state === 'IN_PLACE') actions.push('stop');
  return {
    ...r, state: String(r.state), activity: String(r.activity), what: String(r.what), activityLabel: ACTIVITY_BY_ID.get(String(r.activity))?.label ?? String(r.activity), stateLabel: PLAN_STATES[String(r.state)],
    actions, history: history(store, 'functionplan', String(r.id)),
  };
}

const inForce = (store: Store, personId: string, kind: string) =>
  store.get<Row>(`${ASSESSMENT} WHERE a.person_id = ? AND a.kind = ? AND a.state = 'CURRENT' ORDER BY a.assessed_at DESC LIMIT 1`, personId, kind);
const openPlans = (store: Store, personId: string) =>
  store.all<Row>(`${PLAN} WHERE i.person_id = ? AND i.state != 'STOPPED' ORDER BY i.planned_at`, personId);

// Worse, better or the same as usual, activity by activity. Unknown when either is missing or not being done.
function compare(baseline: Record<string, Entry>, current: Record<string, Entry>, activity: string) {
  const b = baseline[activity] ? LEVEL_BY_ID.get(baseline[activity].level)?.rank : null;
  const c = current[activity] ? LEVEL_BY_ID.get(current[activity].level)?.rank : null;
  if (b === null || b === undefined || c === null || c === undefined) return null;
  return c > b ? 'WORSE' : c < b ? 'BETTER' : 'SAME';
}

// Activities worse than usual with nothing planned or in place for them.
function unplanned(store: Store, personId: string) {
  const base = inForce(store, personId, 'BASELINE');
  const cur = inForce(store, personId, 'CURRENT');
  if (!base || !cur) return [];
  const b = entriesOf(base);
  const c = entriesOf(cur);
  const planned = new Set(openPlans(store, personId).map((p) => String(p.activity)));
  return ACTIVITIES.filter((a) => compare(b, c, a.id) === 'WORSE' && !planned.has(a.id)).map((a) => a.label);
}

export function assess(store: Store, ctx: WorkContext, personId: string,
  b: { kind?: string; source?: string; sourceName?: string; entries?: Record<string, unknown>; summary?: string; reviewDays?: string | number }) {
  enforce(store, ctx, { op: 'FUNCTION', personId }, personId);
  const kind = b.kind === 'BASELINE' ? 'BASELINE' : b.kind === 'CURRENT' ? 'CURRENT' : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose whether this is how they usually manage or how they are now.');
  const raw = b.entries && typeof b.entries === 'object' ? b.entries : {};
  const entries: Record<string, Entry> = {};
  for (const a of ACTIVITIES) {
    const e = raw[a.id] as Record<string, unknown> | undefined;
    if (!e || !e.level) continue;
    const level = LEVEL_BY_ID.get(String(e.level));
    if (!level) throw new HttpError(400, 'LEVEL_INVALID', `Choose a level of help for ${a.label.toLowerCase()}.`);
    const note = text(e.note, 300) || null;
    if (level.id === 'NOT_DOING' && !note) throw new HttpError(400, 'NOTE_REQUIRED', `Write why they are not ${a.label.toLowerCase()} at present, e.g. "bed rest after surgery".`);
    entries[a.id] = { level: level.id, aid: text(e.aid, 60) || null, note };
  }
  const missing = ACTIVITIES.filter((a) => !entries[a.id]);
  if (kind === 'CURRENT' && missing.length) throw new HttpError(400, 'INCOMPLETE', `Give a level for every activity. Missing: ${missing.map((a) => a.label.toLowerCase()).join(', ')}.`);
  if (kind === 'BASELINE' && !Object.keys(entries).length) throw new HttpError(400, 'INCOMPLETE', 'Give a level for at least one activity you know about.');
  let source: string | null = null;
  let sourceName: string | null = null;
  if (kind === 'BASELINE') {
    source = SOURCES[String(b.source)] ? String(b.source) : '';
    if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose where you learned how they usually manage.');
    sourceName = text(b.sourceName, 200) || null;
    if (NAMED.includes(source) && (sourceName ?? '').length < 3) {
      throw new HttpError(400, 'SOURCE_NAME_REQUIRED', source === 'WHANAU' ? 'Write who told you, and how they are related.' : 'Write which record or referral, and its date.');
    }
  }
  let reviewDue: string | null = null;
  if (kind === 'CURRENT') {
    const days = Number(b.reviewDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'REVIEW_RANGE', 'Reassess in 1 to 90 days.');
    reviewDue = new Date(Date.now() + days * 24 * 3600_000).toISOString();
  }
  const prior = inForce(store, personId, kind);
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('function_assessment', {
      id, person_id: personId, service_id: ctx.serviceId, kind, state: 'CURRENT', source, source_name: sourceName, entries_json: JSON.stringify(entries),
      summary: text(b.summary, 1000) || null, assessed_by: ctx.workerId, assessed_at: now(), review_due: reviewDue, supersedes: prior ? String(prior.id) : null,
    });
    recordInitial(store, 'function', id, 'CURRENT', who, `${KINDS[kind]} recorded`);
    if (prior) transition(store, 'function', String(prior.id), 'SUPERSEDED', who, kind === 'CURRENT' ? 'Reassessed' : 'Usual function updated');
    logged(store, ctx, kind === 'CURRENT' ? 'FUNCTION_ASSESS' : 'FUNCTION_BASELINE', personId, 'function_assessment', id,
      Object.entries(entries).map(([a, e]) => describe(a, e)).join('; ').slice(0, 500));
  });
  return forPerson(store, ctx, personId);
}

export function markError(store: Store, ctx: WorkContext, id: string, b: { reason?: string }) {
  const r = store.get<Row>(`${ASSESSMENT} WHERE a.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That assessment is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'FUNCTION', personId }, personId);
  if (r.state !== 'CURRENT') throw new HttpError(409, 'WRONG_STATE', 'Only the assessment in use can be marked as entered in error.');
  const reason = text(b.reason, 500);
  if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Write what was wrong, e.g. "recorded on the wrong person".');
  store.tx(() => {
    transition(store, 'function', id, 'ENTERED_IN_ERROR', { actorId: ctx.workerId, workContextId: ctx.id }, reason);
    store.run('UPDATE function_assessment SET error_reason = ? WHERE id = ?', reason, id);
    logged(store, ctx, 'FUNCTION_ERROR', personId, 'function_assessment', id, reason);
  });
  return forPerson(store, ctx, personId);
}

export function plan(store: Store, ctx: WorkContext, personId: string, b: { activity?: string; what?: string }) {
  enforce(store, ctx, { op: 'FUNCTION', personId }, personId);
  const activity = ACTIVITY_BY_ID.get(String(b.activity));
  if (!activity) throw new HttpError(400, 'ACTIVITY_REQUIRED', 'Choose which activity it is for.');
  const what = text(b.what, 500);
  if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Write what will be done, e.g. "Physio to walk with frame twice a day".');
  const id = newId();
  store.tx(() => {
    store.insert('function_intervention', {
      id, person_id: personId, service_id: ctx.serviceId, activity: activity.id, what, state: 'PLANNED', planned_by: ctx.workerId, planned_at: now(),
    });
    recordInitial(store, 'functionplan', id, 'PLANNED', { actorId: ctx.workerId, workContextId: ctx.id }, `${activity.label}: ${what}`);
    logged(store, ctx, 'FUNCTION_PLAN', personId, 'function_intervention', id, `${activity.label}: ${what}`);
  });
  return forPerson(store, ctx, personId);
}

export function actPlan(store: Store, ctx: WorkContext, id: string, action: string, b: { outcome?: string }) {
  const r = store.get<Row>(`${PLAN} WHERE i.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That plan is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'FUNCTION', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  switch (action) {
    case 'start':
      if (r.state !== 'PLANNED') throw new HttpError(409, 'WRONG_STATE', 'This is already in place or stopped.');
      store.tx(() => {
        transition(store, 'functionplan', id, 'IN_PLACE', who, 'Put in place');
        store.run('UPDATE function_intervention SET started_by = ?, started_at = ? WHERE id = ?', ctx.workerId, at, id);
        logged(store, ctx, 'FUNCTION_PLAN_START', personId, 'function_intervention', id);
      });
      break;
    case 'stop': {
      if (r.state === 'STOPPED') throw new HttpError(409, 'WRONG_STATE', 'This has already stopped.');
      const outcome = text(b.outcome, 500);
      if (outcome.length < 5) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Write how it went, e.g. "Now walking the corridor with frame on their own".');
      store.tx(() => {
        transition(store, 'functionplan', id, 'STOPPED', who, outcome);
        store.run('UPDATE function_intervention SET stopped_by = ?, stopped_at = ?, outcome = ? WHERE id = ?', ctx.workerId, at, outcome, id);
        logged(store, ctx, 'FUNCTION_PLAN_STOP', personId, 'function_intervention', id, outcome);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Function view: usual against now for each activity, what is being done, and earlier assessments.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canAssess = may(store, ctx, personId);
  const base = inForce(store, personId, 'BASELINE');
  const cur = inForce(store, personId, 'CURRENT');
  const b = entriesOf(base);
  const c = entriesOf(cur);
  const plans = store.all<Row>(`${PLAN} WHERE i.person_id = ? ORDER BY i.planned_at DESC`, personId).map((r) => shapePlan(store, r, canAssess));
  const open = plans.filter((p) => p.state !== 'STOPPED');
  const rows = ACTIVITIES.map((a) => ({
    activity: a.id, label: a.label,
    usual: b[a.id] ? { ...b[a.id], label: LEVEL_BY_ID.get(b[a.id].level)?.label } : null,
    now: c[a.id] ? { ...c[a.id], label: LEVEL_BY_ID.get(c[a.id].level)?.label } : null,
    change: compare(b, c, a.id),
    plans: open.filter((p) => p.activity === a.id).map((p) => ({ what: p.what, stateLabel: p.stateLabel })),
  }));
  const earlier = store.all<Row>(`${ASSESSMENT} WHERE a.person_id = ? AND a.state != 'CURRENT' ORDER BY a.assessed_at DESC LIMIT 20`, personId)
    .map((r) => shape(store, r, false));
  return {
    baseline: base ? shape(store, base, canAssess) : null, current: cur ? shape(store, cur, canAssess) : null, rows,
    unplanned: unplanned(store, personId), plans: { open, stopped: plans.filter((p) => p.state === 'STOPPED') }, earlier, canAssess, options: options(),
  };
}

// For the record header: the help they need now, for everyone caring for them.
export function current(store: Store, personId: string) {
  const cur = inForce(store, personId, 'CURRENT');
  if (!cur) return null;
  const help = Object.entries(entriesOf(cur)).filter(([, e]) => LEVEL_BY_ID.get(e.level)?.help).map(([a, e]) => describe(a, e));
  return help.length ? { help, at: String(cur.assessedAt), overdue: !!cur.reviewDue && String(cur.reviewDue) < now() } : null;
}

// Home → Function: reassessments due in the next day, and people worse than usual with nothing planned.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('function.assess')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include assessing function`);
  const inService = "a.person_id IN (SELECT person_id FROM encounter WHERE service_id = ? AND state = 'ACTIVE' UNION SELECT person_id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL)";
  const currents = store.all<Row>(`${ASSESSMENT} WHERE ${inService} AND a.kind = 'CURRENT' AND a.state = 'CURRENT' ORDER BY a.review_due`, ctx.serviceId, ctx.serviceId);
  const soon = new Date(Date.now() + 24 * 3600_000).toISOString();
  const due = currents.filter((r) => r.reviewDue && String(r.reviewDue) <= soon).map((r) => shape(store, r, true));
  const worse = currents.map((r) => ({ r, activities: unplanned(store, String(r.personId)) })).filter((x) => x.activities.length)
    .map((x) => ({ ...shape(store, x.r, true), unplanned: x.activities }));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_FUNCTION', decision: 'ALLOW', outcome: 'VIEWED' });
  return { due, worse, options: options() };
}
