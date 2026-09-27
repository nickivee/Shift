import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { raise as raiseEscalation, recipients, URGENCY } from './escalations.ts';
import { current as whanauLimits } from './whanau.ts';
import { PATHWAYS, PATHWAY_BY_ID, STEP_STATES, EXIT_REASONS } from '../config/pathways.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Clinical Pathway / Protocol Instance (Shared Lifecycle Object 278):
//   patient meets trigger/eligibility → pathway initiated → applicable steps →
//   completed/skipped/not applicable/deferred states → deviations → escalation → completion/exit.
// An entry (a .fall) can suggest a pathway; a clinician confirms the eligibility questions and
// starts it, or declines it. Each step has a time it is due; staff record it done, skipped, not
// applicable or deferred. Skipping, deferring, finishing late and starting without meeting the
// eligibility are deviations, each with its reason; any deviation or overdue step can be
// escalated (Object 225). The pathway completes when every step is resolved, or exits early
// with a reason. The pathways themselves are the synthetic organisation's own (RR-PW-001).

type Row = Record<string, string | number | null>;
type Cap = 'pathway.record' | 'pathway.manage';
const STATES: Record<string, string> = {
  SUGGESTED: 'Suggested', ACTIVE: 'Under way', COMPLETED: 'Completed', EXITED: 'Exited early', DECLINED: 'Not started', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  SUGGESTED: 'Suggested', STARTED: 'Started', DECLINED: 'Not started', DONE: 'Step done', SKIPPED: 'Step skipped', NOT_APPLICABLE: 'Step not applicable',
  DEFERRED: 'Step deferred', DEVIATION: 'Deviation', ESCALATED: 'Escalated', COMPLETED: 'Completed', EXITED: 'Exited early', ERROR: 'Entered in error',
};
const DEVIATIONS: Record<string, string> = {
  ELIGIBILITY: 'Started without meeting every question', SKIPPED: 'Step skipped', DEFERRED: 'Step deferred', LATE: 'Step done late', OVERDUE: 'Step overdue',
};
const CONCERN: Record<string, string> = { POST_FALL: 'Fall', SEPSIS: 'Deterioration', DELIRIUM: 'Behaviour or confusion' };
const OPEN_STEP = ['PENDING', 'DEFERRED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-PW-001'];

const Q = `
  SELECT i.id, i.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = i.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         i.service_id AS serviceId, i.pathway_id AS pathwayId, i.state, i.trigger_text AS triggerText, i.eligibility_json AS eligibilityJson,
         sb.display_name AS suggestedBy, i.suggested_at AS suggestedAt, tb.display_name AS startedBy, i.started_at AS startedAt,
         eb.display_name AS endedBy, i.ended_at AS endedAt, i.exit_reason AS exitReason, i.end_note AS endNote
    FROM pathway_instance i
    JOIN person p ON p.id = i.person_id
    LEFT JOIN workforce_person sb ON sb.id = i.suggested_by
    LEFT JOIN workforce_person tb ON tb.id = i.started_by
    LEFT JOIN workforce_person eb ON eb.id = i.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'PATHWAY', personId, cap }).decision === 'ALLOW';
const addMins = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'pathway_instance', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, byId: string, id: string, kind: string, body: string) =>
  store.insert('pathway_log', { id: newId(), instance_id: id, kind, body, by_id: byId, at: now() });
const deviation = (store: Store, byId: string, id: string, stepId: string | null, kind: string, note: string) => {
  const dev = newId();
  store.insert('pathway_deviation', { id: dev, instance_id: id, step_id: stepId, kind, note, escalation_id: null, by_id: byId, at: now() });
  addLog(store, byId, id, 'DEVIATION', `${DEVIATIONS[kind]}: ${note}`);
  return dev;
};

function shape(store: Store, ctx: WorkContext | null, r: Row, can: { record: boolean; manage: boolean }) {
  const id = String(r.id);
  const state = String(r.state);
  const def = PATHWAY_BY_ID.get(String(r.pathwayId));
  const at = now();
  const steps = store.all<Row>(`SELECT s.id, s.step_key AS stepKey, s.label, s.optional, s.due_at AS dueAt, s.state, s.note, w.display_name AS "by", s.at
    FROM pathway_step s LEFT JOIN workforce_person w ON w.id = s.by_id WHERE s.instance_id = ? ORDER BY s.seq`, id)
    .map((s) => ({ ...s, optional: Boolean(s.optional), stateLabel: STEP_STATES[String(s.state)] ?? String(s.state),
      overdue: state === 'ACTIVE' && OPEN_STEP.includes(String(s.state)) && String(s.dueAt) <= at })) as (Row & { optional: boolean; stateLabel: string; overdue: boolean })[];
  const deviations = store.all<Row>(`SELECT d.id, d.kind, d.note, d.step_id AS stepId, d.escalation_id AS escalationId,
      (SELECT state FROM escalation WHERE id = d.escalation_id) AS escalationState, w.display_name AS "by", d.at
    FROM pathway_deviation d JOIN workforce_person w ON w.id = d.by_id WHERE d.instance_id = ? ORDER BY d.at, d.rowid`, id)
    .map((d) => ({ ...d, kindLabel: DEVIATIONS[String(d.kind)] ?? String(d.kind) }));
  const answers = r.eligibilityJson ? JSON.parse(String(r.eligibilityJson)) as boolean[] : null;
  const allResolved = steps.length > 0 && steps.every((s) => !OPEN_STEP.includes(String(s.state)));
  const actions: string[] = [];
  if (state === 'SUGGESTED' && can.manage) actions.push('start', 'decline');
  if (state === 'ACTIVE' && can.manage && allResolved) actions.push('complete');
  if (state === 'ACTIVE' && can.manage) actions.push('exit');
  if (['SUGGESTED', 'ACTIVE'].includes(state) && can.manage) actions.push('error');
  const canEscalate = state === 'ACTIVE' && !!ctx && can.record && recipients(store, ctx, String(r.personId)).length > 0;
  return {
    ...r, id, state, stateLabel: STATES[state], label: def?.label ?? String(r.pathwayId), purpose: def?.purpose ?? '',
    eligibility: (def?.eligibility ?? []).map((q, i) => ({ question: q, answer: answers ? answers[i] ?? null : null })),
    exitLabel: r.exitReason ? EXIT_REASONS[String(r.exitReason)] ?? String(r.exitReason) : null,
    steps, deviations, overdue: steps.filter((s) => s.overdue).length, allResolved, actions,
    canRecordSteps: state === 'ACTIVE' && can.record, canEscalate,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM pathway_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.instance_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'pathway', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE i.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That pathway is no longer in SHIFT.');
  return r;
};

// Checks the eligibility answers; any "no" needs a reason and is a deviation.
function eligibility(pathwayId: string, answers: unknown, note: string) {
  const def = PATHWAY_BY_ID.get(pathwayId)!;
  const list = Array.isArray(answers) ? answers : [];
  if (list.length !== def.eligibility.length || list.some((a) => typeof a !== 'boolean')) throw new HttpError(400, 'ELIGIBILITY_REQUIRED', 'Answer every eligibility question.');
  const unmet = def.eligibility.filter((_, i) => !list[i]);
  if (unmet.length && note.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Not every question is met. Write why the pathway is still the right one.');
  return { answers: list as boolean[], unmet };
}

function begin(store: Store, byId: string, id: string, pathwayId: string, startedAt: string) {
  const def = PATHWAY_BY_ID.get(pathwayId)!;
  def.steps.forEach((s, i) => store.insert('pathway_step', {
    id: newId(), instance_id: id, step_key: s.id, label: s.label, seq: i, optional: s.optional ? 1 : 0, due_at: addMins(startedAt, s.dueMins), state: 'PENDING',
  }));
}

export function start(store: Store, ctx: WorkContext, personId: string, b: { pathwayId?: string; answers?: unknown; note?: string }) {
  enforce(store, ctx, { op: 'PATHWAY', personId, cap: 'pathway.manage' }, personId);
  const def = PATHWAY_BY_ID.get(String(b.pathwayId));
  if (!def) throw new HttpError(400, 'PATHWAY_REQUIRED', 'Choose a pathway.');
  if (store.get("SELECT 1 FROM pathway_instance WHERE person_id = ? AND pathway_id = ? AND state IN ('SUGGESTED', 'ACTIVE')", personId, def.id)) {
    throw new HttpError(409, 'ALREADY_OPEN', `This person is already on the ${def.label.toLowerCase()} pathway.`);
  }
  const note = text(b.note);
  const e = eligibility(def.id, b.answers, note);
  const id = newId();
  const at = now();
  store.tx(() => {
    store.insert('pathway_instance', {
      id, person_id: personId, service_id: ctx.serviceId, pathway_id: def.id, state: 'ACTIVE', trigger_text: note || null, eligibility_json: JSON.stringify(e.answers),
      started_by: ctx.workerId, started_at: at,
    });
    recordInitial(store, 'pathway', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, def.label);
    begin(store, ctx.workerId, id, def.id, at);
    addLog(store, ctx.workerId, id, 'STARTED', `${def.label}.${note ? ` ${note}` : ''}`);
    if (e.unmet.length) deviation(store, ctx.workerId, id, null, 'ELIGIBILITY', `${e.unmet.join('; ')}: ${note}`);
    logged(store, ctx, 'PATHWAY_START', personId, id, def.label);
  });
  return forPerson(store, ctx, personId);
}

// An entry that is a pathway's trigger suggests it, unless the person is already on it.
export function fromEntry(store: Store, ctx: WorkContext, personId: string, keyCode: string, eventId: string, summary: string) {
  for (const def of PATHWAYS.filter((p) => p.triggerKey === keyCode)) {
    if (store.get("SELECT 1 FROM pathway_instance WHERE person_id = ? AND pathway_id = ? AND state IN ('SUGGESTED', 'ACTIVE')", personId, def.id)) continue;
    const id = newId();
    store.insert('pathway_instance', {
      id, person_id: personId, service_id: ctx.serviceId, pathway_id: def.id, state: 'SUGGESTED', trigger_text: summary.slice(0, 500), trigger_event_id: eventId,
      suggested_by: ctx.workerId, suggested_at: now(),
    });
    recordInitial(store, 'pathway', id, 'SUGGESTED', { actorId: ctx.workerId, workContextId: ctx.id }, keyCode);
    addLog(store, ctx.workerId, id, 'SUGGESTED', `Suggested by a ${keyCode} entry: ${summary.slice(0, 300)}`);
    logged(store, ctx, 'PATHWAY_SUGGEST', personId, id, def.label);
  }
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; answers?: unknown; stepId?: string; to?: string; deferMins?: unknown; reason?: string; roleKey?: string; urgency?: string; deviationId?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const def = PATHWAY_BY_ID.get(String(r.pathwayId))!;
  const cap: Cap = ['step', 'escalate'].includes(action) ? 'pathway.record' : 'pathway.manage';
  enforce(store, ctx, { op: 'PATHWAY', personId, cap }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This pathway is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const step = (stepId: unknown) => {
    const s = store.get<{ id: string; label: string; state: string; due_at: string; optional: number }>(
      'SELECT id, label, state, due_at, optional FROM pathway_step WHERE id = ? AND instance_id = ?', String(stepId ?? ''), id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'That step is no longer in this pathway.');
    return s;
  };
  switch (action) {
    case 'start': {
      inState('SUGGESTED');
      const e = eligibility(def.id, b.answers, note);
      store.tx(() => {
        transition(store, 'pathway', id, 'ACTIVE', who, def.label);
        store.run('UPDATE pathway_instance SET eligibility_json = ?, started_by = ?, started_at = ? WHERE id = ?', JSON.stringify(e.answers), ctx.workerId, at, id);
        begin(store, ctx.workerId, id, def.id, at);
        addLog(store, ctx.workerId, id, 'STARTED', `${def.label}.${note ? ` ${note}` : ''}`);
        if (e.unmet.length) deviation(store, ctx.workerId, id, null, 'ELIGIBILITY', `${e.unmet.join('; ')}: ${note}`);
        logged(store, ctx, 'PATHWAY_START', personId, id, def.label);
      });
      break;
    }
    case 'decline': {
      inState('SUGGESTED');
      need(5, 'Write why the pathway is not needed.');
      store.tx(() => {
        transition(store, 'pathway', id, 'DECLINED', who, note.slice(0, 200));
        store.run('UPDATE pathway_instance SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx.workerId, id, 'DECLINED', note);
        logged(store, ctx, 'PATHWAY_DECLINE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'step': {
      inState('ACTIVE');
      const s = step(b.stepId);
      if (!OPEN_STEP.includes(s.state)) throw new HttpError(409, 'STEP_DONE', 'That step has already been recorded.');
      const to = STEP_STATES[String(b.to)] && b.to !== 'PENDING' ? String(b.to) : '';
      if (!to) throw new HttpError(400, 'STEP_STATE_REQUIRED', 'Choose what happened with this step.');
      if (to === 'SKIPPED') need(5, 'Write why the step was skipped.');
      if (to === 'NOT_APPLICABLE' && !s.optional) need(5, 'Write why this step does not apply to them.');
      if (to === 'DEFERRED') need(5, 'Write why the step is deferred.');
      let dueAt = s.due_at;
      if (to === 'DEFERRED') {
        const mins = Number(b.deferMins);
        if (!Number.isInteger(mins) || mins < 15 || mins > 48 * 60) throw new HttpError(400, 'DEFER_TIME', 'Choose how long to defer it.');
        dueAt = addMins(at, mins);
      }
      const late = to === 'DONE' && s.due_at < at;
      store.tx(() => {
        store.run('UPDATE pathway_step SET state = ?, note = ?, by_id = ?, at = ?, due_at = ? WHERE id = ?', to, note || null, ctx.workerId, at, dueAt, s.id);
        addLog(store, ctx.workerId, id, to, `${s.label}.${note ? ` ${note}` : ''}${to === 'DEFERRED' ? ` Now due ${dueAt}.` : ''}`);
        if (to === 'SKIPPED') deviation(store, ctx.workerId, id, s.id, 'SKIPPED', `${s.label}: ${note}`);
        if (to === 'DEFERRED') deviation(store, ctx.workerId, id, s.id, 'DEFERRED', `${s.label}: ${note}`);
        if (late) deviation(store, ctx.workerId, id, s.id, 'LATE', `${s.label}: done ${Math.round((Date.parse(at) - Date.parse(s.due_at)) / 60_000)} minutes after it was due.${note ? ` ${note}` : ''}`);
        logged(store, ctx, `PATHWAY_STEP_${to}`, personId, id, s.label);
      });
      break;
    }
    case 'escalate': {
      inState('ACTIVE');
      need(10, 'Say what has happened and why you are worried.');
      const urgency = (URGENCY as readonly string[]).includes(String(b.urgency)) ? String(b.urgency) : '';
      if (!urgency) throw new HttpError(400, 'URGENCY_REQUIRED', 'Choose how urgent this is.');
      let devId = b.deviationId ? store.get<{ id: string; note: string }>('SELECT id, note FROM pathway_deviation WHERE id = ? AND instance_id = ?', String(b.deviationId), id) : null;
      if (b.deviationId && !devId) throw new HttpError(404, 'NOT_FOUND', 'That deviation is no longer in this pathway.');
      const s = !devId && b.stepId ? step(b.stepId) : null;
      if (!devId && !s) throw new HttpError(400, 'WHAT_REQUIRED', 'Choose the step or deviation you are escalating.');
      store.tx(() => {
        if (s) devId = { id: deviation(store, ctx.workerId, id, s.id, 'OVERDUE', `${s.label}: ${note}`), note: s.label };
        const esc = raiseEscalation(store, ctx, personId, { roleKey: b.roleKey, urgency, concern: CONCERN[def.id] ?? 'Other', trigger: `${def.label} pathway: ${devId!.note}. ${note}` });
        store.run('UPDATE pathway_deviation SET escalation_id = ? WHERE id = ?', esc.id, devId!.id);
        addLog(store, ctx.workerId, id, 'ESCALATED', note);
        logged(store, ctx, 'PATHWAY_ESCALATE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'complete': {
      inState('ACTIVE');
      const open = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM pathway_step WHERE instance_id = ? AND state IN ('PENDING', 'DEFERRED')", id)?.n ?? 0;
      if (open) throw new HttpError(409, 'STEPS_OPEN', 'Record every step before completing the pathway, or exit it early.');
      store.tx(() => {
        transition(store, 'pathway', id, 'COMPLETED', who, note.slice(0, 200) || 'Completed');
        store.run('UPDATE pathway_instance SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, at, note || null, id);
        addLog(store, ctx.workerId, id, 'COMPLETED', note || 'Every step recorded.');
        logged(store, ctx, 'PATHWAY_COMPLETE', personId, id);
      });
      break;
    }
    case 'exit': {
      inState('ACTIVE');
      const reason = EXIT_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why the pathway is ending early.');
      need(5, 'Write what happens next for them.');
      store.tx(() => {
        transition(store, 'pathway', id, 'EXITED', who, `${EXIT_REASONS[reason]}: ${note}`.slice(0, 200));
        store.run('UPDATE pathway_instance SET ended_by = ?, ended_at = ?, exit_reason = ?, end_note = ? WHERE id = ?', ctx.workerId, at, reason, note, id);
        addLog(store, ctx.workerId, id, 'EXITED', `${EXIT_REASONS[reason]}. ${note}`);
        logged(store, ctx, 'PATHWAY_EXIT', personId, id, reason);
      });
      break;
    }
    case 'error': {
      inState('SUGGESTED', 'ACTIVE');
      need(10, 'Write why this was entered in error, e.g. "Started for the wrong person".');
      store.tx(() => {
        transition(store, 'pathway', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE pathway_instance SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx.workerId, id, 'ERROR', note);
        logged(store, ctx, 'PATHWAY_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Pathways view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = { record: may(store, ctx, personId, 'pathway.record'), manage: may(store, ctx, personId, 'pathway.manage') };
  const all = store.all<Row>(`${Q} WHERE i.person_id = ? ORDER BY COALESCE(i.started_at, i.suggested_at) DESC`, personId).map((r) => shape(store, ctx, r, can));
  const open = ['SUGGESTED', 'ACTIVE'];
  return {
    open: all.filter((x) => open.includes(x.state)),
    ended: all.filter((x) => !open.includes(x.state)),
    canRecord: can.record, canManage: can.manage,
    // Shown on any step that involves contacting whānau, so a limit the person set is not missed.
    whanauLimits: (whanauLimits(store, personId) ?? []).filter((w) => w.limits).map((w) => `${w.name}: ${w.limits}`),
    options: {
      pathways: PATHWAYS.map((p) => ({ id: p.id, label: p.label, purpose: p.purpose, eligibility: p.eligibility })),
      stepStates: STEP_STATES, exitReasons: EXIT_REASONS, urgencies: URGENCY, recipients: can.record ? recipients(store, ctx, personId) : [],
    },
  };
}

// For the record header: steps overdue on pathways under way.
export function current(store: Store, personId: string) {
  return store.all<{ pathway_id: string; label: string }>(`SELECT i.pathway_id, s.label FROM pathway_step s JOIN pathway_instance i ON i.id = s.instance_id
    WHERE i.person_id = ? AND i.state = 'ACTIVE' AND s.state IN ('PENDING', 'DEFERRED') AND s.due_at <= ? ORDER BY s.due_at`, personId, now())
    .map((s) => `${PATHWAY_BY_ID.get(s.pathway_id)?.label ?? s.pathway_id}: ${s.label}`);
}

// Home → Pathways: suggested, steps overdue, ready to complete, in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('pathway.manage')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include managing pathways`);
  }
  const inService = `EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = i.person_id AND e.service_id = ? AND e.state = 'ACTIVE')
     OR EXISTS (SELECT 1 FROM care_relationship c WHERE c.person_id = i.person_id AND c.service_id = ? AND c.ended_at IS NULL)`;
  const rows = store.all<Row>(`${Q} WHERE i.state IN ('SUGGESTED', 'ACTIVE') AND (${inService}) ORDER BY COALESCE(i.started_at, i.suggested_at)`, ctx.serviceId, ctx.serviceId)
    .map((r) => shape(store, null, r, { record: false, manage: false }));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_PATHWAYS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    suggested: rows.filter((r) => r.state === 'SUGGESTED'),
    overdue: rows.filter((r) => r.overdue > 0),
    ready: rows.filter((r) => r.state === 'ACTIVE' && r.allResolved),
    active: rows.filter((r) => r.state === 'ACTIVE').length,
  };
}
