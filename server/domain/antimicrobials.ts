import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { INTENTS, ROUTES, MICRO, DECISIONS, CHANGES, STOP_REASONS, OUTCOMES, REVIEW_DAYS } from '../config/antimicrobials.ts';
import { SITES } from '../config/infections.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Antimicrobial Course (Shared Lifecycle Object 290):
//   infection/indication → antimicrobial decision → agent/order references → intended duration →
//   microbiology linkage → review → escalation/de-escalation/change → completion/cessation → outcome.
// A prescriber (or a rest home nurse recording the GP's decision) starts a course for an infection
// or another indication: the agent, route and dose as ordered on the medication chart, how many
// days, and when it must be reviewed. Lab results are linked as they come. At review the course is
// continued, changed (a new course replaces it: IV to oral, narrower, broader or another switch) or
// stopped. When the last dose is given it is completed, and the outcome is recorded.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  ACTIVE: 'Active', CHANGED: 'Changed to another course', COMPLETED: 'Completed', STOPPED: 'Stopped early', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  STARTED: 'Started', MICRO: 'Lab result', REVIEWED: 'Reviewed', CHANGED: 'Changed', STOPPED: 'Stopped', COMPLETED: 'Completed',
  OUTCOME: 'Outcome', ERROR: 'Entered in error',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-AMS-001'];

const Q = `
  SELECT a.id, a.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = a.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         a.service_id AS serviceId, s.name AS service, a.infection_id AS infectionId, i.site AS infectionSite, i.source AS infectionSource,
         a.indication, a.intent, a.agent, a.route, a.dose, a.order_ref AS orderRef, a.start_date AS startDate, a.planned_days AS plannedDays,
         a.end_date AS endDate, a.review_by AS reviewBy, a.micro, a.micro_note AS microNote, a.state, a.previous_id AS previousId, a.next_id AS nextId,
         a.change_type AS changeType, db.display_name AS decidedBy, a.decided_by AS decidedById, a.decided_at AS decidedAt, a.decision_note AS decisionNote,
         a.stop_reason AS stopReason, eb.display_name AS endedBy, a.ended_at AS endedAt, a.ended_note AS endedNote,
         a.outcome, a.outcome_note AS outcomeNote, ob.display_name AS outcomeBy, a.outcome_at AS outcomeAt
    FROM antimicrobial_course a
    JOIN person p ON p.id = a.person_id
    JOIN service s ON s.id = a.service_id
    JOIN workforce_person db ON db.id = a.decided_by
    LEFT JOIN infection i ON i.id = a.infection_id
    LEFT JOIN workforce_person eb ON eb.id = a.ended_by
    LEFT JOIN workforce_person ob ON ob.id = a.outcome_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'ANTIMICROBIAL', personId }).decision === 'ALLOW';
const decider = (ctx: WorkContext) => ctx.role.capabilities.includes('antimicrobial.decide');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'antimicrobial_course', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('antimicrobial_log', { id: newId(), course_id: id, kind, body, by_id: ctx.workerId, at: now() });

interface Drug { agent: string; route: string; dose: string; orderRef: string; plannedDays: number; reviewBy: string; intent: string }
// Validates the drug part of a start or a change.
function drug(b: { agent?: string; route?: string; dose?: string; orderRef?: string; days?: string; reviewBy?: string; intent?: string }): Drug {
  const agent = text(b.agent, 200);
  if (agent.length < 3) throw new HttpError(400, 'AGENT_REQUIRED', 'Write the antimicrobial, e.g. "Amoxicillin and clavulanic acid".');
  const route = ROUTES[String(b.route)] ? String(b.route) : '';
  if (!route) throw new HttpError(400, 'ROUTE_REQUIRED', 'Choose the route.');
  const dose = text(b.dose, 200);
  if (dose.length < 2) throw new HttpError(400, 'DOSE_REQUIRED', 'Write the dose and how often, as on the chart, e.g. "1.2 g every 8 hours".');
  const orderRef = text(b.orderRef, 200);
  if (orderRef.length < 3) throw new HttpError(400, 'ORDER_REQUIRED', 'Say where it is ordered, e.g. "Medication chart" or "GP prescription".');
  const plannedDays = Number(b.days);
  if (!Number.isInteger(plannedDays) || plannedDays < 1 || plannedDays > 90) throw new HttpError(400, 'DAYS_REQUIRED', 'Say how many days, from 1 to 90.');
  const reviewBy = date(b.reviewBy);
  if (!reviewBy || reviewBy < todayLocal() || reviewBy > addDays(todayLocal(), 90)) throw new HttpError(400, 'DATE', 'Choose when it must be reviewed, from today.');
  const intent = INTENTS[String(b.intent)] ? String(b.intent) : '';
  if (!intent) throw new HttpError(400, 'INTENT_REQUIRED', 'Choose why it is being given.');
  return { agent, route, dose, orderRef, plannedDays, reviewBy, intent };
}

function create(store: Store, ctx: WorkContext, personId: string, x: Drug & { infectionId: string | null; indication: string; note: string; previousId: string | null; changeType: string | null }) {
  const id = newId();
  const start = todayLocal();
  store.insert('antimicrobial_course', {
    id, person_id: personId, service_id: ctx.serviceId, infection_id: x.infectionId, indication: x.indication, intent: x.intent, agent: x.agent, route: x.route,
    dose: x.dose, order_ref: x.orderRef, start_date: start, planned_days: x.plannedDays, end_date: addDays(start, x.plannedDays), review_by: x.reviewBy,
    micro: null, micro_note: null, state: 'ACTIVE', previous_id: x.previousId, change_type: x.changeType,
    decided_by: ctx.workerId, decided_at: now(), decision_note: x.note || null,
  });
  recordInitial(store, 'antimicrobial', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, `${x.agent} ${ROUTES[x.route]}`);
  addLog(store, ctx, id, 'STARTED', `${x.agent} ${ROUTES[x.route]} ${x.dose} for ${x.plannedDays} days (${x.orderRef}). ${INTENTS[x.intent]}. Review by ${x.reviewBy}.${x.note ? ` ${x.note}` : ''}`);
  return id;
}

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const today = todayLocal();
  const actions: string[] = [];
  const mine = can && ctx.serviceId === r.serviceId;
  if (mine && state === 'ACTIVE') {
    actions.push('micro');
    if (decider(ctx)) actions.push('review');
    if (String(r.endDate) <= today) actions.push('complete');
  }
  if (mine && decider(ctx) && ['COMPLETED', 'STOPPED'].includes(state) && !r.outcome) actions.push('outcome');
  if (mine && state === 'ACTIVE' && (decider(ctx) || r.decidedById === ctx.workerId)) actions.push('error');
  return {
    ...r, id, state, stateLabel: STATES[state], reviewBy: String(r.reviewBy), endDate: String(r.endDate), outcome: r.outcome as string | null,
    routeLabel: ROUTES[String(r.route)] ?? String(r.route), intentLabel: INTENTS[String(r.intent)] ?? String(r.intent),
    microLabel: r.micro ? MICRO[String(r.micro)] ?? String(r.micro) : null,
    changeLabel: r.changeType ? CHANGES[String(r.changeType)] ?? String(r.changeType) : null,
    stopLabel: r.stopReason ? STOP_REASONS[String(r.stopReason)] ?? String(r.stopReason) : null,
    outcomeLabel: r.outcome ? OUTCOMES[String(r.outcome)] ?? String(r.outcome) : null,
    infectionLabel: r.infectionId ? `${SITES[String(r.infectionSite)] ?? r.infectionSite}${r.infectionSource ? `: ${r.infectionSource}` : ' (suspected)'}` : null,
    day: Math.max(1, Math.round((Date.parse(today) - Date.parse(String(r.startDate))) / 86_400_000) + 1),
    // A course finishing today needs completing, not reviewing.
    reviewOverdue: state === 'ACTIVE' && String(r.reviewBy) < today && String(r.endDate) > today,
    reviewToday: state === 'ACTIVE' && String(r.reviewBy) === today && String(r.endDate) > today,
    finishing: state === 'ACTIVE' && String(r.endDate) <= today,
    notCovered: state === 'ACTIVE' && r.micro === 'NOT_COVERED',
    needsOutcome: ['COMPLETED', 'STOPPED'].includes(state) && !r.outcome,
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM antimicrobial_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.course_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'antimicrobial', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE a.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That antimicrobial course is no longer in SHIFT.');
  return r;
};

export function start(store: Store, ctx: WorkContext, personId: string,
  b: { infectionId?: string; indication?: string; agent?: string; route?: string; dose?: string; orderRef?: string; days?: string; reviewBy?: string; intent?: string; note?: string }) {
  enforce(store, ctx, { op: 'ANTIMICROBIAL', personId }, personId);
  if (!decider(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot start an antimicrobial course.`);
  let infectionId: string | null = null;
  let indication = text(b.indication, 500);
  if (b.infectionId) {
    const inf = store.get<Row>("SELECT id, site, source, suspicion FROM infection WHERE id = ? AND person_id = ? AND state IN ('SUSPECTED', 'CONFIRMED', 'ONGOING')", String(b.infectionId), personId);
    if (!inf) throw new HttpError(404, 'NOT_FOUND', 'That infection is not current for this person.');
    infectionId = String(inf.id);
    if (!indication) indication = String(inf.source ?? `Suspected ${SITES[String(inf.site)]?.toLowerCase() ?? inf.site} infection`);
  }
  if (indication.length < 3) throw new HttpError(400, 'INDICATION_REQUIRED', 'Choose the infection, or write what it is for.');
  const d = drug(b);
  const note = text(b.note, 500);
  if (ctx.role.profession !== 'Medical Practitioner' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say who decided on it, e.g. "Dr Nair (GP) by phone".');
  store.tx(() => {
    const id = create(store, ctx, personId, { ...d, infectionId, indication, note, previousId: null, changeType: null });
    logged(store, ctx, 'ANTIMICROBIAL_START', personId, id, d.agent);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { micro?: string; note?: string; decision?: string; change?: string; reason?: string; outcome?: string; agent?: string; route?: string; dose?: string;
    orderRef?: string; days?: string; reviewBy?: string; intent?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'ANTIMICROBIAL', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This course belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This course is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const mustDecide = () => { if (!decider(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot review or change an antimicrobial course.`); };
  const end = (to: string, reason: string | null) => {
    transition(store, 'antimicrobial', id, to, who, note.slice(0, 200) || undefined);
    store.run('UPDATE antimicrobial_course SET stop_reason = ?, ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', reason, ctx.workerId, at, note || null, id);
  };
  switch (action) {
    case 'micro': {
      inState('ACTIVE');
      const micro = MICRO[String(b.micro)] ? String(b.micro) : '';
      if (!micro) throw new HttpError(400, 'MICRO_REQUIRED', 'Choose what the lab result shows for this antimicrobial.');
      need(3, 'Write the result, e.g. "Sputum: Streptococcus pneumoniae, sensitive to amoxicillin".');
      store.tx(() => {
        store.run('UPDATE antimicrobial_course SET micro = ?, micro_note = ? WHERE id = ?', micro, note, id);
        addLog(store, ctx, id, 'MICRO', `${note} (${MICRO[micro].toLowerCase()}).`);
        logged(store, ctx, 'ANTIMICROBIAL_MICRO', personId, id, micro);
      });
      break;
    }
    case 'review': {
      mustDecide();
      inState('ACTIVE');
      const decision = DECISIONS[String(b.decision)] ? String(b.decision) : '';
      if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose whether to continue, change or stop.');
      need(5, 'Write your review, e.g. "Afebrile, eating; sensitive to amoxicillin, switch to oral".');
      if (decision === 'CONTINUE') {
        const reviewBy = date(b.reviewBy);
        if (!reviewBy || reviewBy <= todayLocal() || reviewBy > String(r.endDate)) throw new HttpError(400, 'DATE', `Choose the next review, after today and by the end of the course (${r.endDate}).`);
        store.tx(() => {
          transition(store, 'antimicrobial', id, 'ACTIVE', who, 'Reviewed: continue');
          store.run('UPDATE antimicrobial_course SET review_by = ? WHERE id = ?', reviewBy, id);
          addLog(store, ctx, id, 'REVIEWED', `${DECISIONS.CONTINUE}. ${note} Next review ${reviewBy}.`);
          logged(store, ctx, 'ANTIMICROBIAL_CONTINUE', personId, id, note.slice(0, 200));
        });
      } else if (decision === 'STOP') {
        const reason = STOP_REASONS[String(b.reason)] ? String(b.reason) : '';
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it is stopping.');
        store.tx(() => {
          end('STOPPED', reason);
          addLog(store, ctx, id, 'STOPPED', `${STOP_REASONS[reason]}. ${note}`);
          logged(store, ctx, 'ANTIMICROBIAL_STOP', personId, id, reason);
        });
      } else {
        const change = CHANGES[String(b.change)] ? String(b.change) : '';
        if (!change) throw new HttpError(400, 'CHANGE_REQUIRED', 'Choose the kind of change.');
        const d = drug(b);
        store.tx(() => {
          const next = create(store, ctx, personId, { ...d, infectionId: r.infectionId ? String(r.infectionId) : null, indication: String(r.indication), note, previousId: id, changeType: change });
          if (r.micro) store.run('UPDATE antimicrobial_course SET micro_note = ? WHERE id = ?', `Earlier course: ${r.microNote}`, next);
          end('CHANGED', null);
          store.run('UPDATE antimicrobial_course SET next_id = ?, change_type = ? WHERE id = ?', next, change, id);
          addLog(store, ctx, id, 'CHANGED', `${CHANGES[change]}: now ${d.agent} ${ROUTES[d.route]} ${d.dose}. ${note}`);
          logged(store, ctx, `ANTIMICROBIAL_${change}`, personId, id, d.agent);
        });
      }
      break;
    }
    case 'complete': {
      inState('ACTIVE');
      if (String(r.endDate) > todayLocal()) throw new HttpError(409, 'NOT_YET', `The course runs until ${r.endDate}. To end it early, review it and stop it.`);
      store.tx(() => {
        end('COMPLETED', null);
        addLog(store, ctx, id, 'COMPLETED', note || 'Last dose given.');
        logged(store, ctx, 'ANTIMICROBIAL_COMPLETE', personId, id);
      });
      break;
    }
    case 'outcome': {
      mustDecide();
      inState('COMPLETED', 'STOPPED');
      if (r.outcome) throw new HttpError(409, 'DONE', 'The outcome is already recorded.');
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose the outcome.');
      if (outcome === 'ADVERSE' || outcome === 'FAILED') need(5, 'Say what happened, e.g. "Rash on day 3; recorded as an allergy".');
      store.tx(() => {
        store.run('UPDATE antimicrobial_course SET outcome = ?, outcome_note = ?, outcome_by = ?, outcome_at = ? WHERE id = ?', outcome, note || null, ctx.workerId, at, id);
        addLog(store, ctx, id, 'OUTCOME', `${OUTCOMES[outcome]}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'ANTIMICROBIAL_OUTCOME', personId, id, outcome);
      });
      break;
    }
    case 'error': {
      inState('ACTIVE');
      if (!decider(ctx) && r.decidedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who started it, or a prescriber, can mark it as an error.');
      need(10, 'Write why this was entered in error, e.g. "Started for the wrong person".');
      store.tx(() => {
        end('ENTERED_IN_ERROR', null);
        addLog(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'ANTIMICROBIAL_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Antimicrobials view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE a.person_id = ? ORDER BY a.decided_at DESC, a.rowid DESC`, personId).map((r) => shape(store, ctx, r, can));
  const infections = store.all<Row>("SELECT id, site, source, state FROM infection WHERE person_id = ? AND state IN ('SUSPECTED', 'CONFIRMED', 'ONGOING') ORDER BY raised_at DESC", personId)
    .map((i) => ({ id: String(i.id), label: `${SITES[String(i.site)] ?? i.site}${i.source ? `: ${i.source}` : ' (suspected)'}` }));
  return {
    // A finished course stays in view until its outcome is recorded.
    active: all.filter((x) => x.state === 'ACTIVE' || x.needsOutcome),
    ended: all.filter((x) => x.state !== 'ACTIVE' && !x.needsOutcome),
    canStart: can && decider(ctx),
    medical: ctx.role.profession === 'Medical Practitioner',
    options: { intents: INTENTS, routes: ROUTES, micro: MICRO, decisions: DECISIONS, changes: CHANGES, stopReasons: STOP_REASONS, outcomes: OUTCOMES, infections, reviewDays: REVIEW_DAYS },
  };
}

// Home → Antimicrobials for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('antimicrobial.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include antimicrobials`);
  const rows = store.all<Row>(`${Q} WHERE a.service_id = ? AND (a.state = 'ACTIVE' OR (a.state IN ('COMPLETED', 'STOPPED') AND a.outcome IS NULL)) ORDER BY a.review_by`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_ANTIMICROBIALS', decision: 'ALLOW', outcome: 'VIEWED' });
  const toReview = rows.filter((x) => x.reviewOverdue || x.reviewToday || x.notCovered);
  return {
    toReview,
    finishing: rows.filter((x) => x.finishing && !toReview.includes(x)),
    outcome: rows.filter((x) => x.needsOutcome),
    others: rows.filter((x) => x.state === 'ACTIVE' && !toReview.includes(x) && !x.finishing),
    canDecide: decider(ctx),
  };
}
