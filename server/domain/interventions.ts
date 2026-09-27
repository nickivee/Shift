import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { CATEGORIES, CATEGORY_BY_ID, FREQUENCIES, REVIEW } from '../config/interventions.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Intervention (Shared Lifecycle Object 276):
//   intervention considered → planned → authorised where required → delivered/performed →
//   response → reassessment → continued/modified/ceased.
// A nurse, doctor or therapist plans a specific intervention, what it is for (an open problem
// or symptom) and how often. Devices and procedures wait for a doctor's authorisation first
// (ORG-SYN-001; RR-INT-001). Anyone caring for the person records each time it is done or not
// done, and how they responded; SHIFT shows when it is next due. A review continues, changes
// or stops it; changing a device or procedure needs authorising again.

type Row = Record<string, string | number | null>;
type Cap = 'intervention.record' | 'intervention.plan' | 'intervention.authorise';
const STATES: Record<string, string> = {
  CONSIDERED: 'Being considered', AWAITING_AUTHORISATION: 'Waiting for authorisation', ACTIVE: 'Under way', DECLINED: 'Not authorised',
  CEASED: 'Stopped', ENTERED_IN_ERROR: 'Entered in error',
};
const STEPS: Record<string, string> = {
  CONSIDERED: 'Considered', PLANNED: 'Planned', AUTHORISED: 'Authorised', DECLINED: 'Not authorised', DONE: 'Done', NOT_DONE: 'Not done',
  REVIEW: 'Reviewed', MODIFIED: 'Changed', CEASED: 'Stopped', ERROR: 'Entered in error',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-INT-001'];

const Q = `
  SELECT i.id, i.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = i.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         i.service_id AS serviceId, i.category, i.what, i.purpose, i.problem_id AS problemId, i.symptom_id AS symptomId,
         (SELECT title FROM clinical_problem WHERE id = i.problem_id) AS problemTitle,
         (SELECT CASE WHEN kind = 'OTHER' THEN name ELSE kind END || COALESCE(' (' || site || ')', '') FROM symptom WHERE id = i.symptom_id) AS symptomTitle,
         i.frequency, i.every_hours AS everyHours, i.state, i.start_at AS startAt, i.next_due AS nextDue, i.review_due AS reviewDue,
         i.last_done_at AS lastDoneAt, pb.display_name AS plannedBy, i.planned_at AS plannedAt, ab.display_name AS authorisedBy, i.authorised_at AS authorisedAt,
         i.auth_note AS authNote, cb.display_name AS ceasedBy, i.ceased_at AS ceasedAt, i.cease_note AS ceaseNote
    FROM intervention i
    JOIN person p ON p.id = i.person_id
    JOIN workforce_person pb ON pb.id = i.planned_by
    LEFT JOIN workforce_person ab ON ab.id = i.authorised_by
    LEFT JOIN workforce_person cb ON cb.id = i.ceased_by`;

const SYMPTOM_LABELS: Record<string, string> = {
  PAIN: 'Pain', BREATHLESSNESS: 'Breathlessness', NAUSEA: 'Nausea or vomiting', FATIGUE: 'Tiredness', DIZZINESS: 'Dizziness', ITCH: 'Itch', AGITATION: 'Restlessness or agitation',
};
const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'INTERVENTION', personId, cap }).decision === 'ALLOW';
const addHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3600_000).toISOString();
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'intervention', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('intervention_step', { id: newId(), intervention_id: id, kind, body, by_id: ctx.workerId, at: now() });

const frequencyLabel = (f: string, h: number | null) => (f === 'HOURS' ? `Every ${h} hours` : FREQUENCIES[f] ?? f);

// When it is next due, from the last time it was done (or the start).
function nextDue(frequency: string, everyHours: number | null, startAt: string, lastDoneAt: string | null) {
  if (frequency === 'AS_NEEDED') return null;
  if (frequency === 'ONCE') return lastDoneAt ? null : startAt;
  if (!lastDoneAt) return startAt;
  return addHours(lastDoneAt, frequency === 'DAILY' ? 24 : Number(everyHours));
}

// Open problems and symptoms an intervention can be for.
function purposes(store: Store, personId: string) {
  const problems = store.all<{ id: string; title: string }>("SELECT id, title FROM clinical_problem WHERE person_id = ? AND state IN ('CONCERN', 'PROVISIONAL', 'ACTIVE') ORDER BY raised_at", personId)
    .map((p) => ({ id: `problem:${p.id}`, label: `Problem: ${p.title}` }));
  const symptoms = store.all<{ id: string; kind: string; name: string | null; site: string | null }>(
    "SELECT id, kind, name, site FROM symptom WHERE person_id = ? AND state IN ('RECORDED', 'ASSESSED', 'INTERVENTION', 'REASSESSED') ORDER BY recorded_at", personId)
    .map((s) => ({ id: `symptom:${s.id}`, label: `Symptom: ${s.kind === 'OTHER' ? s.name : SYMPTOM_LABELS[s.kind] ?? s.kind}${s.site ? ` (${s.site})` : ''}` }));
  return [...problems, ...symptoms];
}
const options = (store: Store, personId: string) => ({
  categories: CATEGORIES, frequencies: FREQUENCIES, review: REVIEW, purposes: purposes(store, personId),
});

function shape(store: Store, r: Row, can: { record: boolean; plan: boolean; authorise: boolean }) {
  const id = String(r.id);
  const state = String(r.state);
  const cat = CATEGORY_BY_ID.get(String(r.category));
  const deliveries = store.all<Row>(`SELECT d.done, d.note, d.response, w.display_name AS "by", d.at FROM intervention_delivery d JOIN workforce_person w ON w.id = d.by_id
    WHERE d.intervention_id = ? ORDER BY d.at DESC, d.rowid DESC LIMIT 20`, id).map((d) => ({ ...d, done: Boolean(d.done) }));
  const actions: string[] = [];
  if (state === 'CONSIDERED' && can.plan) actions.push('plan', 'cease');
  if (state === 'AWAITING_AUTHORISATION' && can.authorise) actions.push('authorise', 'decline');
  if (state === 'AWAITING_AUTHORISATION' && can.plan) actions.push('cease');
  if (state === 'ACTIVE' && can.record && !(r.frequency === 'ONCE' && r.lastDoneAt)) actions.push('deliver');
  if (state === 'ACTIVE' && can.plan) actions.push('review');
  if (can.plan && !['CEASED', 'DECLINED', 'ENTERED_IN_ERROR'].includes(state)) actions.push('error');
  const due = r.nextDue ? String(r.nextDue) : null;
  return {
    ...r, id, state, stateLabel: STATES[state], categoryLabel: cat?.label ?? String(r.category), needsAuthorisation: cat?.authorise ?? false,
    frequencyLabel: frequencyLabel(String(r.frequency), r.everyHours === null ? null : Number(r.everyHours)),
    nextDue: due, dueNow: state === 'ACTIVE' && !!due && due <= now(), reviewDue: r.reviewDue === null ? null : String(r.reviewDue),
    reviewOverdue: state === 'ACTIVE' && !!r.reviewDue && String(r.reviewDue) <= todayLocal(),
    forLabel: r.problemTitle ? `Problem: ${r.problemTitle}` : r.symptomTitle ? `Symptom: ${String(r.symptomTitle).replace(/^[A-Z_]+/, (k) => SYMPTOM_LABELS[k] ?? k)}` : null,
    deliveries, actions,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM intervention_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.intervention_id = ? ORDER BY s.at, s.rowid`, id).map((s) => ({ ...s, kindLabel: STEPS[String(s.kind)] ?? String(s.kind) })),
    history: history(store, 'intervention', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE i.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That intervention is no longer in SHIFT.');
  return r;
};

// Checks the how-often fields, shared by planning and changing.
function schedule(b: { frequency?: string; everyHours?: unknown }) {
  const frequency = FREQUENCIES[String(b.frequency)] ? String(b.frequency) : '';
  if (!frequency) throw new HttpError(400, 'FREQUENCY_REQUIRED', 'Choose how often.');
  let everyHours: number | null = null;
  if (frequency === 'HOURS') {
    everyHours = Number(b.everyHours);
    if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 12) throw new HttpError(400, 'HOURS_REQUIRED', 'Give how many hours apart, from 1 to 12.');
  }
  return { frequency, everyHours };
}

export function plan(store: Store, ctx: WorkContext, personId: string,
  b: { category?: string; what?: string; purpose?: string; forId?: string; frequency?: string; everyHours?: unknown; startAt?: string; reviewDue?: string; considerOnly?: unknown }) {
  enforce(store, ctx, { op: 'INTERVENTION', personId, cap: 'intervention.plan' }, personId);
  const cat = CATEGORY_BY_ID.get(String(b.category));
  if (!cat) throw new HttpError(400, 'CATEGORY_REQUIRED', 'Choose what kind of intervention it is.');
  const what = text(b.what, 300);
  if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Say exactly what is to be done, e.g. "Deep breathing and coughing exercises, 10 breaths".');
  const { frequency, everyHours } = schedule(b);
  const start = b.startAt ? Date.parse(String(b.startAt)) : Date.now();
  if (!Number.isFinite(start)) throw new HttpError(400, 'START', 'Give a valid start time.');
  const reviewDue = date(b.reviewDue);
  if (b.reviewDue && (!reviewDue || reviewDue < todayLocal())) throw new HttpError(400, 'REVIEW_DATE', 'The review date must be today or later.');
  let problemId: string | null = null;
  let symptomId: string | null = null;
  const forId = String(b.forId ?? '');
  if (forId) {
    const [kind, ref] = forId.split(':');
    const ok = purposes(store, personId).some((p) => p.id === forId);
    if (!ok) throw new HttpError(400, 'PURPOSE', 'That problem or symptom is no longer open.');
    if (kind === 'problem') problemId = ref; else symptomId = ref;
  }
  const purpose = text(b.purpose, 300) || null;
  if (!forId && !purpose) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Say what it is for: choose a problem or symptom, or write the reason.');
  const consider = b.considerOnly === true || b.considerOnly === 'true';
  const state = consider ? 'CONSIDERED' : cat.authorise ? 'AWAITING_AUTHORISATION' : 'ACTIVE';
  const startAt = new Date(start).toISOString();
  const id = newId();
  store.tx(() => {
    store.insert('intervention', {
      id, person_id: personId, service_id: ctx.serviceId, category: cat.id, what, purpose, problem_id: problemId, symptom_id: symptomId,
      frequency, every_hours: everyHours, state, start_at: startAt, next_due: state === 'ACTIVE' ? nextDue(frequency, everyHours, startAt, null) : null,
      review_due: reviewDue || null, planned_by: ctx.workerId, planned_at: now(),
    });
    recordInitial(store, 'intervention', id, state, { actorId: ctx.workerId, workContextId: ctx.id }, what.slice(0, 200));
    addStep(store, ctx, id, consider ? 'CONSIDERED' : 'PLANNED', `${what}. ${frequencyLabel(frequency, everyHours)}.${state === 'AWAITING_AUTHORISATION' ? ' Needs a doctor to authorise it before it starts.' : ''}`);
    logged(store, ctx, consider ? 'INTERVENTION_CONSIDER' : 'INTERVENTION_PLAN', personId, id, what.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; done?: unknown; response?: string; outcome?: string; what?: string; frequency?: string; everyHours?: unknown; reviewDue?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const cap: Cap = action === 'deliver' ? 'intervention.record' : action === 'authorise' || action === 'decline' ? 'intervention.authorise' : 'intervention.plan';
  enforce(store, ctx, { op: 'INTERVENTION', personId, cap }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This intervention is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const cat = CATEGORY_BY_ID.get(String(r.category));
  switch (action) {
    case 'plan': {
      inState('CONSIDERED');
      const to = cat?.authorise ? 'AWAITING_AUTHORISATION' : 'ACTIVE';
      store.tx(() => {
        transition(store, 'intervention', id, to, who, 'Planned');
        store.run('UPDATE intervention SET start_at = ?, next_due = ? WHERE id = ?', at, to === 'ACTIVE' ? nextDue(String(r.frequency), r.everyHours === null ? null : Number(r.everyHours), at, null) : null, id);
        addStep(store, ctx, id, 'PLANNED', `Going ahead.${note ? ` ${note}` : ''}${to === 'AWAITING_AUTHORISATION' ? ' Needs a doctor to authorise it before it starts.' : ''}`);
        logged(store, ctx, 'INTERVENTION_PLAN', personId, id);
      });
      break;
    }
    case 'authorise': {
      inState('AWAITING_AUTHORISATION');
      store.tx(() => {
        transition(store, 'intervention', id, 'ACTIVE', who, note.slice(0, 200) || 'Authorised');
        store.run('UPDATE intervention SET authorised_by = ?, authorised_at = ?, auth_note = ?, start_at = ?, next_due = ? WHERE id = ?', ctx.workerId, at, note || null,
          at, nextDue(String(r.frequency), r.everyHours === null ? null : Number(r.everyHours), at, r.lastDoneAt ? String(r.lastDoneAt) : null), id);
        addStep(store, ctx, id, 'AUTHORISED', note || 'Authorised.');
        logged(store, ctx, 'INTERVENTION_AUTHORISE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'decline': {
      inState('AWAITING_AUTHORISATION');
      need(5, 'Write why it is not authorised, and what to do instead.');
      store.tx(() => {
        transition(store, 'intervention', id, 'DECLINED', who, note.slice(0, 200));
        store.run('UPDATE intervention SET authorised_by = ?, authorised_at = ?, auth_note = ?, next_due = NULL WHERE id = ?', ctx.workerId, at, note, id);
        addStep(store, ctx, id, 'DECLINED', note);
        logged(store, ctx, 'INTERVENTION_DECLINE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'deliver': {
      inState('ACTIVE');
      const done = !(b.done === false || b.done === 'false');
      if (!done) need(5, 'Write why it was not done, e.g. "Declined; wants to rest. Will offer again at 14:00".');
      const response = text(b.response, 1000);
      const nd = done ? nextDue(String(r.frequency), r.everyHours === null ? null : Number(r.everyHours), String(r.startAt), at) : r.nextDue;
      store.tx(() => {
        store.insert('intervention_delivery', { id: newId(), intervention_id: id, done: done ? 1 : 0, note: note || null, response: response || null, by_id: ctx.workerId, at });
        if (done) store.run('UPDATE intervention SET last_done_at = ?, next_due = ? WHERE id = ?', at, nd, id);
        addStep(store, ctx, id, done ? 'DONE' : 'NOT_DONE', [note, response ? `Response: ${response}` : ''].filter(Boolean).join(' ') || 'Done.');
        logged(store, ctx, done ? 'INTERVENTION_DONE' : 'INTERVENTION_NOT_DONE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'review': {
      inState('ACTIVE');
      const outcome = REVIEW[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose whether to continue, change or stop it.');
      need(5, 'Write how they have responded and why.');
      const reviewDue = date(b.reviewDue);
      if (b.reviewDue && (!reviewDue || reviewDue < todayLocal())) throw new HttpError(400, 'REVIEW_DATE', 'The next review must be today or later.');
      if (outcome === 'CONTINUE') {
        store.tx(() => {
          store.run('UPDATE intervention SET review_due = ? WHERE id = ?', reviewDue || null, id);
          addStep(store, ctx, id, 'REVIEW', `Continue: ${note}${reviewDue ? ` Review again by ${reviewDue}.` : ''}`);
          logged(store, ctx, 'INTERVENTION_REVIEW', personId, id, 'Continue');
        });
      } else if (outcome === 'MODIFY') {
        const what = text(b.what, 300) || String(r.what);
        const { frequency, everyHours } = schedule({ frequency: b.frequency || String(r.frequency), everyHours: b.everyHours || r.everyHours });
        const reauth = !!cat?.authorise && what !== String(r.what);
        store.tx(() => {
          if (reauth) transition(store, 'intervention', id, 'AWAITING_AUTHORISATION', who, 'Changed; needs authorising again');
          store.run('UPDATE intervention SET what = ?, frequency = ?, every_hours = ?, review_due = ?, next_due = ? WHERE id = ?', what, frequency, everyHours, reviewDue || null,
            reauth ? null : nextDue(frequency, everyHours, String(r.startAt), r.lastDoneAt ? String(r.lastDoneAt) : null), id);
          addStep(store, ctx, id, 'MODIFIED', `${what}. ${frequencyLabel(frequency, everyHours)}. ${note}${reauth ? ' Needs authorising again.' : ''}`);
          logged(store, ctx, 'INTERVENTION_MODIFY', personId, id, what.slice(0, 200));
        });
      } else {
        store.tx(() => {
          transition(store, 'intervention', id, 'CEASED', who, note.slice(0, 200));
          store.run('UPDATE intervention SET ceased_by = ?, ceased_at = ?, cease_note = ?, next_due = NULL, review_due = NULL WHERE id = ?', ctx.workerId, at, note, id);
          addStep(store, ctx, id, 'CEASED', note);
          logged(store, ctx, 'INTERVENTION_CEASE', personId, id, note.slice(0, 200));
        });
      }
      break;
    }
    case 'cease': {
      inState('CONSIDERED', 'AWAITING_AUTHORISATION');
      need(5, 'Write why it is not going ahead.');
      store.tx(() => {
        transition(store, 'intervention', id, 'CEASED', who, note.slice(0, 200));
        store.run('UPDATE intervention SET ceased_by = ?, ceased_at = ?, cease_note = ?, next_due = NULL WHERE id = ?', ctx.workerId, at, note, id);
        addStep(store, ctx, id, 'CEASED', note);
        logged(store, ctx, 'INTERVENTION_CEASE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      inState('CONSIDERED', 'AWAITING_AUTHORISATION', 'ACTIVE');
      need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".');
      store.tx(() => {
        transition(store, 'intervention', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE intervention SET ceased_by = ?, ceased_at = ?, cease_note = ?, next_due = NULL, review_due = NULL WHERE id = ?', ctx.workerId, at, note, id);
        addStep(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'INTERVENTION_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, load(store, id), { record: true, plan: true, authorise: true });
}

// The person's Interventions view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = { record: may(store, ctx, personId, 'intervention.record'), plan: may(store, ctx, personId, 'intervention.plan'), authorise: may(store, ctx, personId, 'intervention.authorise') };
  const all = store.all<Row>(`${Q} WHERE i.person_id = ? ORDER BY i.planned_at DESC`, personId).map((r) => shape(store, r, can));
  const openStates = ['CONSIDERED', 'AWAITING_AUTHORISATION', 'ACTIVE'];
  return {
    open: all.filter((i) => openStates.includes(i.state)).sort((a, b) => String(a.nextDue ?? '9').localeCompare(String(b.nextDue ?? '9'))),
    ended: all.filter((i) => !openStates.includes(i.state)),
    canRecord: can.record, canPlan: can.plan, canAuthorise: can.authorise, options: options(store, personId),
  };
}

// For the record header: interventions due now.
export function current(store: Store, personId: string) {
  return store.all<{ what: string }>("SELECT what FROM intervention WHERE person_id = ? AND state = 'ACTIVE' AND next_due IS NOT NULL AND next_due <= ? ORDER BY next_due", personId, now()).map((i) => i.what);
}

// Home → Interventions: waiting for authorisation, due now, reviews due, in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('intervention.plan') && !ctx.role.capabilities.includes('intervention.authorise')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include planning interventions`);
  }
  const inService = `EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = i.person_id AND e.service_id = ? AND e.state = 'ACTIVE')
     OR EXISTS (SELECT 1 FROM care_relationship c WHERE c.person_id = i.person_id AND c.service_id = ? AND c.ended_at IS NULL)`;
  const can = { record: false, plan: false, authorise: false };
  const rows = store.all<Row>(`${Q} WHERE i.state IN ('CONSIDERED', 'AWAITING_AUTHORISATION', 'ACTIVE') AND (${inService}) ORDER BY i.next_due`, ctx.serviceId, ctx.serviceId)
    .map((r) => shape(store, r, can));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_INTERVENTIONS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toAuthorise: rows.filter((r) => r.state === 'AWAITING_AUTHORISATION'),
    due: rows.filter((r) => r.dueNow),
    reviews: rows.filter((r) => r.reviewOverdue),
    considered: rows.filter((r) => r.state === 'CONSIDERED'),
    active: rows.filter((r) => r.state === 'ACTIVE').length,
    canAuthorise: ctx.role.capabilities.includes('intervention.authorise'),
  };
}
