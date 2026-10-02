import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, SUBSTANCE, TIME_KNOWN, REFS } from '../config/withdrawal.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Alcohol and drug withdrawal (entries 111, 116):
//   what they usually use, when they last used, and any past severe withdrawal → readings of
//   whichever scale the service uses, written as scored → the doctor's plan with timed checks →
//   checks done → settled, or handed on (addiction service, ward, home with support).
//   SHIFT never works out a score or says what it means. Nurses and doctors record readings;
//   doctors plan, settle and hand on.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const OPEN = ['ASSESSING', 'MANAGED'];

export const PLACE: Record<string, string> = { 'ed-doctor': 'medical', 'ed-rn': 'monitoring', 'genmed-physician': 'review', 'genmed-rn': 'monitoring' };

const may = (store: Store, ctx: WorkContext, personId: string, op: 'WITHDRAWAL' | 'WITHDRAWAL_MANAGE') => evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'withdrawal_episode', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [111],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('withdrawal_step', { id: newId(), episode_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT t.id, t.person_id AS personId, t.state, t.substance, t.usual, t.last_use_at AS lastUseAt, t.time_known AS timeKnown, t.history, t.source,
         rb.display_name AS recordedBy, t.recorded_at AS recordedAt, t.plan, pb.display_name AS plannedBy, t.watch_until AS watchUntil,
         t.outcome_note AS outcomeNote, ob.display_name AS outcomeBy, t.outcome_at AS outcomeAt, t.handed_to AS handedTo
    FROM withdrawal_episode t
    JOIN workforce_person rb ON rb.id = t.recorded_by
    LEFT JOIN workforce_person pb ON pb.id = t.planned_by
    LEFT JOIN workforce_person ob ON ob.id = t.outcome_by`;

const checksOf = (store: Store, id: string) => store.all<Row>(
  `SELECT c.id, c.what, c.due_at AS dueAt, db.display_name AS doneBy, c.done_at AS doneAt, c.note
     FROM withdrawal_check c LEFT JOIN workforce_person db ON db.id = c.done_by WHERE c.episode_id = ? ORDER BY c.due_at, c.rowid`, id)
  .map((c): Record<string, any> => ({ ...c, overdue: !c.doneAt && Date.parse(String(c.dueAt)) < Date.now() }));

function shape(store: Store, r: Row, nurse: boolean, doctor: boolean): Record<string, any> {
  const state = String(r.state);
  const open = OPEN.includes(state);
  const checks = checksOf(store, String(r.id));
  const acts: string[] = [];
  if (open && (nurse || doctor)) acts.push('reading');
  if (open && doctor) acts.push('plan', 'settle', 'handon');
  return {
    ...r, state, stateLabel: STATES[state], substanceLabel: SUBSTANCE[String(r.substance)], timeKnownLabel: TIME_KNOWN[String(r.timeKnown)],
    checks, outstanding: checks.filter((c) => !c.doneAt).length, canTick: open && (nurse || doctor), acts,
    readings: store.all<Row>('SELECT a.scale, a.score, a.signs, w.display_name AS "by", a.at FROM withdrawal_reading a JOIN workforce_person w ON w.id = a.by_id WHERE a.episode_id = ? ORDER BY a.at DESC, a.rowid DESC', String(r.id)),
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM withdrawal_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.episode_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  if (!caps.includes('withdrawal.manage') && !caps.includes('withdrawal.record')) return null;
  const nurse = may(store, ctx, personId, 'WITHDRAWAL');
  const doctor = may(store, ctx, personId, 'WITHDRAWAL_MANAGE');
  const all = store.all<Row>(`${Q} WHERE t.person_id = ? ORDER BY t.recorded_at DESC`, personId).map((r) => shape(store, r, nurse, doctor));
  return {
    current: all.filter((x) => OPEN.includes(x.state)),
    past: all.filter((x) => !OPEN.includes(x.state)),
    canRecord: nurse || doctor,
    options: nurse || doctor ? { substance: SUBSTANCE, timeKnown: TIME_KNOWN } : null,
  };
}

// For the record header: an open withdrawal, and the next check.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE t.person_id = ? AND t.state IN ('ASSESSING', 'MANAGED') ORDER BY t.recorded_at DESC LIMIT 1`, personId);
  if (!r) return null;
  const next = checksOf(store, String(r.id)).find((c) => !c.doneAt) ?? null;
  return { substance: SUBSTANCE[String(r.substance)], state: STATES[String(r.state)], watchUntil: r.watchUntil, next };
}

interface Body {
  substance?: string; usual?: string; lastUse?: string; timeKnown?: string; history?: string; source?: string;
  scale?: string; score?: string; signs?: string; plan?: string; watchUntil?: string; checks?: { what?: string; dueAt?: string }[]; checkId?: string;
  note?: string; handedTo?: string;
}

export function record(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'WITHDRAWAL', personId }, personId);
  if (store.get("SELECT 1 FROM withdrawal_episode WHERE person_id = ? AND state IN ('ASSESSING', 'MANAGED')", personId)) {
    throw new HttpError(409, 'ALREADY', 'A withdrawal is already open for them. Add to that one.');
  }
  const substance = pick(SUBSTANCE, b.substance);
  if (!substance) throw new HttpError(400, 'SUBSTANCE_REQUIRED', 'Choose what they are withdrawing from.');
  const usual = text(b.usual, 300);
  if (usual.length < 3) throw new HttpError(400, 'USUAL_REQUIRED', 'Write how much and how often they usually use, as they tell you, e.g. "About 12 cans a day for 10 years".');
  const timeKnown = pick(TIME_KNOWN, b.timeKnown);
  if (!timeKnown) throw new HttpError(400, 'TIME_REQUIRED', 'Say whether the time of the last use is known.');
  const lastUse = text(b.lastUse, 30);
  if (timeKnown !== 'UNKNOWN' && (!STAMP.test(lastUse) || Date.parse(lastUse) > Date.now() + 5 * 60_000)) throw new HttpError(400, 'LAST_USE', 'Choose when they last used (or say the time is not known).');
  const history = text(b.history, 600);
  if (history.length < 3) throw new HttpError(400, 'HISTORY_REQUIRED', 'Write any past severe withdrawal, seizures or delirium, or "None known".');
  const source = text(b.source, 200);
  if (source.length < 3) throw new HttpError(400, 'SOURCE_REQUIRED', 'Write who told us, e.g. "Patient", "Wife", "Ambulance".');
  const id = newId();
  const at = timeKnown === 'UNKNOWN' ? null : new Date(lastUse).toISOString();
  store.tx(() => {
    store.insert('withdrawal_episode', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'ASSESSING', substance, usual, last_use_at: at, time_known: timeKnown, history, source,
      recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'withdrawal_episode', id, 'ASSESSING', { actorId: ctx.workerId, workContextId: ctx.id }, SUBSTANCE[substance]);
    step(store, id, 'RECORDED', `${SUBSTANCE[substance]}: usually ${sentence(usual)} ${TIME_KNOWN[timeKnown]}${at ? ` (${lastUse.replace('T', ' ')})` : ''}. Past withdrawal: ${sentence(history)} Told by ${sentence(source)}`, ctx.workerId);
    logged(store, ctx, 'WITHDRAWAL_RECORD', personId, id, SUBSTANCE[substance]);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE t.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That withdrawal is no longer in SHIFT.');
  const personId = String(r.personId);
  const state = String(r.state);
  const doctorWork = ['plan', 'settle', 'handon'].includes(action);
  enforce(store, ctx, { op: doctorWork ? 'WITHDRAWAL_MANAGE' : 'WITHDRAWAL', personId }, personId);
  if (!OPEN.includes(state)) throw new HttpError(409, 'STATE', `This withdrawal is ${STATES[state].toLowerCase()}; nothing more can be added.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note, 1000);
  store.tx(() => {
    switch (action) {
      case 'reading': {
        const scale = text(b.scale, 120);
        if (scale.length < 2) throw new HttpError(400, 'SCALE_REQUIRED', 'Write which scale or tool you used, e.g. "CIWA-Ar" or "the ward chart".');
        const score = text(b.score, 20);
        const signs = text(b.signs, 1000);
        if (signs.length < 5) throw new HttpError(400, 'SIGNS_REQUIRED', 'Write what you saw and what they said, e.g. "Tremor, sweating, anxious; says no hallucinations".');
        store.insert('withdrawal_reading', { id: newId(), episode_id: id, scale, score: score || null, signs, by_id: ctx.workerId, at: now() });
        step(store, id, 'READING', `${scale}${score ? ` ${score}` : ''}: ${sentence(signs)}`, ctx.workerId);
        logged(store, ctx, 'WITHDRAWAL_READING', personId, id, `${scale} ${score}`.trim());
        break;
      }
      case 'plan': {
        const plan = text(b.plan, 1500);
        if (plan.length < 10) throw new HttpError(400, 'PLAN_REQUIRED', 'Write what to watch for and what to do, e.g. "Readings every 4 hours per the ward protocol; tell me if confused or shaking more".');
        const until = text(b.watchUntil, 30);
        if (until && !STAMP.test(until)) throw new HttpError(400, 'UNTIL', 'Choose when watching can stop, or leave it empty.');
        const checks = (Array.isArray(b.checks) ? b.checks : []).map((c) => ({ what: text(c?.what, 200), dueAt: text(c?.dueAt, 30) })).filter((c) => c.what || c.dueAt);
        for (const c of checks) {
          if (c.what.length < 3 || !STAMP.test(c.dueAt)) throw new HttpError(400, 'CHECK', 'Each timed check needs what to do and when, e.g. "Reading and review" at 8pm.');
        }
        if (state === 'ASSESSING') transition(store, 'withdrawal_episode', id, 'MANAGED', who, 'Plan made');
        store.run('UPDATE withdrawal_episode SET plan = ?, planned_by = ?, watch_until = ? WHERE id = ?', plan, ctx.workerId, until ? new Date(until).toISOString() : null, id);
        for (const c of checks) store.insert('withdrawal_check', { id: newId(), episode_id: id, what: c.what, due_at: new Date(c.dueAt).toISOString(), added_by: ctx.workerId });
        step(store, id, 'PLAN', `Plan: ${sentence(plan)}${until ? ` Watch until ${until.replace('T', ' ')}.` : ''}${checks.length ? ` Checks: ${checks.map((c) => `${c.what} at ${c.dueAt.slice(11, 16)}`).join('; ')}.` : ''}`, ctx.workerId);
        logged(store, ctx, 'WITHDRAWAL_PLAN', personId, id, plan);
        break;
      }
      case 'checked': {
        const c = store.get<Row>('SELECT id, what, done_at AS doneAt FROM withdrawal_check WHERE id = ? AND episode_id = ?', text(b.checkId, 60), id);
        if (!c) throw new HttpError(404, 'NOT_FOUND', 'That check is not part of this withdrawal.');
        if (c.doneAt) throw new HttpError(409, 'DONE', 'That check is already done.');
        if (note.length < 2) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was done or found, e.g. "Seen 8.10pm, settled, eating".');
        store.run('UPDATE withdrawal_check SET done_by = ?, done_at = ?, note = ? WHERE id = ?', ctx.workerId, now(), note, c.id);
        step(store, id, 'CHECKED', `${c.what}: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'WITHDRAWAL_CHECK', personId, id, String(c.what));
        break;
      }
      case 'settle': {
        const open = store.get<{ n: number }>('SELECT count(*) AS n FROM withdrawal_check WHERE episode_id = ? AND done_at IS NULL', id)!.n;
        if (open) throw new HttpError(409, 'CHECKS_OPEN', `${open === 1 ? 'A timed check is' : `${open} timed checks are`} not done yet. Record each one (or why it is not needed) first.`);
        if (note.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the withdrawal has settled, e.g. "No signs for 24 hours; eating and drinking; reviewed with the addiction service".');
        transition(store, 'withdrawal_episode', id, 'SETTLED', who, note.slice(0, 200));
        store.run('UPDATE withdrawal_episode SET outcome_note = ?, outcome_by = ?, outcome_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        step(store, id, 'SETTLED', `Settled: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'WITHDRAWAL_SETTLED', personId, id, note);
        break;
      }
      case 'handon': {
        const to = text(b.handedTo, 120);
        if (to.length < 2) throw new HttpError(400, 'WHERE_REQUIRED', 'Write who or where it is handed on to, e.g. "Community alcohol and drug service".');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why and what they were told.');
        transition(store, 'withdrawal_episode', id, 'HANDED_ON', who, to);
        store.run('UPDATE withdrawal_episode SET handed_to = ?, outcome_note = ?, outcome_by = ?, outcome_at = ? WHERE id = ?', to, note, ctx.workerId, now(), id);
        step(store, id, 'HANDED_ON', `Handed on to ${to}: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'WITHDRAWAL_HANDED_ON', personId, id, to);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
