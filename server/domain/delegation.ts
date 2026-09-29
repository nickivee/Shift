import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { relationship } from './authority.ts';
import { ACTIVITIES, HOURS, OUTCOMES, KEEPS } from '../config/delegation.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Delegation (Cross-System Capability 308):
//   task/action eligible for delegation → delegator → delegate → scope → timeframe → acceptance →
//   performance → supervision/review where required → completion/end.
// A registered nurse or doctor hands one activity for one person to a named colleague whose role
// may do it, after checking they are competent. The delegate accepts or says why not, records what
// they did and reports anything the delegator asked to hear about straight away. Where the
// activity needs it, the delegator checks the result. Responsibility for the person's care stays
// with the delegator throughout, and a delegation ends on its own at the end of its timeframe.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  OFFERED: 'Waiting to be accepted', ACCEPTED: 'Accepted', DECLINED: 'Declined', WITHDRAWN: 'Withdrawn',
  TO_REVIEW: 'Done, to check', COMPLETED: 'Completed', EXPIRED: 'Ended before it was finished',
};
const REFS = ['ORG-SYN-001 v1', 'RR-DELEG-001'];
const LOG_LABELS: Record<string, string> = {
  OFFERED: 'Delegated', ACCEPTED: 'Accepted', DECLINED: 'Declined', PROGRESS: 'Done', CONCERN: 'Reported back', SEEN: 'Report seen',
  FINISHED: 'Finished', REVIEWED: 'Checked', REDO: 'Asked to do again', WITHDRAWN: 'Withdrawn', EXPIRED: 'Timeframe ended',
};

const Q = `
  SELECT d.id, d.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, d.service_id AS serviceId, d.activity,
         d.instructions, d.report_if AS reportIf, d.delegator_id AS delegatorId, dr.display_name AS delegator,
         d.delegate_id AS delegateId, de.display_name AS delegate, d.starts_at AS startsAt, d.ends_at AS endsAt, d.state,
         d.competence_confirmed AS competent, d.review_required AS reviewRequired, d.responded_at AS respondedAt, d.response_note AS responseNote,
         d.concern_at AS concernAt, d.done_at AS doneAt, d.reviewed_at AS reviewedAt, d.review_outcome AS reviewOutcome, d.review_note AS reviewNote,
         d.ended_at AS endedAt, d.created_at AS createdAt
    FROM delegation d
    JOIN person p ON p.id = d.person_id
    JOIN workforce_person dr ON dr.id = d.delegator_id
    JOIN workforce_person de ON de.id = d.delegate_id`;

const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const canGive = (ctx: WorkContext) => ctx.role.capabilities.includes('delegation.give');
const log = (store: Store, id: string, kind: string, body: string, by: string, at = now()) =>
  store.insert('delegation_log', { id: newId(), delegation_id: id, kind, body, by_id: by, at });
function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'delegation', objectId: id, purpose: 'DIRECT_CARE', decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const plus = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

// A delegation whose timeframe has passed ends; the delegator sees it was not finished.
function sweep(store: Store) {
  const due = store.all<{ id: string; by: string; e: string }>("SELECT id, delegator_id AS by, ends_at AS e FROM delegation WHERE state IN ('OFFERED', 'ACCEPTED') AND ends_at <= ?", now());
  for (const r of due) {
    store.tx(() => {
      transition(store, 'delegation', r.id, 'EXPIRED', { actorId: r.by, workContextId: null as unknown as string }, 'Timeframe ended');
      store.run('UPDATE delegation SET ended_at = ? WHERE id = ?', r.e, r.id);
      log(store, r.id, 'EXPIRED', 'The timeframe ended before it was finished. The care is back with the delegator.', r.by, r.e);
    });
  }
}

// Colleagues in this service whose role may take on the activity, with current authority where
// their role needs one. Anyone left out for their authority is named, so the delegator knows why.
function colleagues(store: Store, ctx: WorkContext, activity: string) {
  const a = ACTIVITIES[activity];
  if (!a) return { ok: [], out: [] };
  const today = todayLocal();
  const rows = store.all<{ id: string; name: string; roleKey: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name, pos.role_key AS roleKey FROM position pos JOIN employment em ON em.id = pos.employment_id
       JOIN workforce_person w ON w.id = em.workforce_person_id
      WHERE pos.service_id = ? AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE' AND w.id != ?
      ORDER BY w.display_name`, ctx.serviceId, today, today, ctx.workerId);
  const seen = new Set<string>();
  const ok: { id: string; name: string; role: string }[] = [];
  const out: { name: string; why: string }[] = [];
  for (const r of rows) {
    if (!a.to.includes(r.roleKey) || seen.has(r.id)) continue;
    seen.add(r.id);
    const role = ROLE_BY_KEY.get(r.roleKey);
    const current = !role?.profession || store.get(
      "SELECT 1 FROM professional_authority WHERE workforce_person_id = ? AND profession = ? AND status IN ('CURRENT', 'CONDITIONAL') AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)",
      r.id, role.profession, today, today,
    );
    if (current) ok.push({ id: r.id, name: r.name, role: role?.label ?? r.roleKey });
    else out.push({ name: r.name, why: `${role?.profession} practising certificate not current` });
  }
  return { ok, out };
}
const delegates = (store: Store, ctx: WorkContext, activity: string) => colleagues(store, ctx, activity).ok;

function shape(store: Store, ctx: WorkContext, r: Row) {
  const id = String(r.id);
  const state = String(r.state);
  const actions: string[] = [];
  const delegator = r.delegatorId === ctx.workerId;
  const delegate = r.delegateId === ctx.workerId;
  if (delegate && state === 'OFFERED') actions.push('accept', 'decline');
  if (delegate && state === 'ACCEPTED') actions.push('progress', 'concern', 'finish');
  if (delegator && state === 'TO_REVIEW') actions.push('review');
  if (delegator && r.concernAt && ['ACCEPTED', 'TO_REVIEW'].includes(state)) actions.push('seen');
  if (delegator && ['OFFERED', 'ACCEPTED'].includes(state)) actions.push('withdraw');
  const a = ACTIVITIES[String(r.activity)];
  return {
    ...r, id, state, stateLabel: STATES[state], activityLabel: a?.label ?? String(r.activity), reviewRequired: !!r.reviewRequired, competent: !!r.competent,
    outcomeLabel: r.reviewOutcome ? OUTCOMES[String(r.reviewOutcome)] : null, actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM delegation_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.delegation_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'delegation', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That delegation is no longer in SHIFT.');
  return r;
};

export function options(store: Store, ctx: WorkContext, activity?: string) {
  const mine = Object.entries(ACTIVITIES).filter(([, a]) => a.from.includes(ctx.role.roleKey));
  return {
    activities: Object.fromEntries(mine.map(([k, a]) => [k, { label: a.label, review: a.review, guide: a.guide }])),
    ...(activity ? (({ ok, out }) => ({ delegates: ok, unavailable: out }))(colleagues(store, ctx, activity)) : { delegates: [], unavailable: [] }),
    hours: HOURS, keeps: KEEPS[ctx.role.roleKey] ?? null,
  };
}

// Delegate one activity for one person to a named colleague.
export function give(store: Store, ctx: WorkContext, b: { personId?: string; activity?: string; delegateId?: string; instructions?: string; reportIf?: string; hours?: number; competent?: boolean }) {
  sweep(store);
  if (!canGive(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not delegate care`);
  if (ctx.role.profession && !ctx.authority?.current) throw new HttpError(403, 'BLOCK', `Delegating care needs a current ${ctx.role.profession} practising authority`);
  const activity = String(b.activity ?? '');
  const a = ACTIVITIES[activity];
  if (!a || !a.from.includes(ctx.role.roleKey)) throw new HttpError(400, 'ACTIVITY_REQUIRED', 'Choose what you are delegating.');
  const personId = String(b.personId ?? '');
  const rel = personId ? relationship(store, ctx, personId) : null;
  if (!rel || !['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)) throw new HttpError(403, 'BLOCK', 'You can only delegate care for someone your service is caring for');
  const delegate = delegates(store, ctx, activity).find((d) => d.id === String(b.delegateId ?? ''));
  if (!delegate) throw new HttpError(400, 'DELEGATE_REQUIRED', 'Choose who you are delegating to. Only colleagues whose role can do this are listed.');
  if (!b.competent) throw new HttpError(400, 'COMPETENCE_REQUIRED', `Confirm you have checked ${delegate.name} is competent to do this.`);
  const hours = HOURS.includes(Number(b.hours)) ? Number(b.hours) : 0;
  if (!hours) throw new HttpError(400, 'HOURS_REQUIRED', 'Choose how long this delegation lasts.');
  const instructions = text(b.instructions);
  if (instructions.length < 5) throw new HttpError(400, 'SCOPE_REQUIRED', 'Say exactly what to do, e.g. "Check before lunch and tea, record in SHIFT".');
  const reportIf = text(b.reportIf) || a.guide;
  const id = newId();
  const at = now();
  store.tx(() => {
    store.insert('delegation', {
      id, person_id: personId, service_id: ctx.serviceId, activity, instructions, report_if: reportIf, delegator_id: ctx.workerId, delegate_id: delegate.id,
      starts_at: at, ends_at: plus(hours), state: 'OFFERED', competence_confirmed: 1, review_required: a.review ? 1 : 0, created_at: at,
    });
    recordInitial(store, 'delegation', id, 'OFFERED', { actorId: ctx.workerId, workContextId: ctx.id }, a.label);
    log(store, id, 'OFFERED', `${a.label} to ${delegate.name} for ${hours} h. ${instructions} Report straight back if: ${reportIf}${a.review ? ' Checked by the delegator when done.' : ''}`, ctx.workerId);
    logged(store, ctx, 'DELEGATE', personId, id, a.label);
  });
  return shape(store, ctx, load(store, id));
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; outcome?: string }) {
  sweep(store);
  const r = load(store, id);
  const state = String(r.state);
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const at = now();
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const wrong = () => new HttpError(409, 'WRONG_STATE', `This delegation is ${STATES[state].toLowerCase()}.`);
  const asDelegate = (s: string) => { if (r.delegateId !== ctx.workerId) throw new HttpError(403, 'BLOCK', `This was delegated to ${r.delegate}.`); if (state !== s) throw wrong(); };
  const asDelegator = (ss: string[]) => { if (r.delegatorId !== ctx.workerId) throw new HttpError(403, 'BLOCK', `Only ${r.delegator}, who delegated it, can do that.`); if (!ss.includes(state)) throw wrong(); };
  switch (action) {
    case 'accept':
    case 'decline': {
      asDelegate('OFFERED');
      if (action === 'decline') need(5, 'Say why, so they can find someone else, e.g. "Not signed off for this yet".');
      store.tx(() => {
        transition(store, 'delegation', id, action === 'accept' ? 'ACCEPTED' : 'DECLINED', who, note.slice(0, 200) || undefined);
        store.run(`UPDATE delegation SET responded_at = ?, response_note = ?${action === 'decline' ? ', ended_at = ?' : ''} WHERE id = ?`, ...(action === 'decline' ? [at, note, at, id] : [at, note || null, id]));
        log(store, id, action === 'accept' ? 'ACCEPTED' : 'DECLINED', note || 'Accepted.', ctx.workerId);
        logged(store, ctx, action === 'accept' ? 'DELEGATION_ACCEPT' : 'DELEGATION_DECLINE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'progress':
    case 'concern': {
      asDelegate('ACCEPTED');
      need(action === 'concern' ? 5 : 2, action === 'concern' ? 'Say what you noticed.' : 'Say what you did, e.g. "BGL 6.2 before lunch".');
      store.tx(() => {
        if (action === 'concern') store.run('UPDATE delegation SET concern_at = ? WHERE id = ?', at, id);
        log(store, id, action === 'concern' ? 'CONCERN' : 'PROGRESS', note, ctx.workerId);
        logged(store, ctx, action === 'concern' ? 'DELEGATION_CONCERN' : 'DELEGATION_PROGRESS', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'finish': {
      asDelegate('ACCEPTED');
      need(2, 'Say how it went, e.g. "All done, readings recorded".');
      const to = r.reviewRequired ? 'TO_REVIEW' : 'COMPLETED';
      store.tx(() => {
        transition(store, 'delegation', id, to, who, note.slice(0, 200));
        store.run(`UPDATE delegation SET done_at = ?${to === 'COMPLETED' ? ', ended_at = ?' : ''} WHERE id = ?`, ...(to === 'COMPLETED' ? [at, at, id] : [at, id]));
        log(store, id, 'FINISHED', `${note}${to === 'TO_REVIEW' ? ` ${r.delegator} will check it.` : ''}`, ctx.workerId);
        logged(store, ctx, 'DELEGATION_FINISH', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'seen': {
      asDelegator(['ACCEPTED', 'TO_REVIEW']);
      if (!r.concernAt) throw new HttpError(409, 'NOTHING_TO_SEE', 'There is no report waiting.');
      need(2, 'Say what you are doing about it.');
      store.tx(() => {
        store.run('UPDATE delegation SET concern_at = NULL WHERE id = ?', id);
        log(store, id, 'SEEN', note, ctx.workerId);
        logged(store, ctx, 'DELEGATION_SEEN', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'review': {
      asDelegator(['TO_REVIEW']);
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose what you found when you checked.');
      if (outcome !== 'DONE_WELL') need(5, outcome === 'REDO' ? 'Say what needs doing again.' : 'Say what you will follow up.');
      const redo = outcome === 'REDO';
      store.tx(() => {
        transition(store, 'delegation', id, redo ? 'ACCEPTED' : 'COMPLETED', who, OUTCOMES[outcome]);
        store.run(`UPDATE delegation SET reviewed_at = ?, review_outcome = ?, review_note = ?${redo ? ', done_at = NULL' : ', ended_at = ?'} WHERE id = ?`,
          ...(redo ? [at, outcome, note || null, id] : [at, outcome, note || null, at, id]));
        log(store, id, redo ? 'REDO' : 'REVIEWED', `${OUTCOMES[outcome]}.${note ? ` ${note}` : ''}`, ctx.workerId);
        logged(store, ctx, 'DELEGATION_REVIEW', personId, id, outcome);
      });
      break;
    }
    case 'withdraw': {
      asDelegator(['OFFERED', 'ACCEPTED']);
      need(2, 'Say why, e.g. "Doing it myself now".');
      store.tx(() => {
        transition(store, 'delegation', id, 'WITHDRAWN', who, note.slice(0, 200));
        store.run('UPDATE delegation SET ended_at = ? WHERE id = ?', at, id);
        log(store, id, 'WITHDRAWN', `${note} The care is back with ${r.delegator}.`, ctx.workerId);
        logged(store, ctx, 'DELEGATION_WITHDRAW', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, ctx, load(store, id));
}

// Home → Delegation: what is waiting for the worker, as delegate and as delegator.
export function list(store: Store, ctx: WorkContext) {
  sweep(store);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = (where: string, ...args: unknown[]) => store.all<Row>(`${Q} WHERE ${where} ORDER BY d.created_at DESC`, ...args).map((r) => shape(store, ctx, r));
  const me = ctx.workerId;
  const out = {
    toAccept: rows("d.delegate_id = ? AND d.state = 'OFFERED'", me),
    doing: rows("d.delegate_id = ? AND d.state IN ('ACCEPTED', 'TO_REVIEW')", me),
    toCheck: rows("d.delegator_id = ? AND (d.state = 'TO_REVIEW' OR (d.state = 'ACCEPTED' AND d.concern_at IS NOT NULL))", me),
    given: rows("d.delegator_id = ? AND (d.state = 'OFFERED' OR (d.state = 'ACCEPTED' AND d.concern_at IS NULL))", me),
    ended: rows("(d.delegator_id = ? OR d.delegate_id = ?) AND d.state IN ('COMPLETED', 'DECLINED', 'WITHDRAWN', 'EXPIRED') AND d.ended_at >= ?", me, me, since),
    canGive: canGive(ctx), canTake: ctx.role.capabilities.includes('delegation.take'), outcomes: OUTCOMES,
  };
  audit(store, { actorId: me, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_DELEGATION', decision: 'ALLOW', outcome: 'VIEWED' });
  return out;
}

