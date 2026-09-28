import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { CATEGORIES, REASONS, DECISIONS } from '../config/variances.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Clinical Exception / Variance (Shared Lifecycle Object 295):
//   expected state/action → variance → reason → clinical context → authorised decision →
//   alternative action → monitoring/follow-up.
// Anyone caring for the person records what was expected, what happened instead, why, and the
// clinical context. Someone allowed to decide then accepts it or chooses what to do instead, and
// whether it needs following up. Follow-up notes are added until it is closed with an outcome.
// A variance caused by a mistake is flagged so it is also reported as an incident.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  RECORDED: 'Waiting for a decision', MONITORING: 'Being followed up', CLOSED: 'Closed', ENTERED_IN_ERROR: 'Entered in error',
};
const OPEN = ['RECORDED', 'MONITORING'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-VAR-001'];

const Q = `
  SELECT v.id, v.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = v.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         v.service_id AS serviceId, s.name AS service, v.category, v.expected, v.what_happened AS whatHappened, v.reason, v.context, v.occurred_at AS occurredAt,
         v.state, rb.display_name AS recordedBy, v.recorded_by AS recordedById, v.recorded_at AS recordedAt,
         v.decision, v.action, db.display_name AS decidedBy, v.decided_at AS decidedAt, v.decision_note AS decisionNote, v.follow_up_by AS followUpBy, v.watch,
         eb.display_name AS endedBy, v.ended_at AS endedAt, v.ended_note AS endedNote
    FROM variance v
    JOIN person p ON p.id = v.person_id
    JOIN service s ON s.id = v.service_id
    JOIN workforce_person rb ON rb.id = v.recorded_by
    LEFT JOIN workforce_person db ON db.id = v.decided_by
    LEFT JOIN workforce_person eb ON eb.id = v.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'VARIANCE', personId }).decision === 'ALLOW';
const decider = (ctx: WorkContext) => ctx.role.capabilities.includes('variance.decide');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'variance', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const log = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('variance_log', { id: newId(), variance_id: id, kind, body, by_id: ctx.workerId, at: now() });
const LOG_LABELS: Record<string, string> = {
  RECORDED: 'Variance recorded', DECIDED: 'Decision', FOLLOW_UP: 'Follow-up', CLOSED: 'Closed', ERROR: 'Entered in error',
};

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const today = todayLocal();
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId) {
    if (state === 'RECORDED' && decider(ctx)) actions.push('decide');
    if (state === 'MONITORING') actions.push('followup');
    if (state === 'MONITORING' && decider(ctx)) actions.push('close');
    if (OPEN.includes(state) && (decider(ctx) || r.recordedById === ctx.workerId)) actions.push('error');
  }
  return {
    ...r, id, state, stateLabel: STATES[state], categoryLabel: CATEGORIES[String(r.category)] ?? String(r.category), reasonLabel: REASONS[String(r.reason)] ?? String(r.reason),
    decisionLabel: r.decision ? DECISIONS[String(r.decision)] ?? String(r.decision) : null,
    mistake: r.reason === 'ERROR',
    followUpDue: state === 'MONITORING' && !!r.followUpBy && String(r.followUpBy) <= today,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM variance_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.variance_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'variance', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE v.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That variance is no longer in SHIFT.');
  return r;
};

export function record(store: Store, ctx: WorkContext, personId: string,
  b: { category?: string; expected?: string; whatHappened?: string; reason?: string; context?: string; occurredAt?: string }) {
  enforce(store, ctx, { op: 'VARIANCE', personId }, personId);
  const category = CATEGORIES[String(b.category)] ? String(b.category) : '';
  if (!category) throw new HttpError(400, 'CATEGORY_REQUIRED', 'Choose what kind of variance it is.');
  const expected = text(b.expected, 300);
  if (expected.length < 3) throw new HttpError(400, 'EXPECTED_REQUIRED', 'Write what was expected, e.g. "Enoxaparin 40 mg at 1800".');
  const whatHappened = text(b.whatHappened, 500);
  if (whatHappened.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Write what happened instead, e.g. "Not given".');
  const reason = REASONS[String(b.reason)] ? String(b.reason) : '';
  if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why.');
  const context = text(b.context, 1000);
  if (context.length < 5) throw new HttpError(400, 'CONTEXT_REQUIRED', 'Write the clinical context, e.g. "Says the injections bruise her; platelets normal".');
  const when = Date.parse(String(b.occurredAt ?? ''));
  if (Number.isNaN(when) || when > Date.now() + 5 * 60_000 || when < Date.now() - 7 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it happened, in the last week.');
  store.tx(() => {
    const id = newId();
    store.insert('variance', {
      id, person_id: personId, service_id: ctx.serviceId, category, expected, what_happened: whatHappened, reason, context, occurred_at: new Date(when).toISOString(),
      state: 'RECORDED', recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'variance', id, 'RECORDED', { actorId: ctx.workerId, workContextId: ctx.id }, `${expected}: ${whatHappened}`.slice(0, 200));
    log(store, ctx, id, 'RECORDED', `Expected: ${expected}. Instead: ${whatHappened}. Why: ${REASONS[reason].toLowerCase()}. ${context}`);
    logged(store, ctx, 'VARIANCE_RECORD', personId, id, `${category}: ${reason}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { decision?: string; action?: string; note?: string; followUp?: string; followUpBy?: string; watch?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'VARIANCE', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This variance belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This variance is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const mustDecide = () => { if (!decider(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot decide on a variance. Ask the nurse in charge or the doctor.`); };
  const date = (msg: string) => {
    const d = text(b.followUpBy, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < todayLocal() || d > addDays(todayLocal(), 30)) throw new HttpError(400, 'DATE', msg);
    return d;
  };
  switch (action) {
    case 'decide': {
      inState('RECORDED');
      mustDecide();
      const decision = DECISIONS[String(b.decision)] ? String(b.decision) : '';
      if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose the decision.');
      const alt = text(b.action, 500);
      if (decision !== 'ACCEPT' && alt.length < 5) throw new HttpError(400, 'ACTION_REQUIRED', 'Write what will be done instead, e.g. "Give at 2000 once she has eaten".');
      const followUp = b.followUp === 'YES';
      const followUpBy = followUp ? date('Choose when to follow it up, from today.') : null;
      const watch = followUp ? text(b.watch, 300) : '';
      if (followUp && watch.length < 5) throw new HttpError(400, 'WATCH_REQUIRED', 'Write what to watch for, e.g. "Calf swelling or chest pain".');
      store.tx(() => {
        transition(store, 'variance', id, followUp ? 'MONITORING' : 'CLOSED', who, DECISIONS[decision]);
        store.run('UPDATE variance SET decision = ?, action = ?, decided_by = ?, decided_at = ?, decision_note = ?, follow_up_by = ?, watch = ? WHERE id = ?',
          decision, alt || null, ctx.workerId, at, note || null, followUpBy, watch || null, id);
        if (!followUp) store.run('UPDATE variance SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, 'No follow-up needed.', id);
        log(store, ctx, id, 'DECIDED', [`${DECISIONS[decision]}.`, alt, note, followUp ? `Follow up by ${followUpBy}: ${watch}.` : 'No follow-up needed.'].filter(Boolean).join(' '));
        logged(store, ctx, `VARIANCE_${decision}`, personId, id, alt.slice(0, 200) || undefined);
      });
      break;
    }
    case 'followup': {
      inState('MONITORING');
      need(5, 'Write what you found, e.g. "Weighed after X-ray: 82.4 kg, down 0.6".');
      const next = text(b.followUpBy, 10) ? date('Choose the next follow-up date, from today, or leave it empty.') : null;
      store.tx(() => {
        if (next) store.run('UPDATE variance SET follow_up_by = ? WHERE id = ?', next, id);
        log(store, ctx, id, 'FOLLOW_UP', `${note}${next ? ` Next follow-up by ${next}.` : ''}`);
        logged(store, ctx, 'VARIANCE_FOLLOW_UP', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'close': {
      inState('MONITORING');
      mustDecide();
      need(5, 'Write the outcome, e.g. "Given at 2000; no harm".');
      store.tx(() => {
        transition(store, 'variance', id, 'CLOSED', who, note.slice(0, 200));
        store.run('UPDATE variance SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, ctx, id, 'CLOSED', note);
        logged(store, ctx, 'VARIANCE_CLOSE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      inState(...OPEN);
      if (!decider(ctx) && r.recordedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who recorded it, or someone who can decide on it, can mark it as an error.');
      need(10, 'Write why this was entered in error, e.g. "Recorded for the wrong person".');
      store.tx(() => {
        transition(store, 'variance', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE variance SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'VARIANCE_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Variances view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE v.person_id = ? ORDER BY v.occurred_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canRecord: can,
    canDecide: decider(ctx),
    options: { categories: CATEGORIES, reasons: REASONS, decisions: DECISIONS },
  };
}

// Home → Variances for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('variance.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include variances`);
  const rows = store.all<Row>(`${Q} WHERE v.service_id = ? AND v.state IN ('RECORDED', 'MONITORING') ORDER BY v.occurred_at`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_VARIANCES', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toDecide: rows.filter((x) => x.state === 'RECORDED'),
    followUpDue: rows.filter((x) => x.followUpDue),
    monitoring: rows.filter((x) => x.state === 'MONITORING' && !x.followUpDue),
    canDecide: decider(ctx),
  };
}
