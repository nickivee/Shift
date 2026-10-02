import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, KIND, REFS } from '../config/danger.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Immediate danger check (entries 40, 41):
//   asked at the front door → no one in danger, or what the danger is, what was done straight away
//   and who was told → made safe, with who made it safe and how.
// Nurses and doctors in the Emergency Department ask and record. SHIFT decides nothing.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
export const PLACE: Record<string, string> = { 'ed-rn': 'triage', 'ed-doctor': 'medical' };

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'DANGER', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'danger_check', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [40, 41],
  });
}

const Q = `
  SELECT d.id, d.person_id AS personId, d.state, d.kind, d.what, d.done, d.told, d.checked_at AS checkedAt, cb.display_name AS checkedBy,
         d.safe_note AS safeNote, d.safe_at AS safeAt, sb.display_name AS safeBy
    FROM danger_check d
    JOIN workforce_person cb ON cb.id = d.checked_by
    LEFT JOIN workforce_person sb ON sb.id = d.safe_by`;

const shape = (r: Row, can: boolean): Record<string, any> => ({
  ...r, stateLabel: STATES[String(r.state)], kindLabel: r.kind ? KIND[String(r.kind)] : null, canSafe: can && r.state === 'DANGER',
});

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  if (!(ctx.role.capabilities as string[]).includes('danger.record')) return null;
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE d.person_id = ? ORDER BY d.checked_at DESC, d.rowid DESC`, personId).map((r) => shape(r, can));
  return { current: all.filter((x) => x.state === 'DANGER'), past: all.filter((x) => x.state !== 'DANGER'), canRecord: can, options: can ? { kind: KIND } : null };
}

// For the record header: danger that has not been made safe.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE d.person_id = ? AND d.state = 'DANGER' ORDER BY d.checked_at DESC LIMIT 1`, personId);
  return r ? { kind: KIND[String(r.kind)], what: r.what, told: r.told } : null;
}

export function record(store: Store, ctx: WorkContext, personId: string, b: { danger?: string; kind?: string; what?: string; done?: string; told?: string }) {
  enforce(store, ctx, { op: 'DANGER', personId }, personId);
  if (store.get("SELECT 1 FROM danger_check WHERE person_id = ? AND state = 'DANGER'", personId)) {
    throw new HttpError(409, 'ALREADY', 'There is danger recorded for them that has not been made safe yet. Make it safe first.');
  }
  const danger = b.danger === 'YES';
  if (b.danger !== 'YES' && b.danger !== 'NO') throw new HttpError(400, 'ANSWER_REQUIRED', 'Say whether anyone is in immediate danger.');
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  let kind: string | null = null, what: string | null = null, done: string | null = null, told: string | null = null;
  if (danger) {
    kind = KIND[String(b.kind)] ? String(b.kind) : '';
    if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what the danger is.');
    what = text(b.what);
    if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what the danger is, e.g. "Brother is shouting and threatening staff in the waiting room".');
    done = text(b.done);
    if (done.length < 5) throw new HttpError(400, 'DONE_REQUIRED', 'Say what was done straight away, e.g. "Moved patient to a cubicle; called security".');
    told = text(b.told, 200);
    if (told.length < 3) throw new HttpError(400, 'TOLD_REQUIRED', 'Say who was told, e.g. "Charge nurse and security".');
  }
  store.tx(() => {
    store.insert('danger_check', { id, person_id: personId, service_id: ctx.serviceId, state: danger ? 'DANGER' : 'CLEAR', kind, what, done, told, checked_by: ctx.workerId, checked_at: now() });
    recordInitial(store, 'danger_check', id, danger ? 'DANGER' : 'CLEAR', who, danger ? String(what) : 'No one in danger');
    logged(store, ctx, 'DANGER_CHECK', personId, id, danger ? `${KIND[String(kind)]}: ${what}` : 'No one in danger');
  });
  return forPerson(store, ctx, personId);
}

export function safe(store: Store, ctx: WorkContext, id: string, b: { note?: string }) {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That danger check is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'DANGER', personId }, personId);
  if (r.state !== 'DANGER') throw new HttpError(409, 'STATE', 'This is not recorded as danger.');
  const note = text(b.note);
  if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say how it was made safe, e.g. "Brother left with security; patient settled in a cubicle".');
  store.tx(() => {
    transition(store, 'danger_check', id, 'MADE_SAFE', { actorId: ctx.workerId, workContextId: ctx.id }, note.slice(0, 200));
    store.run('UPDATE danger_check SET safe_by = ?, safe_at = ?, safe_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
    logged(store, ctx, 'DANGER_SAFE', personId, id, note);
  });
  return forPerson(store, ctx, personId);
}
