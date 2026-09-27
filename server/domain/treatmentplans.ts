import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { COMPONENTS, COMPONENT_STATES, AGREED_WITH, PROGRESS, REVIEW } from '../config/treatmentplans.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Treatment Plan (Shared Lifecycle Object 277):
//   treatment need → options → agreed/authorised plan → components → responsible services →
//   implementation → monitoring → review → modification → completion/cessation.
// A clinician records the need (usually an open problem) and the goal, and the options with
// their benefits and risks. One option is proposed; a doctor or therapist who can authorise
// agrees it with the person (or who speaks for them) and it becomes the plan. Components say
// what will be done and which service is responsible; starting the plan puts them under way.
// Anyone caring for the person records how it is going. A review continues, changes, completes
// or stops it; choosing a different option needs agreeing again. Each change is a new version.

type Row = Record<string, string | number | null>;
type Cap = 'treatmentplan.record' | 'treatmentplan.plan' | 'treatmentplan.authorise';
const STATES: Record<string, string> = {
  DRAFT: 'Weighing options', AWAITING_AGREEMENT: 'Waiting for agreement', AGREED: 'Agreed, not started', ACTIVE: 'Under way',
  COMPLETED: 'Completed', STOPPED: 'Stopped', ENTERED_IN_ERROR: 'Entered in error',
};
const STEPS: Record<string, string> = {
  NEED: 'Need recorded', OPTION: 'Option added', PROPOSED: 'Option proposed', NOT_AGREED: 'Not agreed', AGREED: 'Agreed', COMPONENT: 'Component added',
  COMPONENT_STATE: 'Component updated', STARTED: 'Started', PROGRESS: 'Progress', REVIEW: 'Reviewed', MODIFIED: 'Changed', COMPLETED: 'Completed',
  STOPPED: 'Stopped', ERROR: 'Entered in error',
};
const OPEN = ['DRAFT', 'AWAITING_AGREEMENT', 'AGREED', 'ACTIVE'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-TP-001', 'RR-TP-002'];

const Q = `
  SELECT t.id, t.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = t.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         t.service_id AS serviceId, s.name AS serviceName, t.need, t.problem_id AS problemId, (SELECT title FROM clinical_problem WHERE id = t.problem_id) AS problemTitle,
         t.goal, t.state, t.chosen_option_id AS chosenOptionId, t.proposed_option_id AS proposedOptionId, t.version, t.agreed_with AS agreedWith, t.agreement_note AS agreementNote,
         ab.display_name AS authorisedBy, t.authorised_at AS authorisedAt, t.started_at AS startedAt, t.review_due AS reviewDue,
         cb.display_name AS createdBy, t.created_at AS createdAt, eb.display_name AS endedBy, t.ended_at AS endedAt, t.end_note AS endNote
    FROM treatment_plan t
    JOIN person p ON p.id = t.person_id
    JOIN service s ON s.id = t.service_id
    JOIN workforce_person cb ON cb.id = t.created_by
    LEFT JOIN workforce_person ab ON ab.id = t.authorised_by
    LEFT JOIN workforce_person eb ON eb.id = t.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'TREATMENT_PLAN', personId, cap }).decision === 'ALLOW';
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'treatment_plan', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('treatment_step', { id: newId(), plan_id: id, kind, body, by_id: ctx.workerId, at: now() });

// Open problems a plan can be for, services that can be responsible, and open interventions a component can be.
const options = (store: Store, ctx: WorkContext, personId: string) => ({
  problems: store.all<{ id: string; title: string }>("SELECT id, title FROM clinical_problem WHERE person_id = ? AND state IN ('CONCERN', 'PROVISIONAL', 'ACTIVE') ORDER BY raised_at", personId),
  services: store.all<{ id: string; name: string }>('SELECT id, name FROM service WHERE organisation_id = ? ORDER BY name', ctx.organisationId),
  interventions: store.all<{ id: string; what: string }>("SELECT id, what FROM intervention WHERE person_id = ? AND state IN ('CONSIDERED', 'AWAITING_AUTHORISATION', 'ACTIVE') ORDER BY planned_at", personId),
  components: COMPONENTS, componentStates: COMPONENT_STATES, agreedWith: AGREED_WITH, progress: PROGRESS, review: REVIEW,
});

function shape(store: Store, r: Row, can: { record: boolean; plan: boolean; authorise: boolean }) {
  const id = String(r.id);
  const state = String(r.state);
  const chosen = r.chosenOptionId ? String(r.chosenOptionId) : null;
  const proposed = r.proposedOptionId ? String(r.proposedOptionId) : null;
  const opts = store.all<Row>(`SELECT o.id, o.what, o.benefits, o.risks, w.display_name AS "by", o.added_at AS at FROM treatment_option o
    JOIN workforce_person w ON w.id = o.added_by WHERE o.plan_id = ? ORDER BY o.added_at, o.rowid`, id).map((o) => ({ ...o, chosen: o.id === chosen, proposed: o.id === proposed }));
  const components = store.all<Row>(`SELECT c.id, c.kind, c.what, c.service_id AS serviceId, s.name AS serviceName, c.intervention_id AS interventionId,
      (SELECT state FROM intervention WHERE id = c.intervention_id) AS interventionState, c.state, c.note, w.display_name AS "by", c.updated_at AS at
    FROM treatment_component c JOIN service s ON s.id = c.service_id JOIN workforce_person w ON w.id = COALESCE(c.updated_by, c.added_by)
    WHERE c.plan_id = ? ORDER BY c.added_at, c.rowid`, id)
    .map((c) => ({ ...c, kindLabel: COMPONENTS[String(c.kind)] ?? String(c.kind), stateLabel: COMPONENT_STATES[String(c.state)] ?? String(c.state) }));
  const progress = store.all<Row>(`SELECT g.progress, g.note, w.display_name AS "by", g.at FROM treatment_progress g JOIN workforce_person w ON w.id = g.by_id
    WHERE g.plan_id = ? ORDER BY g.at DESC, g.rowid DESC LIMIT 20`, id).map((g) => ({ ...g, progressLabel: PROGRESS[String(g.progress)] ?? String(g.progress) }));
  const actions: string[] = [];
  if (['DRAFT', 'AWAITING_AGREEMENT', 'ACTIVE'].includes(state) && can.plan) actions.push('option');
  if (state === 'DRAFT' && can.plan && opts.length) actions.push('propose');
  if (['DRAFT', 'AWAITING_AGREEMENT'].includes(state) && can.authorise && opts.length) actions.push('agree');
  if (state === 'AWAITING_AGREEMENT' && can.authorise) actions.push('not-agreed');
  if (OPEN.includes(state) && can.plan) actions.push('component');
  if (state === 'AGREED' && can.plan) actions.push('start');
  if (state === 'ACTIVE' && can.record) actions.push('progress');
  if (state === 'ACTIVE' && can.plan) actions.push('review');
  if (['DRAFT', 'AWAITING_AGREEMENT', 'AGREED'].includes(state) && can.plan) actions.push('stop');
  if (OPEN.includes(state) && can.plan) actions.push('error');
  const latest = progress[0] as (Row & { progressLabel: string }) | undefined;
  return {
    ...r, id, state, stateLabel: STATES[state], version: Number(r.version), options: opts, chosen: opts.find((o) => o.chosen) ?? null, proposed: opts.find((o) => o.proposed) ?? null,
    agreedWithLabel: r.agreedWith ? AGREED_WITH[String(r.agreedWith)] ?? String(r.agreedWith) : null,
    components, progress, latestProgress: latest ?? null, offTrack: state === 'ACTIVE' && !!latest && latest.progress !== 'ON_TRACK',
    reviewDue: r.reviewDue === null ? null : String(r.reviewDue), reviewOverdue: state === 'ACTIVE' && !!r.reviewDue && String(r.reviewDue) <= todayLocal(),
    canUpdateComponents: can.record && ['AGREED', 'ACTIVE'].includes(state),
    actions,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM treatment_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.plan_id = ? ORDER BY s.at, s.rowid`, id).map((s) => ({ ...s, kindLabel: STEPS[String(s.kind)] ?? String(s.kind) })),
    history: history(store, 'treatment_plan', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE t.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That treatment plan is no longer in SHIFT.');
  return r;
};

export function create(store: Store, ctx: WorkContext, personId: string, b: { need?: string; problemId?: string; goal?: string }) {
  enforce(store, ctx, { op: 'TREATMENT_PLAN', personId, cap: 'treatmentplan.plan' }, personId);
  let problemId: string | null = null;
  if (b.problemId) {
    if (!options(store, ctx, personId).problems.some((p) => p.id === b.problemId)) throw new HttpError(400, 'PROBLEM', 'That problem is no longer open.');
    problemId = String(b.problemId);
  }
  const need = text(b.need, 500);
  if (!problemId && need.length < 5) throw new HttpError(400, 'NEED_REQUIRED', 'Say what needs treating: choose an open problem or describe the need.');
  const goal = text(b.goal, 500);
  if (goal.length < 5) throw new HttpError(400, 'GOAL_REQUIRED', 'Write the goal the person and team are aiming for, e.g. "Chest clear and home by Friday".');
  const id = newId();
  store.tx(() => {
    store.insert('treatment_plan', {
      id, person_id: personId, service_id: ctx.serviceId, need: need || null, problem_id: problemId, goal, state: 'DRAFT', version: 1,
      created_by: ctx.workerId, created_at: now(),
    });
    recordInitial(store, 'treatment_plan', id, 'DRAFT', { actorId: ctx.workerId, workContextId: ctx.id }, goal.slice(0, 200));
    const title = problemId ? store.get<{ title: string }>('SELECT title FROM clinical_problem WHERE id = ?', problemId)?.title : null;
    addStep(store, ctx, id, 'NEED', `${[title, need].filter(Boolean).join('. ')}. Goal: ${goal}`);
    logged(store, ctx, 'TREATMENT_PLAN_CREATE', personId, id, goal.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; what?: string; benefits?: string; risks?: string; optionId?: string; agreedWith?: string; kind?: string; serviceId?: string;
    interventionId?: string; componentId?: string; state?: string; progress?: string; outcome?: string; goal?: string; reviewDue?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const cap: Cap = ['progress', 'component-state'].includes(action) ? 'treatmentplan.record'
    : ['agree', 'not-agreed'].includes(action) ? 'treatmentplan.authorise' : 'treatmentplan.plan';
  enforce(store, ctx, { op: 'TREATMENT_PLAN', personId, cap }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This treatment plan is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const option = (optionId: unknown) => {
    const o = store.get<{ id: string; what: string }>('SELECT id, what FROM treatment_option WHERE id = ? AND plan_id = ?', String(optionId ?? ''), id);
    if (!o) throw new HttpError(400, 'OPTION_REQUIRED', 'Choose one of the options.');
    return o;
  };
  const reviewDate = () => {
    const d = date(b.reviewDue);
    if (b.reviewDue && (!d || d < todayLocal())) throw new HttpError(400, 'REVIEW_DATE', 'The review date must be today or later.');
    return d || null;
  };
  switch (action) {
    case 'option': {
      inState('DRAFT', 'AWAITING_AGREEMENT', 'ACTIVE');
      const what = text(b.what, 300);
      if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what the option is, e.g. "Oral antibiotics and chest physiotherapy".');
      const benefits = text(b.benefits, 500) || null;
      const risks = text(b.risks, 500) || null;
      store.tx(() => {
        store.insert('treatment_option', { id: newId(), plan_id: id, what, benefits, risks, added_by: ctx.workerId, added_at: at });
        addStep(store, ctx, id, 'OPTION', [what, benefits ? `Benefits: ${benefits}` : '', risks ? `Risks: ${risks}` : ''].filter(Boolean).join('. '));
        logged(store, ctx, 'TREATMENT_PLAN_OPTION', personId, id, what.slice(0, 200));
      });
      break;
    }
    case 'propose': {
      inState('DRAFT');
      const o = option(b.optionId);
      store.tx(() => {
        transition(store, 'treatment_plan', id, 'AWAITING_AGREEMENT', who, o.what.slice(0, 200));
        store.run('UPDATE treatment_plan SET proposed_option_id = ? WHERE id = ?', o.id, id);
        addStep(store, ctx, id, 'PROPOSED', `${o.what}.${note ? ` ${note}` : ''} Waiting for a doctor or therapist to agree it with the person.`);
        logged(store, ctx, 'TREATMENT_PLAN_PROPOSE', personId, id, o.what.slice(0, 200));
      });
      break;
    }
    case 'agree': {
      inState('DRAFT', 'AWAITING_AGREEMENT');
      const o = option(b.optionId || r.proposedOptionId);
      const agreedWith = AGREED_WITH[String(b.agreedWith)] ? String(b.agreedWith) : '';
      if (!agreedWith) throw new HttpError(400, 'AGREED_WITH_REQUIRED', 'Choose who agreed the plan.');
      if (agreedWith === 'UNABLE') need(10, 'Write why they cannot agree and who was consulted, e.g. "Delirious; discussed with daughter Mere, who agrees".');
      const to = r.startedAt ? 'ACTIVE' : 'AGREED';
      store.tx(() => {
        transition(store, 'treatment_plan', id, to, who, `Agreed: ${o.what}`.slice(0, 200));
        store.run('UPDATE treatment_plan SET proposed_option_id = NULL, chosen_option_id = ?, agreed_with = ?, agreement_note = ?, authorised_by = ?, authorised_at = ? WHERE id = ?',
          o.id, agreedWith, note || null, ctx.workerId, at, id);
        addStep(store, ctx, id, 'AGREED', `${o.what}. Agreed with ${AGREED_WITH[agreedWith].toLowerCase()}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'TREATMENT_PLAN_AGREE', personId, id, o.what.slice(0, 200));
      });
      break;
    }
    case 'not-agreed': {
      inState('AWAITING_AGREEMENT');
      need(5, 'Write why it was not agreed and what to consider instead.');
      const back = r.startedAt ? 'ACTIVE' : 'DRAFT';
      store.tx(() => {
        transition(store, 'treatment_plan', id, back, who, note.slice(0, 200));
        store.run('UPDATE treatment_plan SET proposed_option_id = NULL WHERE id = ?', id);
        addStep(store, ctx, id, 'NOT_AGREED', `${note}${back === 'ACTIVE' ? ' The agreed plan carries on.' : ''}`);
        logged(store, ctx, 'TREATMENT_PLAN_NOT_AGREED', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'component': {
      inState(...OPEN);
      const kind = COMPONENTS[String(b.kind)] ? String(b.kind) : '';
      if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what kind of component it is.');
      const o = options(store, ctx, personId);
      let interventionId: string | null = null;
      let what = text(b.what, 300);
      if (kind === 'INTERVENTION' && b.interventionId) {
        const i = o.interventions.find((x) => x.id === b.interventionId);
        if (!i) throw new HttpError(400, 'INTERVENTION', 'That intervention is no longer open.');
        interventionId = i.id;
        what = what || i.what;
      }
      if (what.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what will be done.');
      const service = o.services.find((s) => s.id === b.serviceId);
      if (!service) throw new HttpError(400, 'SERVICE_REQUIRED', 'Choose which service is responsible for it.');
      store.tx(() => {
        store.insert('treatment_component', {
          id: newId(), plan_id: id, kind, what, service_id: service.id, intervention_id: interventionId, state: state === 'ACTIVE' ? 'UNDER_WAY' : 'PLANNED',
          note: note || null, added_by: ctx.workerId, added_at: at,
        });
        if (state === 'ACTIVE') store.run('UPDATE treatment_plan SET version = version + 1 WHERE id = ?', id);
        addStep(store, ctx, id, 'COMPONENT', `${COMPONENTS[kind]}: ${what}. Responsible: ${service.name}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'TREATMENT_PLAN_COMPONENT', personId, id, what.slice(0, 200));
      });
      break;
    }
    case 'component-state': {
      inState('AGREED', 'ACTIVE');
      const c = store.get<{ id: string; what: string; state: string }>('SELECT id, what, state FROM treatment_component WHERE id = ? AND plan_id = ?', String(b.componentId ?? ''), id);
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'That component is no longer in this plan.');
      const to = COMPONENT_STATES[String(b.state)] ? String(b.state) : '';
      if (!to || to === c.state) throw new HttpError(400, 'STATE_REQUIRED', 'Choose what has happened to it.');
      if (to === 'STOPPED') need(5, 'Write why it was stopped.');
      store.tx(() => {
        store.run('UPDATE treatment_component SET state = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?', to, note || null, ctx.workerId, at, c.id);
        addStep(store, ctx, id, 'COMPONENT_STATE', `${c.what}: ${COMPONENT_STATES[to].toLowerCase()}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'TREATMENT_PLAN_COMPONENT_STATE', personId, id, `${c.what}: ${to}`.slice(0, 200));
      });
      break;
    }
    case 'start': {
      inState('AGREED');
      const n = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM treatment_component WHERE plan_id = ?', id)?.n ?? 0;
      if (!n) throw new HttpError(400, 'COMPONENTS_REQUIRED', 'Add what will be done, and which service is responsible, before starting.');
      const reviewDue = reviewDate();
      store.tx(() => {
        transition(store, 'treatment_plan', id, 'ACTIVE', who, 'Started');
        store.run('UPDATE treatment_plan SET started_at = ?, review_due = COALESCE(?, review_due) WHERE id = ?', at, reviewDue, id);
        store.run("UPDATE treatment_component SET state = 'UNDER_WAY', updated_by = ?, updated_at = ? WHERE plan_id = ? AND state = 'PLANNED'", ctx.workerId, at, id);
        addStep(store, ctx, id, 'STARTED', `Started.${reviewDue ? ` Review by ${reviewDue}.` : ''}${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'TREATMENT_PLAN_START', personId, id);
      });
      break;
    }
    case 'progress': {
      inState('ACTIVE');
      const progress = PROGRESS[String(b.progress)] ? String(b.progress) : '';
      if (!progress) throw new HttpError(400, 'PROGRESS_REQUIRED', 'Choose how it is going.');
      need(5, 'Write what you have seen, e.g. "Walked to the bathroom with a frame; less breathless".');
      store.tx(() => {
        store.insert('treatment_progress', { id: newId(), plan_id: id, progress, note, by_id: ctx.workerId, at });
        addStep(store, ctx, id, 'PROGRESS', `${PROGRESS[progress]}: ${note}`);
        logged(store, ctx, 'TREATMENT_PLAN_PROGRESS', personId, id, progress);
      });
      break;
    }
    case 'review': {
      inState('ACTIVE');
      const outcome = REVIEW[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose whether to continue, change, complete or stop the plan.');
      need(5, 'Write how the person is progressing towards the goal.');
      const reviewDue = reviewDate();
      if (outcome === 'CONTINUE') {
        store.tx(() => {
          store.run('UPDATE treatment_plan SET review_due = ? WHERE id = ?', reviewDue, id);
          addStep(store, ctx, id, 'REVIEW', `Continue: ${note}${reviewDue ? ` Review again by ${reviewDue}.` : ''}`);
          logged(store, ctx, 'TREATMENT_PLAN_REVIEW', personId, id, 'Continue');
        });
      } else if (outcome === 'MODIFY') {
        const goal = text(b.goal, 500) || String(r.goal);
        const newOption = b.optionId && b.optionId !== r.chosenOptionId ? option(b.optionId) : null;
        store.tx(() => {
          if (newOption) transition(store, 'treatment_plan', id, 'AWAITING_AGREEMENT', who, 'Different option; needs agreeing again');
          store.run('UPDATE treatment_plan SET goal = ?, review_due = ?, version = version + 1, proposed_option_id = ? WHERE id = ?',
            goal, reviewDue, newOption?.id ?? null, id);
          addStep(store, ctx, id, 'MODIFIED', `Version ${Number(r.version) + 1}. ${goal !== String(r.goal) ? `Goal now: ${goal}. ` : ''}${newOption ? `Change to: ${newOption.what}; needs agreeing again. ` : ''}${note}`);
          logged(store, ctx, 'TREATMENT_PLAN_MODIFY', personId, id, (newOption?.what ?? goal).slice(0, 200));
        });
      } else {
        const to = outcome === 'COMPLETE' ? 'COMPLETED' : 'STOPPED';
        store.tx(() => {
          transition(store, 'treatment_plan', id, to, who, note.slice(0, 200));
          store.run('UPDATE treatment_plan SET ended_by = ?, ended_at = ?, end_note = ?, review_due = NULL WHERE id = ?', ctx.workerId, at, note, id);
          store.run("UPDATE treatment_component SET state = ?, updated_by = ?, updated_at = ? WHERE plan_id = ? AND state IN ('PLANNED', 'UNDER_WAY')",
            to === 'COMPLETED' ? 'DONE' : 'STOPPED', ctx.workerId, at, id);
          addStep(store, ctx, id, to, note);
          logged(store, ctx, to === 'COMPLETED' ? 'TREATMENT_PLAN_COMPLETE' : 'TREATMENT_PLAN_STOP', personId, id, note.slice(0, 200));
        });
      }
      break;
    }
    case 'stop': {
      inState('DRAFT', 'AWAITING_AGREEMENT', 'AGREED');
      need(5, 'Write why it is not going ahead.');
      store.tx(() => {
        transition(store, 'treatment_plan', id, 'STOPPED', who, note.slice(0, 200));
        store.run('UPDATE treatment_plan SET ended_by = ?, ended_at = ?, end_note = ?, review_due = NULL WHERE id = ?', ctx.workerId, at, note, id);
        store.run("UPDATE treatment_component SET state = 'STOPPED', updated_by = ?, updated_at = ? WHERE plan_id = ? AND state IN ('PLANNED', 'UNDER_WAY')", ctx.workerId, at, id);
        addStep(store, ctx, id, 'STOPPED', note);
        logged(store, ctx, 'TREATMENT_PLAN_STOP', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      inState(...OPEN);
      need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".');
      store.tx(() => {
        transition(store, 'treatment_plan', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE treatment_plan SET ended_by = ?, ended_at = ?, end_note = ?, review_due = NULL WHERE id = ?', ctx.workerId, at, note, id);
        addStep(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'TREATMENT_PLAN_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Treatment plans view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = { record: may(store, ctx, personId, 'treatmentplan.record'), plan: may(store, ctx, personId, 'treatmentplan.plan'), authorise: may(store, ctx, personId, 'treatmentplan.authorise') };
  const all = store.all<Row>(`${Q} WHERE t.person_id = ? ORDER BY t.created_at DESC`, personId).map((r) => shape(store, r, can));
  return {
    open: all.filter((t) => OPEN.includes(t.state)),
    ended: all.filter((t) => !OPEN.includes(t.state)),
    canRecord: can.record, canPlan: can.plan, canAuthorise: can.authorise, options: options(store, ctx, personId),
  };
}

// Home → Treatment plans: waiting for agreement, not going to plan, reviews due, in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('treatmentplan.plan') && !ctx.role.capabilities.includes('treatmentplan.authorise')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include treatment plans`);
  }
  const inService = `EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = t.person_id AND e.service_id = ? AND e.state = 'ACTIVE')
     OR EXISTS (SELECT 1 FROM care_relationship c WHERE c.person_id = t.person_id AND c.service_id = ? AND c.ended_at IS NULL)`;
  const can = { record: false, plan: false, authorise: false };
  const rows = store.all<Row>(`${Q} WHERE t.state IN ('DRAFT', 'AWAITING_AGREEMENT', 'AGREED', 'ACTIVE') AND (${inService}) ORDER BY t.created_at`, ctx.serviceId, ctx.serviceId)
    .map((r) => shape(store, r, can));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_TREATMENT_PLANS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toAgree: rows.filter((r) => r.state === 'AWAITING_AGREEMENT'),
    offTrack: rows.filter((r) => r.offTrack),
    reviews: rows.filter((r) => r.reviewOverdue),
    notStarted: rows.filter((r) => r.state === 'DRAFT' || r.state === 'AGREED'),
    active: rows.filter((r) => r.state === 'ACTIVE').length,
    canAuthorise: ctx.role.capabilities.includes('treatmentplan.authorise'),
  };
}
