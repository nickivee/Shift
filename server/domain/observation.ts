import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, OUTCOME, REFS } from '../config/observation.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Short stay for observation (entries 40, 41):
//   a doctor places someone in observation with why, what to watch and when to review → the review
//   is done and either extended with a new time, or the stay ends with an outcome (home, needs
//   admission, other). ED nurses see it; only doctors place, extend and end.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
export const PLACE: Record<string, string> = { 'ed-doctor': 'medical', 'ed-rn': 'monitoring' };

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'OBSERVATION', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'ed_observation', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [40, 41],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('ed_observation_step', { id: newId(), observation_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT o.id, o.person_id AS personId, o.state, o.why, o.watch, o.review_at AS reviewAt, o.placed_at AS placedAt, pb.display_name AS placedBy,
         o.outcome, o.outcome_note AS outcomeNote, ob.display_name AS outcomeBy, o.ended_at AS endedAt
    FROM ed_observation o
    JOIN workforce_person pb ON pb.id = o.placed_by
    LEFT JOIN workforce_person ob ON ob.id = o.ended_by`;

const shape = (store: Store, r: Row, doctor: boolean): Record<string, any> => ({
  ...r, stateLabel: STATES[String(r.state)], outcomeLabel: r.outcome ? OUTCOME[String(r.outcome)] : null,
  overdue: r.state === 'OBSERVING' && Date.parse(String(r.reviewAt)) < Date.now(),
  canAct: doctor && r.state === 'OBSERVING',
  steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM ed_observation_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.observation_id = ? ORDER BY s.at, s.rowid', String(r.id)),
});

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  if (!caps.includes('observation.manage') && !caps.includes('observation.view')) return null;
  const doctor = may(store, ctx, personId) && caps.includes('observation.manage');
  const all = store.all<Row>(`${Q} WHERE o.person_id = ? ORDER BY o.placed_at DESC, o.rowid DESC`, personId).map((r) => shape(store, r, doctor));
  return { current: all.filter((x) => x.state === 'OBSERVING'), past: all.filter((x) => x.state !== 'OBSERVING'), canPlace: doctor, options: { outcome: OUTCOME } };
}

// For the record header.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE o.person_id = ? AND o.state = 'OBSERVING' ORDER BY o.placed_at DESC LIMIT 1`, personId);
  if (!r) return null;
  return { why: r.why, reviewAt: r.reviewAt, overdue: Date.parse(String(r.reviewAt)) < Date.now() };
}

interface Body { why?: string; watch?: string; reviewAt?: string; note?: string; outcome?: string }

const reviewTime = (v: unknown) => {
  const s = text(v, 30);
  if (!STAMP.test(s) || Date.parse(s) < Date.now() - 5 * 60_000) throw new HttpError(400, 'REVIEW_AT', 'Choose when the next review is due. It cannot be in the past.');
  return new Date(s).toISOString();
};

export function place(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'OBSERVATION', personId }, personId);
  if (!(ctx.role.capabilities as string[]).includes('observation.manage')) throw new HttpError(403, 'BLOCK', 'Only a doctor places someone in observation.');
  if (store.get("SELECT 1 FROM ed_observation WHERE person_id = ? AND state = 'OBSERVING'", personId)) throw new HttpError(409, 'ALREADY', 'They are already in observation.');
  const why = text(b.why);
  if (why.length < 5) throw new HttpError(400, 'WHY_REQUIRED', 'Say why they are staying, e.g. "Head injury, GCS 15; to be watched for 4 hours".');
  const watch = text(b.watch);
  if (watch.length < 5) throw new HttpError(400, 'WATCH_REQUIRED', 'Say what to watch for and what to do, e.g. "Neuro obs hourly; tell me if drowsy, vomiting or worse headache".');
  const reviewAt = reviewTime(b.reviewAt);
  const id = newId();
  store.tx(() => {
    store.insert('ed_observation', { id, person_id: personId, service_id: ctx.serviceId, state: 'OBSERVING', why, watch, review_at: reviewAt, placed_by: ctx.workerId, placed_at: now() });
    recordInitial(store, 'ed_observation', id, 'OBSERVING', { actorId: ctx.workerId, workContextId: ctx.id }, why);
    step(store, id, 'PLACED', `Placed in observation: ${why.replace(/\.?$/, '.')} Watch: ${watch.replace(/\.?$/, '.')} Review due ${String(b.reviewAt).replace('T', ' ')}.`, ctx.workerId);
    logged(store, ctx, 'OBSERVATION_PLACE', personId, id, why);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE o.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That observation is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'OBSERVATION', personId }, personId);
  if (!(ctx.role.capabilities as string[]).includes('observation.manage')) throw new HttpError(403, 'BLOCK', 'Only a doctor reviews an observation.');
  if (r.state !== 'OBSERVING') throw new HttpError(409, 'STATE', 'This observation has ended.');
  const note = text(b.note);
  store.tx(() => {
    if (action === 'extend') {
      const reviewAt = reviewTime(b.reviewAt);
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what you found at the review and why they are staying longer.');
      store.run('UPDATE ed_observation SET review_at = ? WHERE id = ?', reviewAt, id);
      step(store, id, 'EXTENDED', `Reviewed, staying longer: ${note.replace(/\.?$/, '.')} Next review ${String(b.reviewAt).replace('T', ' ')}.`, ctx.workerId);
      logged(store, ctx, 'OBSERVATION_EXTEND', personId, id, note);
    } else if (action === 'end') {
      const outcome = OUTCOME[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose how the stay ends: going home, needs admission, or something else.');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what you found and what happens next.');
      transition(store, 'ed_observation', id, 'ENDED', { actorId: ctx.workerId, workContextId: ctx.id }, `${OUTCOME[outcome]}: ${note.slice(0, 160)}`);
      store.run('UPDATE ed_observation SET outcome = ?, outcome_note = ?, ended_by = ?, ended_at = ? WHERE id = ?', outcome, note, ctx.workerId, now(), id);
      step(store, id, 'ENDED', `${OUTCOME[outcome]}: ${note.replace(/\.?$/, '.')}`, ctx.workerId);
      logged(store, ctx, 'OBSERVATION_END', personId, id, `${OUTCOME[outcome]}: ${note}`);
    } else throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  });
  return forPerson(store, ctx, personId);
}
