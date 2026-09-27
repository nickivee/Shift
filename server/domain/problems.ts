import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Clinical problem / concern (Shared Lifecycle Object 273):
//   concern identified → evidence → provisional problem → assessment → active problem →
//   treatment/management linkage → monitoring → improving/stable/worsening → resolved/inactive →
//   recurrence where applicable.
// Anyone caring for the person can raise a concern and add evidence. A nurse, doctor or
// therapist assesses it: working (provisional), confirmed (active) or ruled out. An active
// problem carries how it is being managed, what to watch and when to look again; each review
// records whether it is improving, stable or worse. It is resolved or made inactive, and can
// come back. A .problem entry in the record feeds the same list. Coded diagnoses (SNOMED CT NZ
// Edition, ICD-10-AM) are left to clinical coding (Object 241) and are not required here.

type Row = Record<string, string | number | null>;
type Cap = 'problem.record' | 'problem.manage';
const STATES: Record<string, string> = {
  CONCERN: 'Concern: not yet assessed', PROVISIONAL: 'Working problem', ACTIVE: 'Active', RESOLVED: 'Resolved', INACTIVE: 'Inactive',
  RULED_OUT: 'Ruled out', ENTERED_IN_ERROR: 'Entered in error',
};
export const TRENDS: Record<string, string> = { IMPROVING: 'Improving', STABLE: 'Stable', WORSENING: 'Worse' };
const KINDS: Record<string, string> = {
  RAISED: 'Concern raised', EVIDENCE: 'Evidence', PROVISIONAL: 'Working problem', CONFIRMED: 'Confirmed', PLAN: 'Management', REVIEW: 'Review',
  RESOLVED: 'Resolved', INACTIVE: 'Inactive', RULED_OUT: 'Ruled out', RECURRED: 'Back again', ERROR: 'Entered in error', ENTRY: 'From a .problem entry',
};
const OPEN = ['CONCERN', 'PROVISIONAL', 'ACTIVE'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002'];

const Q = `
  SELECT c.id, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = c.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         c.service_id AS serviceId, c.title, c.state, c.trend, c.onset, c.assessment, c.management, c.monitoring, c.review_due AS reviewDue,
         c.recurrences, rb.display_name AS raisedBy, c.raised_at AS raisedAt, ab.display_name AS assessedBy, c.assessed_at AS assessedAt,
         c.last_review_at AS lastReviewAt, cb.display_name AS closedBy, c.closed_at AS closedAt, c.close_note AS closeNote
    FROM clinical_problem c
    JOIN person p ON p.id = c.person_id
    JOIN workforce_person rb ON rb.id = c.raised_by
    LEFT JOIN workforce_person ab ON ab.id = c.assessed_by
    LEFT JOIN workforce_person cb ON cb.id = c.closed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'PROBLEM', personId, cap }).decision === 'ALLOW';
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'problem', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('problem_step', { id: newId(), problem_id: id, kind, body, by_id: ctx.workerId, at: now() });

function shape(store: Store, r: Row, canRecord: boolean, canManage: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const can: string[] = [];
  if (OPEN.includes(state)) {
    if (canRecord) can.push('evidence');
    if (canManage && state === 'CONCERN') can.push('provisional');
    if (canManage && state !== 'ACTIVE') can.push('confirm', 'rule-out');
    if (canManage && state === 'ACTIVE') can.push('plan');
    if (canRecord && state === 'ACTIVE') can.push('review');
    if (canManage && state === 'ACTIVE') can.push('resolve', 'inactive');
  }
  if (canManage && (state === 'RESOLVED' || state === 'INACTIVE')) can.push('recur');
  if (canManage && state !== 'ENTERED_IN_ERROR') can.push('error');
  return {
    ...r, id, state, reviewDue: r.reviewDue === null ? null : String(r.reviewDue), trend: r.trend === null ? null : String(r.trend), stateLabel: STATES[state], trendLabel: r.trend ? TRENDS[String(r.trend)] : null,
    reviewOverdue: state === 'ACTIVE' && !!r.reviewDue && String(r.reviewDue) < todayLocal(), can,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM problem_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.problem_id = ? ORDER BY s.at, s.rowid`, id).map((s) => ({ ...s, kindLabel: KINDS[String(s.kind)] ?? String(s.kind) })),
    history: history(store, 'problem', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That problem is no longer in SHIFT.');
  return r;
};

export function raise(store: Store, ctx: WorkContext, personId: string, b: { title?: string; evidence?: string; onset?: string }) {
  enforce(store, ctx, { op: 'PROBLEM', personId, cap: 'problem.record' }, personId);
  const title = text(b.title, 200);
  if (title.length < 3) throw new HttpError(400, 'TITLE_REQUIRED', 'Name the concern in a few words, e.g. "New confusion" or "Not eating".');
  const evidence = text(b.evidence);
  if (evidence.length < 10) throw new HttpError(400, 'EVIDENCE_REQUIRED', 'Say what you have seen or been told, e.g. "Not recognising her daughter since this morning; 4AT 6".');
  if (store.get(`SELECT 1 FROM clinical_problem WHERE person_id = ? AND lower(title) = lower(?) AND state IN ('CONCERN', 'PROVISIONAL', 'ACTIVE')`, personId, title)) {
    throw new HttpError(409, 'ALREADY_OPEN', `"${title}" is already on their problem list. Add evidence to it instead.`);
  }
  const id = newId();
  store.tx(() => {
    store.insert('clinical_problem', {
      id, person_id: personId, service_id: ctx.serviceId, title, state: 'CONCERN', onset: date(b.onset) || null, recurrences: 0,
      raised_by: ctx.workerId, raised_at: now(),
    });
    recordInitial(store, 'problem', id, 'CONCERN', { actorId: ctx.workerId, workContextId: ctx.id }, title);
    addStep(store, ctx, id, 'RAISED', evidence);
    logged(store, ctx, 'PROBLEM_RAISE', personId, id, title);
  });
  return forPerson(store, ctx, personId);
}

// A .problem entry (committed through the command line) keeps the problem list in step:
// a new problem is added, or the open one with the same name moves to the entry's status.
export function fromEntry(store: Store, ctx: WorkContext, personId: string, fields: Record<string, unknown>, eventId: string) {
  const title = text(fields.problem, 200);
  if (!title) return;
  const want = fields.status === 'Resolved' ? 'RESOLVED' : fields.status === 'Under investigation' ? 'PROVISIONAL' : 'ACTIVE';
  const note = [`${title} (${String(fields.status ?? 'Active')})`, text(fields.note, 500)].filter(Boolean).join('. ');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const open = store.get<{ id: string; state: string }>(`SELECT id, state FROM clinical_problem WHERE person_id = ? AND lower(title) = lower(?) AND state IN ('CONCERN', 'PROVISIONAL', 'ACTIVE') ORDER BY raised_at DESC`, personId, title);
  if (open) {
    if (open.state !== want && !(open.state === 'ACTIVE' && want === 'PROVISIONAL')) {
      transition(store, 'problem', open.id, want, who, 'From a .problem entry');
      if (want === 'RESOLVED') store.run('UPDATE clinical_problem SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, now(), text(fields.note, 500) || null, open.id);
      else store.run('UPDATE clinical_problem SET assessed_by = ?, assessed_at = ? WHERE id = ?', ctx.workerId, now(), open.id);
    }
    addStep(store, ctx, open.id, 'ENTRY', note);
    return;
  }
  const id = newId();
  store.insert('clinical_problem', {
    id, person_id: personId, service_id: ctx.serviceId, title, state: want, recurrences: 0, raised_by: ctx.workerId, raised_at: now(),
    assessed_by: ctx.workerId, assessed_at: now(), assessment: text(fields.note, 500) || null, source_event_id: eventId,
    closed_by: want === 'RESOLVED' ? ctx.workerId : null, closed_at: want === 'RESOLVED' ? now() : null,
  });
  recordInitial(store, 'problem', id, want, who, 'From a .problem entry');
  addStep(store, ctx, id, 'ENTRY', note);
  logged(store, ctx, 'PROBLEM_FROM_ENTRY', personId, id, title);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; title?: string; management?: string; monitoring?: string; reviewDue?: string; trend?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const recordOnly = action === 'evidence' || action === 'review';
  enforce(store, ctx, { op: 'PROBLEM', personId, cap: recordOnly ? 'problem.record' : 'problem.manage' }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This problem is ${STATES[state].toLowerCase()}.`); };
  const note = text(b.note);
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const move = (to: string, kind: string, body: string, op: string, extra?: () => void) => store.tx(() => {
    transition(store, 'problem', id, to, who, body.slice(0, 200));
    extra?.();
    addStep(store, ctx, id, kind, body);
    logged(store, ctx, op, personId, id, body.slice(0, 200));
  });
  switch (action) {
    case 'evidence': {
      inState(...OPEN);
      need(5, 'Write what you have seen, heard or measured.');
      store.tx(() => { addStep(store, ctx, id, 'EVIDENCE', note); logged(store, ctx, 'PROBLEM_EVIDENCE', personId, id, note.slice(0, 200)); });
      break;
    }
    case 'provisional': {
      inState('CONCERN');
      need(10, 'Write your assessment so far and what you are checking, e.g. "Likely delirium; checking for infection and constipation".');
      const title = text(b.title, 200) || String(r.title);
      move('PROVISIONAL', 'PROVISIONAL', `${title}: ${note}`, 'PROBLEM_PROVISIONAL', () =>
        store.run('UPDATE clinical_problem SET title = ?, assessment = ?, assessed_by = ?, assessed_at = ? WHERE id = ?', title, note, ctx.workerId, at, id));
      break;
    }
    case 'confirm': {
      inState('CONCERN', 'PROVISIONAL');
      need(10, 'Write the assessment that confirms it, e.g. "Delirium from a urinary infection: 4AT 6, urine culture grew E. coli".');
      const title = text(b.title, 200) || String(r.title);
      move('ACTIVE', 'CONFIRMED', `${title}: ${note}`, 'PROBLEM_CONFIRM', () =>
        store.run('UPDATE clinical_problem SET title = ?, assessment = ?, assessed_by = ?, assessed_at = ? WHERE id = ?', title, note, ctx.workerId, at, id));
      break;
    }
    case 'plan': {
      inState('ACTIVE');
      const management = text(b.management, 1000);
      const monitoring = text(b.monitoring, 1000);
      const reviewDue = date(b.reviewDue);
      if (management.length < 5) throw new HttpError(400, 'MANAGEMENT_REQUIRED', 'Write how it is being managed, e.g. "Oral antibiotics 5 days; fluids encouraged".');
      if (monitoring.length < 5) throw new HttpError(400, 'MONITORING_REQUIRED', 'Write what to watch, e.g. "4AT daily; fluid balance".');
      if (!reviewDue || reviewDue < todayLocal()) throw new HttpError(400, 'REVIEW_REQUIRED', 'Give the date to look at it again (today or later).');
      store.tx(() => {
        store.run('UPDATE clinical_problem SET management = ?, monitoring = ?, review_due = ? WHERE id = ?', management, monitoring, reviewDue, id);
        addStep(store, ctx, id, 'PLAN', `Managing: ${management}. Watching: ${monitoring}. Look again by ${reviewDue}.`);
        logged(store, ctx, 'PROBLEM_PLAN', personId, id, management.slice(0, 200));
      });
      break;
    }
    case 'review': {
      inState('ACTIVE');
      const trend = TRENDS[String(b.trend)] ? String(b.trend) : '';
      if (!trend) throw new HttpError(400, 'TREND_REQUIRED', 'Choose whether it is improving, stable or worse.');
      need(5, 'Write what you based that on.');
      const reviewDue = date(b.reviewDue);
      if (b.reviewDue && (!reviewDue || reviewDue < todayLocal())) throw new HttpError(400, 'REVIEW_DATE', 'The next look must be today or later.');
      store.tx(() => {
        store.run('UPDATE clinical_problem SET trend = ?, last_review_at = ?, review_due = COALESCE(?, review_due) WHERE id = ?', trend, at, reviewDue || null, id);
        addStep(store, ctx, id, 'REVIEW', `${TRENDS[trend]}: ${note}${reviewDue ? ` Look again by ${reviewDue}.` : ''}`);
        logged(store, ctx, 'PROBLEM_REVIEW', personId, id, TRENDS[trend]);
      });
      break;
    }
    case 'resolve':
    case 'inactive': {
      inState('ACTIVE');
      need(5, action === 'resolve' ? 'Write how it resolved, e.g. "4AT 0 for two days, back to her usual".' : 'Write why it is inactive, e.g. "Controlled on current medicines; no active management".');
      const to = action === 'resolve' ? 'RESOLVED' : 'INACTIVE';
      move(to, to, note, `PROBLEM_${to}`, () =>
        store.run('UPDATE clinical_problem SET closed_by = ?, closed_at = ?, close_note = ?, review_due = NULL WHERE id = ?', ctx.workerId, at, note, id));
      break;
    }
    case 'rule-out': {
      inState('CONCERN', 'PROVISIONAL');
      need(5, 'Write why it was ruled out.');
      move('RULED_OUT', 'RULED_OUT', note, 'PROBLEM_RULE_OUT', () =>
        store.run('UPDATE clinical_problem SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, at, note, id));
      break;
    }
    case 'recur': {
      inState('RESOLVED', 'INACTIVE');
      need(10, 'Write what shows it is back.');
      move('ACTIVE', 'RECURRED', note, 'PROBLEM_RECUR', () =>
        store.run('UPDATE clinical_problem SET recurrences = recurrences + 1, trend = NULL, closed_by = NULL, closed_at = NULL, close_note = NULL, review_due = NULL WHERE id = ?', id));
      break;
    }
    case 'error': {
      if (state === 'ENTERED_IN_ERROR') throw new HttpError(409, 'WRONG_STATE', 'This is already marked as entered in error.');
      need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".');
      move('ENTERED_IN_ERROR', 'ERROR', note, 'PROBLEM_ERROR', () =>
        store.run('UPDATE clinical_problem SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, at, note, id));
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, load(store, id), true, true);
}

// The person's Problems view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canRecord = may(store, ctx, personId, 'problem.record');
  const canManage = may(store, ctx, personId, 'problem.manage');
  const all = store.all<Row>(`${Q} WHERE c.person_id = ? ORDER BY c.raised_at DESC`, personId).map((r) => shape(store, r, canRecord, canManage));
  const rank = (s: string) => ['ACTIVE', 'PROVISIONAL', 'CONCERN'].indexOf(s);
  return {
    open: all.filter((p) => OPEN.includes(p.state)).sort((a, b) => rank(a.state) - rank(b.state)),
    past: all.filter((p) => ['RESOLVED', 'INACTIVE'].includes(p.state)),
    other: all.filter((p) => ['RULED_OUT', 'ENTERED_IN_ERROR'].includes(p.state)),
    canRecord, canManage, trends: TRENDS,
  };
}

// For the record header: active and working problem names.
export function current(store: Store, personId: string) {
  return store.all<{ title: string; state: string }>("SELECT title, state FROM clinical_problem WHERE person_id = ? AND state IN ('ACTIVE', 'PROVISIONAL') ORDER BY state, raised_at", personId)
    .map((p) => (p.state === 'PROVISIONAL' ? `${p.title}?` : p.title));
}

// Home → Problems: concerns waiting for assessment and reviews that are due, in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('problem.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include managing problems`);
  const inService = `EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = c.person_id AND e.service_id = ? AND e.state = 'ACTIVE')
     OR EXISTS (SELECT 1 FROM care_relationship r WHERE r.person_id = c.person_id AND r.service_id = ? AND r.ended_at IS NULL)`;
  const rows = store.all<Row>(`${Q} WHERE c.state IN ('CONCERN', 'PROVISIONAL', 'ACTIVE') AND (${inService}) ORDER BY c.raised_at`, ctx.serviceId, ctx.serviceId)
    .map((r) => shape(store, r, false, false));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_PROBLEMS', decision: 'ALLOW', outcome: 'VIEWED' });
  const today = todayLocal();
  return {
    toAssess: rows.filter((r) => r.state !== 'ACTIVE'),
    dueReview: rows.filter((r) => r.state === 'ACTIVE' && r.reviewDue && String(r.reviewDue) <= today),
    worse: rows.filter((r) => r.state === 'ACTIVE' && r.trend === 'WORSENING'),
    active: rows.filter((r) => r.state === 'ACTIVE').length,
  };
}
