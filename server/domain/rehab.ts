import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, NOT_DELIVERED, GOAL, NEXT, OUTCOME, REFS } from '../config/rehab.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Rehabilitation episode (entries 49, 50), for the physio. It starts when the physio takes the
// person on from a referral (or by hand for someone already on the caseload), then:
//   readiness checked (not ready yet, with a recheck date) → baseline, goals linked to the care
//   plan, and the plan → each session delivered or not, and why → reassessment of each goal and of
//   equipment and support needs → handed on to whoever takes over, closed once they accept → or
//   closed with an outcome.
// Ward nurses and doctors see it, read-only, so they know whether physio happened today and what
// the person needs to go home.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OPEN = "('STARTED', 'NOT_READY', 'ACTIVE', 'ENDING')";

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'REHAB', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'rehab_episode', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [49, 50],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('rehab_step', { id: newId(), episode_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT r.id, r.person_id AS personId, r.service_id AS serviceId, s.name AS service, r.state, r.started_at AS startedAt, sb.display_name AS startedBy,
         r.referral_id AS referralId, r.ready_at AS readyAt, r.not_ready_reason AS notReadyReason, r.recheck_on AS recheckOn, r.baseline, r.plan,
         r.per_week AS perWeek, r.needs, r.next_kind AS nextKind, r.next_to AS nextTo, r.next_summary AS nextSummary, r.accepted_note AS acceptedNote,
         r.closed_at AS closedAt, cb.display_name AS closedBy, r.outcome, r.close_note AS closeNote
    FROM rehab_episode r
    JOIN service s ON s.id = r.service_id
    JOIN workforce_person sb ON sb.id = r.started_by
    LEFT JOIN workforce_person cb ON cb.id = r.closed_by`;

function shape(store: Store, r: Row, manage: boolean): Record<string, any> {
  const id = String(r.id);
  const state = String(r.state);
  const goals = store.all<Row>(
    `SELECT g.id, g.goal, g.state, c.goal AS carePlanGoal, c.need AS carePlanNeed FROM rehab_goal g LEFT JOIN care_plan_item c ON c.id = g.care_plan_item_id
      WHERE g.episode_id = ? ORDER BY g.rowid`, id,
  ).map((g) => ({ ...g, stateLabel: GOAL[String(g.state)], carePlan: g.carePlanGoal ?? g.carePlanNeed ?? null }));
  const sessions = store.all<Row>(
    `SELECT x.id, x.at, w.display_name AS "by", x.delivered, x.done, x.response, x.reason, x.note FROM rehab_session x JOIN workforce_person w ON w.id = x.by_id
      WHERE x.episode_id = ? ORDER BY x.at DESC`, id,
  ).map((x): Record<string, any> => ({ ...x, delivered: !!x.delivered, reasonLabel: x.reason ? NOT_DELIVERED[String(x.reason)] : null }));
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const week = sessions.filter((x) => String(x.at) >= weekAgo);
  const acts: string[] = [];
  if (manage) {
    if (['STARTED', 'NOT_READY'].includes(state)) acts.push('ready');
    if (state === 'ACTIVE') acts.push('session', 'review', 'handover');
    if (state === 'ENDING') acts.push('accepted', 'back');
    if (state !== 'ENDING' && state !== 'CLOSED') acts.push('close');
  }
  return {
    ...r, state, stateLabel: STATES[state], nextLabel: r.nextKind ? NEXT[String(r.nextKind)] : null, outcomeLabel: r.outcome ? OUTCOME[String(r.outcome)] : null,
    goals, sessions: sessions.slice(0, 20), sessionCount: sessions.length,
    week: { delivered: week.filter((x) => x.delivered).length, missed: week.filter((x) => !x.delivered).length, planned: r.perWeek },
    lastSession: sessions[0] ?? null, acts,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM rehab_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.episode_id = ? ORDER BY s.at, s.rowid', id),
  };
}

// The physio's Treatment view; ward nurses' Care Plan and the doctor's Review, read-only.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  const physio = caps.includes('rehab.manage');
  if (!physio && !caps.includes('rehab.view')) return null;
  const manage = physio && may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE r.person_id = ? ORDER BY r.started_at DESC`, personId).map((r) => shape(store, r, manage));
  const current = all.find((e) => e.state !== 'CLOSED') ?? null;
  if (!physio && !all.length) return null;
  return {
    title: physio ? 'Rehab episode' : 'Physiotherapy', physio, current, past: all.filter((e) => e !== current),
    canStart: manage && !current,
    options: manage ? {
      notDelivered: NOT_DELIVERED, goal: GOAL, next: NEXT, outcome: OUTCOME,
      carePlan: store.all<Row>("SELECT id, need, goal FROM care_plan_item WHERE person_id = ? AND state = 'ACTIVE' ORDER BY created_at", personId)
        .map((c) => ({ id: c.id, label: c.goal ? `${c.need}: ${c.goal}` : String(c.need) })),
    } : null,
  };
}

function insert(store: Store, ctx: WorkContext, personId: string, referralId: string | null, why: string) {
  const id = newId();
  store.insert('rehab_episode', { id, person_id: personId, service_id: ctx.serviceId, referral_id: referralId, state: 'STARTED', started_at: now(), started_by: ctx.workerId });
  recordInitial(store, 'rehab_episode', id, 'STARTED', { actorId: ctx.workerId, workContextId: ctx.id }, why);
  step(store, id, 'STARTED', why, ctx.workerId);
  logged(store, ctx, 'REHAB_START', personId, id, why);
  return id;
}

// Called when the physio takes the person on from a referral.
export function startFromReferral(store: Store, ctx: WorkContext, personId: string, referralId: string) {
  if (!(ctx.role.capabilities as string[]).includes('rehab.manage')) return;
  if (store.get(`SELECT 1 FROM rehab_episode WHERE person_id = ? AND service_id = ? AND state IN ${OPEN}`, personId, ctx.serviceId)) return;
  insert(store, ctx, personId, referralId, 'Started when the referral was taken on.');
}

export function start(store: Store, ctx: WorkContext, personId: string) {
  enforce(store, ctx, { op: 'REHAB', personId }, personId);
  if (store.get(`SELECT 1 FROM rehab_episode WHERE person_id = ? AND service_id = ? AND state IN ${OPEN}`, personId, ctx.serviceId)) {
    throw new HttpError(409, 'ALREADY', 'They already have a rehab episode open.');
  }
  store.tx(() => insert(store, ctx, personId, null, 'Started.'));
  return forPerson(store, ctx, personId);
}

interface GoalIn { goal?: string; carePlanItem?: string }
interface Body {
  ready?: string; reason?: string; recheck?: string; baseline?: string; plan?: string; perWeek?: number; goals?: GoalIn[];
  delivered?: string; done?: string; response?: string; note?: string; goalStates?: Record<string, string>; needs?: string;
  nextKind?: string; nextTo?: string; summary?: string; outcome?: string;
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That rehab episode is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'REHAB', personId }, personId);
  const state = String(r.state);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = text(b.note);
  const must = (ok: boolean) => { if (!ok) throw new HttpError(409, 'STATE', `This episode is ${STATES[state].toLowerCase()}; that cannot be done now.`); };
  store.tx(() => {
    switch (action) {
      case 'ready': {
        must(['STARTED', 'NOT_READY'].includes(state));
        if (b.ready === 'no') {
          const reason = text(b.reason, 500);
          if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Write why they are not ready yet, e.g. "On 4 L oxygen and drowsy".');
          const recheck = text(b.recheck, 10);
          if (!DAY.test(recheck)) throw new HttpError(400, 'RECHECK_REQUIRED', 'Choose when to check again.');
          if (state !== 'NOT_READY') transition(store, 'rehab_episode', id, 'NOT_READY', who, 'Not ready yet');
          store.run('UPDATE rehab_episode SET not_ready_reason = ?, recheck_on = ? WHERE id = ?', reason, recheck, id);
          step(store, id, 'NOT_READY', `Not ready yet: ${sentence(reason)} Check again ${recheck}.`, ctx.workerId);
          logged(store, ctx, 'REHAB_NOT_READY', personId, id, reason);
          break;
        }
        if (b.ready !== 'yes') throw new HttpError(400, 'READY_REQUIRED', 'Say whether they are ready for rehab.');
        const baseline = text(b.baseline);
        if (baseline.length < 10) throw new HttpError(400, 'BASELINE_REQUIRED', 'Write how they manage now, e.g. "Walks 10 m with a frame and help of one".');
        const carePlan = new Set(store.all<{ id: string }>("SELECT id FROM care_plan_item WHERE person_id = ? AND state = 'ACTIVE'", personId).map((c) => c.id));
        const goals = (b.goals ?? []).map((g) => ({ goal: text(g.goal, 300), item: carePlan.has(String(g.carePlanItem)) ? String(g.carePlanItem) : null })).filter((g) => g.goal);
        if (!goals.length) throw new HttpError(400, 'GOAL_REQUIRED', 'Write at least one goal, in their words where you can.');
        const plan = text(b.plan);
        if (plan.length < 5) throw new HttpError(400, 'PLAN_REQUIRED', 'Write the plan, e.g. "Walking practice and leg strength".');
        const perWeek = Math.round(Number(b.perWeek));
        if (!(perWeek >= 1 && perWeek <= 14)) throw new HttpError(400, 'PER_WEEK_REQUIRED', 'Choose how many sessions a week.');
        transition(store, 'rehab_episode', id, 'ACTIVE', who, 'Ready');
        store.run('UPDATE rehab_episode SET ready_at = ?, baseline = ?, plan = ?, per_week = ?, not_ready_reason = NULL, recheck_on = NULL WHERE id = ?', now(), baseline, plan, perWeek, id);
        for (const g of goals) store.insert('rehab_goal', { id: newId(), episode_id: id, goal: g.goal, care_plan_item_id: g.item, state: 'WORKING', updated_at: now() });
        step(store, id, 'ACTIVE', `Ready. ${goals.length} goal${goals.length === 1 ? '' : 's'}; ${perWeek} session${perWeek === 1 ? '' : 's'} a week.`, ctx.workerId);
        logged(store, ctx, 'REHAB_READY', personId, id, 'Ready');
        break;
      }
      case 'session': {
        must(state === 'ACTIVE');
        if (b.delivered === 'yes') {
          const done = text(b.done, 800);
          if (done.length < 5) throw new HttpError(400, 'DONE_REQUIRED', 'Write what was done, e.g. "Walked 20 m with frame; stairs x 4".');
          store.insert('rehab_session', { id: newId(), episode_id: id, at: now(), by_id: ctx.workerId, delivered: 1, done, response: text(b.response, 800) || null, reason: null, note: null });
          logged(store, ctx, 'REHAB_SESSION', personId, id, 'Session delivered');
        } else if (b.delivered === 'no') {
          const reason = pick(NOT_DELIVERED, b.reason);
          if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why the session did not happen.');
          if (reason === 'OTHER' && say.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the session did not happen.');
          store.insert('rehab_session', { id: newId(), episode_id: id, at: now(), by_id: ctx.workerId, delivered: 0, done: null, response: null, reason, note: say || null });
          logged(store, ctx, 'REHAB_SESSION_MISSED', personId, id, NOT_DELIVERED[reason]);
        } else throw new HttpError(400, 'DELIVERED_REQUIRED', 'Say whether the session happened.');
        break;
      }
      case 'review': {
        must(state === 'ACTIVE');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how they are going, e.g. "Now walking 30 m with frame, supervision only".');
        const states = b.goalStates ?? {};
        for (const g of store.all<{ id: string; goal: string; state: string }>('SELECT id, goal, state FROM rehab_goal WHERE episode_id = ?', id)) {
          const to = pick(GOAL, states[g.id]);
          if (to && to !== g.state) store.run('UPDATE rehab_goal SET state = ?, updated_at = ? WHERE id = ?', to, now(), g.id);
        }
        const needs = text(b.needs, 800);
        if (needs) store.run('UPDATE rehab_episode SET needs = ? WHERE id = ?', needs, id);
        step(store, id, 'REVIEW', `Reassessed: ${sentence(say)}${needs ? ` Needs: ${sentence(needs)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'REHAB_REVIEW', personId, id, 'Reassessed');
        break;
      }
      case 'handover': {
        must(state === 'ACTIVE');
        const kind = pick(NEXT, b.nextKind);
        if (!kind) throw new HttpError(400, 'NEXT_REQUIRED', 'Choose who takes over.');
        if (kind === 'NONE') throw new HttpError(400, 'USE_CLOSE', 'If no further physio is needed, finish the episode instead.');
        const to = text(b.nextTo, 200);
        if (to.length < 3) throw new HttpError(400, 'TO_REQUIRED', 'Name who takes over, e.g. "Kapiti community physio team".');
        const summary = text(b.summary, 2000);
        if (summary.length < 10) throw new HttpError(400, 'SUMMARY_REQUIRED', 'Write the summary for them: where they are up to and what is next.');
        transition(store, 'rehab_episode', id, 'ENDING', who, `To ${to}`);
        store.run('UPDATE rehab_episode SET next_kind = ?, next_to = ?, next_summary = ? WHERE id = ?', kind, to, summary, id);
        step(store, id, 'ENDING', `Handed over to ${to} (${NEXT[kind]}). Waiting for them to accept.`, ctx.workerId);
        logged(store, ctx, 'REHAB_HANDOVER', personId, id, to);
        break;
      }
      case 'back': {
        must(state === 'ENDING');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', `Write what happened, e.g. "${r.nextTo} cannot take them until next month".`);
        transition(store, 'rehab_episode', id, 'ACTIVE', who, 'Handover not accepted');
        store.run('UPDATE rehab_episode SET next_kind = NULL, next_to = NULL, next_summary = NULL WHERE id = ?', id);
        step(store, id, 'BACK', `Not taken over: ${sentence(say)} Still with physio here.`, ctx.workerId);
        logged(store, ctx, 'REHAB_HANDOVER_BACK', personId, id, 'Not accepted');
        break;
      }
      case 'accepted':
      case 'close': {
        must(action === 'accepted' ? state === 'ENDING' : state !== 'ENDING' && state !== 'CLOSED');
        const outcome = pick(OUTCOME, b.outcome);
        if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose the outcome.');
        if (action === 'accepted' && say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', `Write who at ${r.nextTo} accepted, and when.`);
        if (action === 'close' && say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write a short summary to finish with.');
        const open = store.get<{ n: number }>("SELECT count(*) AS n FROM rehab_goal WHERE episode_id = ? AND state = 'WORKING'", id)!.n;
        if (open && ['MET'].includes(outcome)) throw new HttpError(400, 'GOALS_OPEN', `${open} goal${open === 1 ? ' is' : 's are'} still marked working on it. Reassess the goals first.`);
        transition(store, 'rehab_episode', id, 'CLOSED', who, OUTCOME[outcome]);
        if (action === 'accepted') store.run('UPDATE rehab_episode SET accepted_note = ? WHERE id = ?', say, id);
        store.run('UPDATE rehab_episode SET closed_at = ?, closed_by = ?, outcome = ?, close_note = ? WHERE id = ?', now(), ctx.workerId, outcome, say, id);
        step(store, id, 'CLOSED', action === 'accepted' ? `${r.nextTo} accepted: ${sentence(say)} Finished: ${OUTCOME[outcome].toLowerCase()}.` : `Finished: ${OUTCOME[outcome].toLowerCase()}. ${sentence(say)}`, ctx.workerId);
        logged(store, ctx, 'REHAB_CLOSE', personId, id, OUTCOME[outcome]);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
