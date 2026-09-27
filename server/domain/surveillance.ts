import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { KINDS, KIND_BY_ID, INTERVALS, FINDINGS, NOT_DONE_REASONS, DECISIONS, CEASE_REASONS, DUE_SOON_DAYS } from '../config/surveillance.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Surveillance Plan (Shared Lifecycle Object 285):
//   surveillance need → interval/trigger → required investigation/assessment → due → performed →
//   result → review → continuation/modification/cessation.
// A clinician sets up a plan for a known risk: why it is needed, what check to do, and how often
// (or only when something happens, the trigger). Each check falls due, is performed, and its result
// is recorded; a check that could not be done is recorded with the reason. Every result, and every
// missed check, is reviewed by someone who may decide: continue, change the plan, or stop it.
// A plan has at most one open check at a time.

type Row = Record<string, string | number | null>;
const PLAN_STATES: Record<string, string> = { ACTIVE: 'Active', CEASED: 'Stopped', ENTERED_IN_ERROR: 'Entered in error' };
const CHECK_STATES: Record<string, string> = {
  DUE: 'Due', PERFORMED: 'Done, waiting for the result', RESULTED: 'Result to review', NOT_DONE: 'Not done, to review', REVIEWED: 'Reviewed',
  CANCELLED: 'Cancelled', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  SET_UP: 'Set up', DUE: 'Check due', TRIGGERED: 'Trigger happened', PERFORMED: 'Performed', RESULT: 'Result', NOT_DONE: 'Not done',
  REVIEWED: 'Reviewed', MODIFIED: 'Plan changed', CEASED: 'Stopped', ERROR: 'Entered in error',
};
const OPEN_CHECK = ['DUE', 'PERFORMED', 'RESULTED', 'NOT_DONE'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-SURV-001'];

const Q = `
  SELECT v.id, v.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = v.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         v.service_id AS serviceId, s.name AS service, v.kind, v.need, v.investigation, v.every_days AS everyDays, v.trigger_text AS triggerText,
         v.state, sb.display_name AS setBy, v.set_by AS setById, v.set_at AS setAt,
         v.cease_reason AS ceaseReason, eb.display_name AS endedBy, v.ended_at AS endedAt, v.ended_note AS endedNote
    FROM surveillance_plan v
    JOIN person p ON p.id = v.person_id
    JOIN service s ON s.id = v.service_id
    JOIN workforce_person sb ON sb.id = v.set_by
    LEFT JOIN workforce_person eb ON eb.id = v.ended_by`;
const QC = `
  SELECT c.id, c.plan_id AS planId, c.due_date AS dueDate, c.why, c.state, cb.display_name AS createdBy, c.created_at AS createdAt,
         pb.display_name AS performedBy, c.performed_at AS performedAt, c.performed_note AS performedNote,
         rb.display_name AS resultBy, c.result_at AS resultAt, c.result, c.finding,
         c.not_done_reason AS notDoneReason, c.not_done_note AS notDoneNote,
         vb.display_name AS reviewedBy, c.reviewed_at AS reviewedAt, c.decision, c.review_note AS reviewNote
    FROM surveillance_check c
    JOIN workforce_person cb ON cb.id = c.created_by
    LEFT JOIN workforce_person pb ON pb.id = c.performed_by
    LEFT JOIN workforce_person rb ON rb.id = c.result_by
    LEFT JOIN workforce_person vb ON vb.id = c.reviewed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'SURVEILLANCE', personId }).decision === 'ALLOW';
const reviewer = (ctx: WorkContext) => ctx.role.capabilities.includes('surveillance.review');
const everyLabel = (d: unknown) => INTERVALS[String(d ?? 0)] ?? `Every ${d} days`;

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'surveillance_plan', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, ctx: WorkContext, id: string, checkId: string | null, kind: string, body: string) =>
  store.insert('surveillance_log', { id: newId(), plan_id: id, check_id: checkId, kind, body, by_id: ctx.workerId, at: now() });

function newCheck(store: Store, ctx: WorkContext, planId: string, personId: string, dueDate: string, why: string) {
  const id = newId();
  store.insert('surveillance_check', { id, plan_id: planId, person_id: personId, due_date: dueDate, why, state: 'DUE', created_by: ctx.workerId, created_at: now() });
  recordInitial(store, 'survcheck', id, 'DUE', { actorId: ctx.workerId, workContextId: ctx.id }, `Due ${dueDate}`);
  return id;
}

function shapeCheck(c: Row) {
  const state = String(c.state);
  const today = todayLocal();
  const due = String(c.dueDate);
  return {
    ...c, id: String(c.id), state, stateLabel: CHECK_STATES[state], dueDate: due, performedAt: c.performedAt as string | null,
    findingLabel: c.finding ? FINDINGS[String(c.finding)] ?? String(c.finding) : null,
    notDoneLabel: c.notDoneReason ? NOT_DONE_REASONS[String(c.notDoneReason)] ?? String(c.notDoneReason) : null,
    decisionLabel: c.decision ? DECISIONS[String(c.decision)] ?? String(c.decision) : null,
    overdue: state === 'DUE' && due < today,
    dueToday: state === 'DUE' && due === today,
    dueSoon: state === 'DUE' && due >= today && due <= addDays(today, DUE_SOON_DAYS),
    concerning: state === 'RESULTED' && c.finding === 'CONCERNING',
  };
}

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const checks = store.all<Row>(`${QC} WHERE c.plan_id = ? ORDER BY c.created_at DESC, c.rowid DESC`, id).map(shapeCheck);
  const current = checks.find((c) => OPEN_CHECK.includes(c.state)) ?? null;
  const actions: string[] = [];
  const mine = can && ctx.serviceId === r.serviceId;
  if (mine && state === 'ACTIVE') {
    if (current?.state === 'DUE') actions.push('perform', 'notdone');
    if (current?.state === 'PERFORMED') actions.push('result');
    if (reviewer(ctx) && (current?.state === 'RESULTED' || current?.state === 'NOT_DONE')) actions.push('review');
    if (!current || (current.state === 'DUE' && current.dueDate > todayLocal())) actions.push('trigger');
    if (reviewer(ctx)) actions.push('cease');
    if (reviewer(ctx) || r.setById === ctx.workerId) actions.push('error');
  }
  const last = checks.find((c) => c.state === 'REVIEWED') ?? null;
  return {
    ...r, id, state, stateLabel: PLAN_STATES[state],
    kindLabel: KIND_BY_ID.get(String(r.kind))?.label ?? String(r.kind), everyLabel: everyLabel(r.everyDays),
    ceaseLabel: r.ceaseReason ? CEASE_REASONS[String(r.ceaseReason)] ?? String(r.ceaseReason) : null,
    current, last, past: checks.filter((c) => c !== current),
    nextDue: r.everyDays ? [addDays(String(current?.performedAt ?? '').slice(0, 10) || todayLocal(), Number(r.everyDays)), addDays(todayLocal(), 1)].sort().pop() : null,
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM surveillance_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.plan_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'survplan', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE v.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That surveillance plan is no longer in SHIFT.');
  return r;
};

function interval(b: { every?: string; trigger?: string; firstDue?: string }) {
  if (!(String(b.every ?? '') in INTERVALS)) throw new HttpError(400, 'EVERY_REQUIRED', 'Choose how often.');
  const everyDays = Number(b.every) || null;
  const trigger = text(b.trigger, 300);
  if (!everyDays && trigger.length < 5) throw new HttpError(400, 'TRIGGER_REQUIRED', 'Say what should trigger a check, e.g. "If she falls again".');
  const firstDue = date(b.firstDue);
  if (everyDays && (!firstDue || firstDue < todayLocal() || firstDue > addDays(todayLocal(), 3 * 365))) throw new HttpError(400, 'DATE', 'Choose when the next check is due, from today to three years ahead.');
  return { everyDays, trigger: trigger || null, firstDue: everyDays ? firstDue : null };
}

export function setUp(store: Store, ctx: WorkContext, personId: string, b: { kind?: string; need?: string; investigation?: string; every?: string; trigger?: string; firstDue?: string }) {
  enforce(store, ctx, { op: 'SURVEILLANCE', personId }, personId);
  if (!reviewer(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation can record checks but not set up surveillance.`);
  const kind = KIND_BY_ID.get(String(b.kind));
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what is being watched.');
  const need = text(b.need, 1000);
  if (need.length < 5) throw new HttpError(400, 'NEED_REQUIRED', 'Say why surveillance is needed, e.g. "Started spironolactone; risk of high potassium".');
  const investigation = text(b.investigation, 300) || kind.check;
  if (investigation.length < 3) throw new HttpError(400, 'CHECK_REQUIRED', 'Say what check to do each time.');
  const t = interval(b);
  let id = '';
  store.tx(() => {
    id = newId();
    store.insert('surveillance_plan', {
      id, person_id: personId, service_id: ctx.serviceId, kind: kind.id, need, investigation, every_days: t.everyDays, trigger_text: t.trigger,
      state: 'ACTIVE', set_by: ctx.workerId, set_at: now(),
    });
    recordInitial(store, 'survplan', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, need.slice(0, 200));
    addLog(store, ctx, id, null, 'SET_UP', `${need} Check: ${investigation}. ${everyLabel(t.everyDays)}.${t.trigger ? ` Also when: ${t.trigger}.` : ''}`);
    if (t.firstDue) {
      const c = newCheck(store, ctx, id, personId, t.firstDue, 'Scheduled');
      addLog(store, ctx, id, c, 'DUE', `First check due ${t.firstDue}.`);
    }
    logged(store, ctx, 'SURVEILLANCE_SET_UP', personId, id, need.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; when?: string; result?: string; finding?: string; reason?: string; decision?: string; nextDue?: string;
    investigation?: string; every?: string; trigger?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'SURVEILLANCE', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This surveillance plan belongs to ${r.service}.`);
  if (r.state !== 'ACTIVE') throw new HttpError(409, 'WRONG_STATE', `This plan is ${PLAN_STATES[String(r.state)].toLowerCase()}.`);
  const c = store.get<Row>(`${QC} WHERE c.plan_id = ? AND c.state IN ('DUE', 'PERFORMED', 'RESULTED', 'NOT_DONE')`, id);
  const cid = c ? String(c.id) : '';
  const cstate = c ? String(c.state) : '';
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const checkIs = (...s: string[]) => { if (!s.includes(cstate)) throw new HttpError(409, 'WRONG_STATE', c ? `The check is ${CHECK_STATES[cstate].toLowerCase()}.` : 'There is no check open.'); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const mustReview = () => { if (!reviewer(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot review surveillance. Ask the doctor or registered nurse responsible.`); };
  const endPlan = (to: 'CEASED' | 'ENTERED_IN_ERROR', reason: string | null, checkTo: 'CANCELLED' | 'ENTERED_IN_ERROR' | null) => {
    if (c && checkTo) transition(store, 'survcheck', cid, checkTo, who, note.slice(0, 200));
    transition(store, 'survplan', id, to, who, note.slice(0, 200));
    store.run('UPDATE surveillance_plan SET cease_reason = ?, ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', reason, ctx.workerId, at, note, id);
  };
  switch (action) {
    case 'perform': {
      checkIs('DUE');
      const when = Date.parse(String(b.when ?? ''));
      if (Number.isNaN(when) || when > Date.now() + 5 * 60_000 || when < Date.now() - 7 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it was done, in the last week and not in the future.');
      const iso = new Date(when).toISOString();
      store.tx(() => {
        transition(store, 'survcheck', cid, 'PERFORMED', who, note.slice(0, 200) || undefined);
        store.run('UPDATE surveillance_check SET performed_by = ?, performed_at = ?, performed_note = ? WHERE id = ?', ctx.workerId, iso, note || null, cid);
        addLog(store, ctx, id, cid, 'PERFORMED', note || 'Done. Result to follow.');
        logged(store, ctx, 'SURVEILLANCE_PERFORMED', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'result': {
      checkIs('PERFORMED');
      const result = text(b.result, 1000);
      if (result.length < 2) throw new HttpError(400, 'RESULT_REQUIRED', 'Write the result, e.g. "Potassium 5.4, creatinine 128".');
      const finding = FINDINGS[String(b.finding)] ? String(b.finding) : '';
      if (!finding) throw new HttpError(400, 'FINDING_REQUIRED', 'Say what the result shows.');
      store.tx(() => {
        transition(store, 'survcheck', cid, 'RESULTED', who, FINDINGS[finding]);
        store.run('UPDATE surveillance_check SET result_by = ?, result_at = ?, result = ?, finding = ? WHERE id = ?', ctx.workerId, at, result, finding, cid);
        addLog(store, ctx, id, cid, 'RESULT', `${result} (${FINDINGS[finding].toLowerCase()}).`);
        logged(store, ctx, 'SURVEILLANCE_RESULT', personId, id, finding);
      });
      break;
    }
    case 'notdone': {
      checkIs('DUE');
      const reason = NOT_DONE_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it was not done.');
      need(5, 'Say what happened, e.g. "Refused the blood test; will ask again tomorrow".');
      store.tx(() => {
        transition(store, 'survcheck', cid, 'NOT_DONE', who, NOT_DONE_REASONS[reason]);
        store.run('UPDATE surveillance_check SET not_done_reason = ?, not_done_note = ?, performed_by = ?, performed_at = ? WHERE id = ?', reason, note, ctx.workerId, at, cid);
        addLog(store, ctx, id, cid, 'NOT_DONE', `${NOT_DONE_REASONS[reason]}. ${note}`);
        logged(store, ctx, 'SURVEILLANCE_NOT_DONE', personId, id, reason);
      });
      break;
    }
    case 'review': {
      mustReview();
      checkIs('RESULTED', 'NOT_DONE');
      const decision = DECISIONS[String(b.decision)] ? String(b.decision) : '';
      if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose whether to continue, change or stop.');
      need(5, 'Write your review, e.g. "Potassium a little high; halve the spironolactone and recheck in a week".');
      if (decision === 'CEASE') {
        const reason = CEASE_REASONS[String(b.reason)] ? String(b.reason) : '';
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why surveillance is stopping.');
        store.tx(() => {
          transition(store, 'survcheck', cid, 'REVIEWED', who, DECISIONS.CEASE);
          store.run('UPDATE surveillance_check SET reviewed_by = ?, reviewed_at = ?, decision = ?, review_note = ? WHERE id = ?', ctx.workerId, at, decision, note, cid);
          addLog(store, ctx, id, cid, 'REVIEWED', `${DECISIONS.CEASE}. ${note}`);
          endPlan('CEASED', reason, null);
          addLog(store, ctx, id, null, 'CEASED', CEASE_REASONS[reason]);
          logged(store, ctx, 'SURVEILLANCE_CEASE', personId, id, reason);
        });
        break;
      }
      let everyDays = r.everyDays ? Number(r.everyDays) : null;
      let investigation = String(r.investigation);
      let trigger = r.triggerText ? String(r.triggerText) : null;
      let nextDue = date(b.nextDue);
      const changes: string[] = [];
      if (decision === 'MODIFY') {
        const t = interval({ every: b.every, trigger: b.trigger, firstDue: b.nextDue });
        const inv = text(b.investigation, 300) || investigation;
        if (inv !== investigation) changes.push(`check now: ${inv}`);
        if (t.everyDays !== everyDays) changes.push(everyLabel(t.everyDays).toLowerCase());
        if (t.trigger !== trigger && t.trigger) changes.push(`also when: ${t.trigger}`);
        if (!changes.length && !t.firstDue) throw new HttpError(400, 'NO_CHANGE', 'Change the check, how often, or the trigger, or choose to continue.');
        ({ everyDays, trigger } = t);
        investigation = inv;
        nextDue = t.firstDue ?? '';
      } else if (everyDays && (!nextDue || nextDue <= todayLocal() || nextDue > addDays(todayLocal(), 3 * 365))) {
        throw new HttpError(400, 'DATE', 'Choose when the next check is due, after today.');
      }
      if (!everyDays) nextDue = '';
      store.tx(() => {
        transition(store, 'survcheck', cid, 'REVIEWED', who, DECISIONS[decision]);
        store.run('UPDATE surveillance_check SET reviewed_by = ?, reviewed_at = ?, decision = ?, review_note = ? WHERE id = ?', ctx.workerId, at, decision, note, cid);
        addLog(store, ctx, id, cid, 'REVIEWED', `${DECISIONS[decision]}. ${note}`);
        if (decision === 'MODIFY') {
          transition(store, 'survplan', id, 'ACTIVE', who, changes.join('; ').slice(0, 200) || 'Next check moved');
          store.run('UPDATE surveillance_plan SET investigation = ?, every_days = ?, trigger_text = ? WHERE id = ?', investigation, everyDays, trigger, id);
          addLog(store, ctx, id, null, 'MODIFIED', changes.length ? `${changes.join('; ')}.` : 'Next check moved.');
        }
        if (nextDue) {
          const next = newCheck(store, ctx, id, personId, nextDue, 'Scheduled');
          addLog(store, ctx, id, next, 'DUE', `Next check due ${nextDue}.`);
        } else addLog(store, ctx, id, null, 'DUE', `No check scheduled; next one when: ${trigger}.`);
        logged(store, ctx, `SURVEILLANCE_${decision}`, personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'trigger': {
      if (c && !(cstate === 'DUE' && String(c.dueDate) > todayLocal())) throw new HttpError(409, 'WRONG_STATE', 'A check is already due or waiting.');
      need(5, 'Say what happened, e.g. "Found on the floor at 0300; hit her head".');
      store.tx(() => {
        if (c) {
          store.run('UPDATE surveillance_check SET due_date = ?, why = ? WHERE id = ?', todayLocal(), note.slice(0, 300), cid);
          addLog(store, ctx, id, cid, 'TRIGGERED', `${note} Check brought forward to today.`);
        } else {
          const next = newCheck(store, ctx, id, personId, todayLocal(), note.slice(0, 300));
          addLog(store, ctx, id, next, 'TRIGGERED', `${note} Check due now.`);
        }
        logged(store, ctx, 'SURVEILLANCE_TRIGGER', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'cease': {
      mustReview();
      const reason = CEASE_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why surveillance is stopping.');
      need(5, 'Say what happened, e.g. "Spironolactone stopped by cardiology".');
      if (cstate === 'RESULTED') throw new HttpError(409, 'REVIEW_FIRST', 'Review the result waiting first; you can stop the plan from there.');
      store.tx(() => {
        endPlan('CEASED', reason, 'CANCELLED');
        addLog(store, ctx, id, null, 'CEASED', `${CEASE_REASONS[reason]}. ${note}`);
        logged(store, ctx, 'SURVEILLANCE_CEASE', personId, id, reason);
      });
      break;
    }
    case 'error': {
      if (!reviewer(ctx) && r.setById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who set it up, or someone who reviews surveillance, can mark it as an error.');
      need(10, 'Write why this was entered in error, e.g. "Set up for the wrong person".');
      store.tx(() => {
        endPlan('ENTERED_IN_ERROR', null, 'ENTERED_IN_ERROR');
        addLog(store, ctx, id, null, 'ERROR', note);
        logged(store, ctx, 'SURVEILLANCE_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

const dueOrder = (x: { current: { dueDate: string } | null }) => x.current?.dueDate ?? '9999';

// The person's Surveillance view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE v.person_id = ? ORDER BY v.set_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    active: all.filter((x) => x.state === 'ACTIVE').sort((a, b) => dueOrder(a).localeCompare(dueOrder(b))),
    ended: all.filter((x) => x.state !== 'ACTIVE'),
    canSetUp: can && reviewer(ctx),
    options: { kinds: KINDS, intervals: INTERVALS, findings: FINDINGS, notDoneReasons: NOT_DONE_REASONS, decisions: DECISIONS, ceaseReasons: CEASE_REASONS },
  };
}

// Home → Surveillance for this service: results to review, overdue, due soon, waiting for a result.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('surveillance.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include surveillance`);
  const rows = store.all<Row>(`${Q} WHERE v.service_id = ? AND v.state = 'ACTIVE' ORDER BY v.set_at`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true)).filter((x) => x.current).sort((a, b) => dueOrder(a).localeCompare(dueOrder(b)));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_SURVEILLANCE', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toReview: rows.filter((x) => ['RESULTED', 'NOT_DONE'].includes(x.current!.state)).sort((a, b) => Number(b.current!.concerning) - Number(a.current!.concerning)),
    overdue: rows.filter((x) => x.current!.overdue),
    dueSoon: rows.filter((x) => x.current!.dueSoon),
    waiting: rows.filter((x) => x.current!.state === 'PERFORMED'),
    canReview: reviewer(ctx),
  };
}
