import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, DEVICE, REFS } from '../config/oxygen.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Oxygen therapy (entries 70, 199):
//   the doctor prescribes it with a target range, device and flow → nurses record readings as the
//   flow or device is changed (a reading outside the doctor's range is shown, nothing more) → the
//   doctor changes the prescription, weans it, resumes it, or stops it.
//   SHIFT has no target ranges, flows or titration rules of its own.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const OPEN = ['ON', 'WEANING'];
export const PLACE: Record<string, string> = { 'ed-doctor': 'medical', 'ed-rn': 'monitoring', 'genmed-physician': 'review', 'genmed-rn': 'monitoring' };

const may = (store: Store, ctx: WorkContext, personId: string, op: 'OXYGEN' | 'OXYGEN_PRESCRIBE') => evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'oxygen_therapy', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [70],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('oxygen_step', { id: newId(), therapy_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT t.id, t.person_id AS personId, t.state, t.why, t.target_low AS targetLow, t.target_high AS targetHigh, t.device, t.flow,
         pb.display_name AS prescribedBy, t.prescribed_at AS prescribedAt, t.stop_note AS stopNote, sb.display_name AS stoppedBy, t.stopped_at AS stoppedAt
    FROM oxygen_therapy t
    JOIN workforce_person pb ON pb.id = t.prescribed_by
    LEFT JOIN workforce_person sb ON sb.id = t.stopped_by`;

const readingsOf = (store: Store, id: string) => store.all<Row>(
  `SELECT r.spo2, r.device, r.flow, r.note, r.outside, w.display_name AS "by", r.at FROM oxygen_reading r JOIN workforce_person w ON w.id = r.by_id
    WHERE r.therapy_id = ? ORDER BY r.at DESC, r.rowid DESC`, id)
  .map((r): Record<string, any> => ({ ...r, outside: !!r.outside, deviceLabel: DEVICE[String(r.device)] }));

function shape(store: Store, r: Row, nurse: boolean, doctor: boolean): Record<string, any> {
  const state = String(r.state);
  const open = OPEN.includes(state);
  const readings = readingsOf(store, String(r.id));
  const acts: string[] = [];
  if (open && (nurse || doctor)) acts.push('reading');
  if (open && doctor) acts.push('change', state === 'ON' ? 'wean' : 'resume', 'stop');
  return {
    ...r, stateLabel: STATES[state], deviceLabel: DEVICE[String(r.device)], readings, acts,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM oxygen_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.therapy_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  if (!caps.includes('oxygen.prescribe') && !caps.includes('oxygen.record')) return null;
  const nurse = may(store, ctx, personId, 'OXYGEN');
  const doctor = may(store, ctx, personId, 'OXYGEN_PRESCRIBE') && caps.includes('oxygen.prescribe');
  const all = store.all<Row>(`${Q} WHERE t.person_id = ? ORDER BY t.prescribed_at DESC`, personId).map((r) => shape(store, r, nurse, doctor));
  return { current: all.filter((x) => OPEN.includes(x.state)), past: all.filter((x) => !OPEN.includes(x.state)), canPrescribe: doctor, options: { device: DEVICE } };
}

// For the record header.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE t.person_id = ? AND t.state IN ('ON', 'WEANING') ORDER BY t.prescribed_at DESC LIMIT 1`, personId);
  if (!r) return null;
  const last = readingsOf(store, String(r.id))[0] ?? null;
  return { state: STATES[String(r.state)], targetLow: r.targetLow, targetHigh: r.targetHigh, last };
}

interface Body { why?: string; low?: string; high?: string; device?: string; flow?: string; spo2?: string; note?: string }

const percent = (v: unknown, label: string) => {
  const n = Number(String(v ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new HttpError(400, 'PERCENT', `Write the ${label} as a whole number from 1 to 100.`);
  return n;
};
const range = (b: Body) => {
  const low = percent(b.low, 'lowest oxygen saturation in the target range');
  const high = percent(b.high, 'highest oxygen saturation in the target range');
  if (low > high) throw new HttpError(400, 'RANGE', 'The lowest value cannot be higher than the highest.');
  return { low, high };
};
const deviceFlow = (b: Body) => {
  const device = pick(DEVICE, b.device);
  if (!device) throw new HttpError(400, 'DEVICE_REQUIRED', 'Choose the device.');
  const flow = text(b.flow, 40);
  if (!flow) throw new HttpError(400, 'FLOW_REQUIRED', 'Write the flow as prescribed, e.g. "2 L/min", or "Room air" if none.');
  return { device, flow };
};

export function prescribe(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'OXYGEN_PRESCRIBE', personId }, personId);
  if (store.get("SELECT 1 FROM oxygen_therapy WHERE person_id = ? AND state IN ('ON', 'WEANING')", personId)) throw new HttpError(409, 'ALREADY', 'They already have oxygen prescribed. Change that one.');
  const why = text(b.why);
  if (why.length < 5) throw new HttpError(400, 'WHY_REQUIRED', 'Say why they need oxygen, e.g. "Pneumonia, saturations 88% on air".');
  const { low, high } = range(b);
  const { device, flow } = deviceFlow(b);
  const id = newId();
  store.tx(() => {
    store.insert('oxygen_therapy', { id, person_id: personId, service_id: ctx.serviceId, state: 'ON', why, target_low: low, target_high: high, device, flow, prescribed_by: ctx.workerId, prescribed_at: now() });
    recordInitial(store, 'oxygen_therapy', id, 'ON', { actorId: ctx.workerId, workContextId: ctx.id }, why);
    step(store, id, 'PRESCRIBED', `Prescribed: ${sentence(why)} Target ${low} to ${high}%. ${DEVICE[device]}, ${flow}.`, ctx.workerId);
    logged(store, ctx, 'OXYGEN_PRESCRIBE', personId, id, why);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE t.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That oxygen is no longer in SHIFT.');
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: action === 'reading' ? 'OXYGEN' : 'OXYGEN_PRESCRIBE', personId }, personId);
  if (action !== 'reading' && !(ctx.role.capabilities as string[]).includes('oxygen.prescribe')) throw new HttpError(403, 'BLOCK', 'Only a doctor changes, weans or stops oxygen.');
  if (!OPEN.includes(state)) throw new HttpError(409, 'STATE', 'This oxygen has stopped; nothing more can be added.');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  store.tx(() => {
    switch (action) {
      case 'reading': {
        const spo2 = percent(b.spo2, 'oxygen saturation');
        const { device, flow } = deviceFlow(b);
        const outside = spo2 < Number(r.targetLow) || spo2 > Number(r.targetHigh) ? 1 : 0;
        store.insert('oxygen_reading', { id: newId(), therapy_id: id, spo2, device, flow, note: note || null, outside, by_id: ctx.workerId, at: now() });
        if (device !== r.device || flow !== r.flow) store.run('UPDATE oxygen_therapy SET device = ?, flow = ? WHERE id = ?', device, flow, id);
        step(store, id, 'READING', `${spo2}% on ${DEVICE[device].toLowerCase()}, ${flow}.${outside ? ` Outside the range ${r.targetLow} to ${r.targetHigh}% set by ${r.prescribedBy}.` : ''}${note ? ` ${sentence(note)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'OXYGEN_READING', personId, id, `${spo2}% ${flow}`);
        break;
      }
      case 'change': {
        const { low, high } = range(b);
        const { device, flow } = deviceFlow(b);
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why it is being changed, e.g. "Known COPD, so the lower range".');
        store.run('UPDATE oxygen_therapy SET target_low = ?, target_high = ?, device = ?, flow = ? WHERE id = ?', low, high, device, flow, id);
        step(store, id, 'CHANGED', `Changed: target ${low} to ${high}%, ${DEVICE[device]}, ${flow}. ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'OXYGEN_CHANGE', personId, id, note);
        break;
      }
      case 'wean': {
        if (state !== 'ON') throw new HttpError(409, 'STATE', 'It is already being weaned.');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write the weaning plan, e.g. "Reduce by 1 L/min each review if in range".');
        transition(store, 'oxygen_therapy', id, 'WEANING', who, note.slice(0, 160));
        step(store, id, 'WEANING', `Weaning: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'OXYGEN_WEAN', personId, id, note);
        break;
      }
      case 'resume': {
        if (state !== 'WEANING') throw new HttpError(409, 'STATE', 'It is not being weaned.');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why oxygen goes back to full, e.g. "Saturations fell when reduced".');
        transition(store, 'oxygen_therapy', id, 'ON', who, note.slice(0, 160));
        step(store, id, 'RESUMED', `Back on oxygen: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'OXYGEN_RESUME', personId, id, note);
        break;
      }
      case 'stop': {
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why it is stopped, e.g. "Saturations 96% on room air for 6 hours".');
        transition(store, 'oxygen_therapy', id, 'STOPPED', who, note.slice(0, 160));
        store.run('UPDATE oxygen_therapy SET stop_note = ?, stopped_by = ?, stopped_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        step(store, id, 'STOPPED', `Stopped: ${sentence(note)}`, ctx.workerId);
        logged(store, ctx, 'OXYGEN_STOP', personId, id, note);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
