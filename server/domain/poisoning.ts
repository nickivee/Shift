import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, ROUTE, TIME_KNOWN, INTENT, ADVICE_FROM, REFS } from '../config/poisoning.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Poisoning and overdose (entry 117):
//   what was taken, how much, how and when, and whether it was deliberate → advice from the
//   National Poisons Centre or a toxicologist, as given → the doctor's plan: what to watch, timed
//   checks and until when → checks done → medically cleared, or admitted. After deliberate
//   self-harm the record also carries who assessed their safety. ED nurses and doctors record the
//   exposure, advice and checks; doctors plan, clear and admit.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const OPEN = ['ASSESSING', 'MONITORING'];

const may = (store: Store, ctx: WorkContext, personId: string, op: 'POISON' | 'POISON_MANAGE') => evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'toxic_exposure', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [117],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('toxic_step', { id: newId(), exposure_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT t.id, t.person_id AS personId, t.state, t.substances, t.amount, t.route, t.taken_at AS takenAt, t.time_known AS timeKnown, t.intent, t.source,
         rb.display_name AS recordedBy, t.recorded_at AS recordedAt, t.plan, pb.display_name AS plannedBy, t.watch_until AS watchUntil,
         t.safety, sb.display_name AS safetyBy, t.safety_at AS safetyAt, t.outcome_note AS outcomeNote, ob.display_name AS outcomeBy, t.outcome_at AS outcomeAt, t.admitted_to AS admittedTo
    FROM toxic_exposure t
    JOIN workforce_person rb ON rb.id = t.recorded_by
    LEFT JOIN workforce_person pb ON pb.id = t.planned_by
    LEFT JOIN workforce_person sb ON sb.id = t.safety_by
    LEFT JOIN workforce_person ob ON ob.id = t.outcome_by`;

const checksOf = (store: Store, id: string) => store.all<Row>(
  `SELECT c.id, c.what, c.due_at AS dueAt, db.display_name AS doneBy, c.done_at AS doneAt, c.note
     FROM toxic_check c LEFT JOIN workforce_person db ON db.id = c.done_by WHERE c.exposure_id = ? ORDER BY c.due_at, c.rowid`, id)
  .map((c): Record<string, any> => ({ ...c, overdue: !c.doneAt && Date.parse(String(c.dueAt)) < Date.now() }));

function shape(store: Store, r: Row, nurse: boolean, doctor: boolean): Record<string, any> {
  const state = String(r.state);
  const open = OPEN.includes(state);
  const checks = checksOf(store, String(r.id));
  const acts: string[] = [];
  if (open && (nurse || doctor)) acts.push('advice');
  if (open && doctor) acts.push('plan');
  if (open && (nurse || doctor) && r.intent === 'DELIBERATE') acts.push('safety');
  if (open && doctor) acts.push('clear', 'admit');
  return {
    ...r, state, stateLabel: STATES[state], routeLabel: ROUTE[String(r.route)], timeKnownLabel: TIME_KNOWN[String(r.timeKnown)], intentLabel: INTENT[String(r.intent)],
    checks, outstanding: checks.filter((c) => !c.doneAt).length, canTick: open && (nurse || doctor), acts,
    advice: store.all<Row>(`SELECT a.source, a.who, a.advice, w.display_name AS "by", a.at FROM toxic_advice a JOIN workforce_person w ON w.id = a.by_id WHERE a.exposure_id = ? ORDER BY a.at, a.rowid`, String(r.id))
      .map((a): Record<string, any> => ({ ...a, sourceLabel: ADVICE_FROM[String(a.source)] })),
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM toxic_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.exposure_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

// ED doctors' Medical Assessment and ED nurses' Monitoring.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  if (!caps.includes('poison.manage') && !caps.includes('poison.record')) return null;
  const nurse = may(store, ctx, personId, 'POISON');
  const doctor = may(store, ctx, personId, 'POISON_MANAGE');
  const all = store.all<Row>(`${Q} WHERE t.person_id = ? ORDER BY t.recorded_at DESC`, personId).map((r) => shape(store, r, nurse, doctor));
  return {
    current: all.filter((x) => OPEN.includes(x.state)),
    past: all.filter((x) => !OPEN.includes(x.state)),
    canRecord: nurse || doctor,
    options: nurse || doctor ? { route: ROUTE, timeKnown: TIME_KNOWN, intent: INTENT, adviceFrom: ADVICE_FROM } : null,
  };
}

// For the record header: an open poisoning, and the next check.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE t.person_id = ? AND t.state IN ('ASSESSING', 'MONITORING') ORDER BY t.recorded_at DESC LIMIT 1`, personId);
  if (!r) return null;
  const next = checksOf(store, String(r.id)).find((c) => !c.doneAt) ?? null;
  return { substances: r.substances, intent: INTENT[String(r.intent)], state: STATES[String(r.state)], watchUntil: r.watchUntil, next };
}

interface Body {
  substances?: string; amount?: string; route?: string; takenAt?: string; timeKnown?: string; intent?: string; source?: string;
  from?: string; who?: string; advice?: string; plan?: string; watchUntil?: string; checks?: { what?: string; dueAt?: string }[]; checkId?: string;
  safety?: string; note?: string; admittedTo?: string;
}

export function record(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'POISON', personId }, personId);
  if (store.get("SELECT 1 FROM toxic_exposure WHERE person_id = ? AND state IN ('ASSESSING', 'MONITORING')", personId)) {
    throw new HttpError(409, 'ALREADY', 'A poisoning is already open for them. Add to that one.');
  }
  const substances = text(b.substances, 300);
  if (substances.length < 3) throw new HttpError(400, 'SUBSTANCES_REQUIRED', 'Write what was taken, with the product name and strength if known, e.g. "Paracetamol 500 mg tablets".');
  const amount = text(b.amount, 200) || 'Not known';
  const route = pick(ROUTE, b.route);
  if (!route) throw new HttpError(400, 'ROUTE_REQUIRED', 'Choose how it was taken.');
  const timeKnown = pick(TIME_KNOWN, b.timeKnown);
  if (!timeKnown) throw new HttpError(400, 'TIME_REQUIRED', 'Say whether the time is known.');
  const takenAt = text(b.takenAt, 30);
  if (timeKnown !== 'UNKNOWN' && (!STAMP.test(takenAt) || Date.parse(takenAt) > Date.now() + 5 * 60_000)) throw new HttpError(400, 'TAKEN_AT', 'Choose when it was taken (or say the time is not known).');
  const intent = pick(INTENT, b.intent);
  if (!intent) throw new HttpError(400, 'INTENT_REQUIRED', 'Choose whether it was accidental, deliberate, recreational, at work, or not known.');
  const source = text(b.source, 200);
  if (source.length < 3) throw new HttpError(400, 'SOURCE_REQUIRED', 'Write who told us, e.g. "Patient", "Flatmate who found her", "Ambulance".');
  const id = newId();
  const at = timeKnown === 'UNKNOWN' ? null : new Date(takenAt).toISOString();
  store.tx(() => {
    store.insert('toxic_exposure', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'ASSESSING', substances, amount, route, taken_at: at, time_known: timeKnown, intent, source,
      recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'toxic_exposure', id, 'ASSESSING', { actorId: ctx.workerId, workContextId: ctx.id }, substances);
    step(store, id, 'RECORDED', `${substances}: ${amount}. ${ROUTE[route]}. ${TIME_KNOWN[timeKnown]}${at ? ` (${takenAt.replace('T', ' ')})` : ''}. ${INTENT[intent]}. Told by ${sentence(source)}`, ctx.workerId);
    logged(store, ctx, 'POISON_RECORD', personId, id, substances);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE t.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That poisoning is no longer in SHIFT.');
  const personId = String(r.personId);
  const state = String(r.state);
  const doctorWork = ['plan', 'clear', 'admit'].includes(action);
  enforce(store, ctx, { op: doctorWork ? 'POISON_MANAGE' : 'POISON', personId }, personId);
  if (!OPEN.includes(state)) throw new HttpError(409, 'STATE', `This poisoning is ${STATES[state].toLowerCase()}; nothing more can be added.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note, 1000);
  store.tx(() => {
    switch (action) {
      case 'advice': {
        const from = pick(ADVICE_FROM, b.from);
        if (!from) throw new HttpError(400, 'FROM_REQUIRED', 'Choose where the advice came from.');
        const whoSaid = text(b.who, 120);
        if (whoSaid.length < 2) throw new HttpError(400, 'WHO_REQUIRED', 'Write who gave the advice, e.g. "Sam, Poisons Centre, by phone".');
        const advice = text(b.advice, 2000);
        if (advice.length < 10) throw new HttpError(400, 'ADVICE_REQUIRED', 'Write the advice as it was given.');
        store.insert('toxic_advice', { id: newId(), exposure_id: id, source: from, who: whoSaid, advice, by_id: ctx.workerId, at: now() });
        step(store, id, 'ADVICE', `${ADVICE_FROM[from]} (${whoSaid}): ${sentence(advice)}`, ctx.workerId);
        logged(store, ctx, 'POISON_ADVICE', personId, id, ADVICE_FROM[from]);
        break;
      }
      case 'plan': {
        const plan = text(b.plan, 1500);
        if (plan.length < 10) throw new HttpError(400, 'PLAN_REQUIRED', 'Write what to watch for and what to do, e.g. "Obs hourly; tell me if drowsy or vomiting".');
        const until = text(b.watchUntil, 30);
        if (until && !STAMP.test(until)) throw new HttpError(400, 'UNTIL', 'Choose when watching can stop, or leave it empty.');
        const checks = (Array.isArray(b.checks) ? b.checks : []).map((c) => ({ what: text(c?.what, 200), dueAt: text(c?.dueAt, 30) })).filter((c) => c.what || c.dueAt);
        for (const c of checks) {
          if (c.what.length < 3 || !STAMP.test(c.dueAt)) throw new HttpError(400, 'CHECK', 'Each timed check needs what to do and when, e.g. "Paracetamol level" at 4 hours after it was taken.');
        }
        if (state === 'ASSESSING') transition(store, 'toxic_exposure', id, 'MONITORING', who, 'Plan made');
        store.run('UPDATE toxic_exposure SET plan = ?, planned_by = ?, watch_until = ? WHERE id = ?', plan, ctx.workerId, until ? new Date(until).toISOString() : null, id);
        for (const c of checks) store.insert('toxic_check', { id: newId(), exposure_id: id, what: c.what, due_at: new Date(c.dueAt).toISOString(), added_by: ctx.workerId });
        step(store, id, 'PLAN', `Plan: ${sentence(plan)}${until ? ` Watch until ${until.replace('T', ' ')}.` : ''}${checks.length ? ` Checks: ${checks.map((c) => `${c.what} at ${c.dueAt.slice(11, 16)}`).join('; ')}.` : ''}`, ctx.workerId);
        logged(store, ctx, 'POISON_PLAN', personId, id, plan);
        break;
      }
      case 'checked': {
        const c = store.get<Row>('SELECT id, what, done_at AS doneAt FROM toxic_check WHERE id = ? AND exposure_id = ?', text(b.checkId, 60), id);
        if (!c) throw new HttpError(404, 'NOT_FOUND', 'That check is not part of this poisoning.');
        if (c.doneAt) throw new HttpError(409, 'DONE', 'That check is already done.');
        if (note.length < 2) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was done or found, e.g. "Blood taken 3.10pm, sent".');
        store.run('UPDATE toxic_check SET done_by = ?, done_at = ?, note = ? WHERE id = ?', ctx.workerId, now(), note, c.id);
        step(store, id, 'CHECKED', `${c.what}: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'POISON_CHECK', personId, id, String(c.what));
        break;
      }
      case 'safety': {
        if (r.intent !== 'DELIBERATE') throw new HttpError(409, 'NOT_DELIBERATE', 'This is only for deliberate self-harm.');
        const safety = text(b.safety, 1500);
        if (safety.length < 10) throw new HttpError(400, 'SAFETY_REQUIRED', 'Write who assessed their safety, what they found, and the plan to keep them safe.');
        store.run('UPDATE toxic_exposure SET safety = ?, safety_by = ?, safety_at = ? WHERE id = ?', safety, ctx.workerId, now(), id);
        step(store, id, 'SAFETY', `Safety: ${sentence(safety)}`, ctx.workerId);
        logged(store, ctx, 'POISON_SAFETY', personId, id, 'Safety assessment recorded');
        break;
      }
      case 'clear': {
        const open = store.get<{ n: number }>('SELECT count(*) AS n FROM toxic_check WHERE exposure_id = ? AND done_at IS NULL', id)!.n;
        if (open) throw new HttpError(409, 'CHECKS_OPEN', `${open === 1 ? 'A timed check is' : `${open} timed checks are`} not done yet. Record each one (or why it is not needed) first.`);
        if (note.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why they are medically safe now, e.g. "4-hour level below the treatment line on Poisons Centre advice; obs normal".');
        transition(store, 'toxic_exposure', id, 'CLEARED', who, note.slice(0, 200));
        store.run('UPDATE toxic_exposure SET outcome_note = ?, outcome_by = ?, outcome_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        step(store, id, 'CLEARED', `Medically cleared: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'POISON_CLEARED', personId, id, note);
        break;
      }
      case 'admit': {
        const to = text(b.admittedTo, 120);
        if (to.length < 2) throw new HttpError(400, 'WHERE_REQUIRED', 'Write where they are being admitted, e.g. "General Medicine for acetylcysteine".');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why.');
        transition(store, 'toxic_exposure', id, 'ADMITTED', who, to);
        store.run('UPDATE toxic_exposure SET admitted_to = ?, outcome_note = ?, outcome_by = ?, outcome_at = ? WHERE id = ?', to, note, ctx.workerId, now(), id);
        step(store, id, 'ADMITTED', `Admitted to ${to}: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'POISON_ADMITTED', personId, id, to);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
