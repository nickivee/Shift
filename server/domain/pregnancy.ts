import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ruleValue, requireRule } from './rulevalue.ts';
import { STATES, REFS } from '../config/pregnancy.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';
import { isBaby } from './baby.ts';

// Pregnancy (matrix: Pregnancy tab for midwives and obstetric doctors): booked and antenatal, in labour,
// baby born, postnatal, then care ends. SHIFT records what the clinician enters (RR-MATERNITY-001).

type Row = Record<string, string | number | null>;
type Mode = { code: string; label: string };
const LOG: Record<string, string> = { BOOKED: 'Booked', CONTACT: 'Contact', LABOUR: 'Labour started', BIRTH: 'Birth', POSTNATAL: 'Postnatal care started', CLOSED: 'Care ended', ERROR: 'Entered in error' };
const OPEN = ['ANTENATAL', 'LABOUR', 'BIRTHED', 'POSTNATAL'];

const Q = `
  SELECT g.id, g.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, g.service_id AS serviceId, g.state, g.due_date AS dueDate, g.due_basis AS dueBasis,
         g.gravida, g.parity, g.considerations, g.booked_at AS bookedAt, bb.display_name AS bookedBy, g.labour_at AS labourAt, g.birth_at AS birthAt,
         g.birth_mode AS birthMode, g.birth_note AS birthNote, g.baby_note AS babyNote, g.postnatal_at AS postnatalAt,
         g.ended_at AS endedAt, g.ended_note AS endedNote, eb.display_name AS endedBy
    FROM pregnancy g
    JOIN person p ON p.id = g.person_id
    JOIN workforce_person bb ON bb.id = g.booked_by
    LEFT JOIN workforce_person eb ON eb.id = g.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'PREGNANCY', personId }).decision === 'ALLOW';
const modes = (store: Store, ctx: WorkContext) => (ctx.organisationId ? ruleValue<Mode[]>(store, ctx.organisationId, 'pregnancy.birth_modes') ?? [] : []);

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'pregnancy', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('pregnancy_step', { id: newId(), pregnancy_id: id, kind, body, by_id: ctx.workerId, at: now() });

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const mine = r.serviceId === ctx.serviceId;
  const actions: string[] = [];
  if (can && mine) {
    if (['ANTENATAL', 'POSTNATAL'].includes(state)) actions.push('contact');
    if (state === 'ANTENATAL') actions.push('labour');
    if (state === 'LABOUR') actions.push('birth');
    if (state === 'BIRTHED') actions.push('postnatal');
    if (['ANTENATAL', 'POSTNATAL'].includes(state)) actions.push('close');
    if (OPEN.includes(state)) actions.push('error');
  }
  const labels = Object.fromEntries(modes(store, ctx).map((x) => [x.code, x.label]));
  return {
    ...r, id, state, stateLabel: STATES[state], open: OPEN.includes(state), birthModeLabel: r.birthMode ? labels[String(r.birthMode)] ?? String(r.birthMode) : null, actions,
    log: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM pregnancy_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.pregnancy_id = ? ORDER BY s.at, s.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'pregnancy', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE g.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That pregnancy is no longer in SHIFT.');
  return r;
};

const whole = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export function book(store: Store, ctx: WorkContext, personId: string, b: { dueDate?: string; dueBasis?: string; gravida?: string; parity?: string; considerations?: string }) {
  enforce(store, ctx, { op: 'PREGNANCY', personId }, personId);
  const due = String(b.dueDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due < addDays(todayLocal(), -30) || due > addDays(todayLocal(), 300)) throw new HttpError(400, 'DATE', 'Enter the due date, from a month ago to about ten months ahead.');
  const basis = text(b.dueBasis, 300);
  if (basis.length < 3) throw new HttpError(400, 'BASIS_REQUIRED', 'Say how the due date was worked out, e.g. "Dating scan at 12 weeks".');
  const gravida = whole(b.gravida, 1, 30);
  const parity = whole(b.parity, 0, 30);
  if (gravida === null || parity === null) throw new HttpError(400, 'NUMBERS', 'Enter how many pregnancies (this one included) and how many births she has had before.');
  if (store.get('SELECT 1 FROM pregnancy WHERE person_id = ? AND service_id = ? AND state IN (\'ANTENATAL\', \'LABOUR\', \'BIRTHED\', \'POSTNATAL\')', personId, ctx.serviceId)) {
    throw new HttpError(409, 'ALREADY_OPEN', 'This person already has a pregnancy open in this service.');
  }
  const considerations = text(b.considerations, 1000);
  const id = newId();
  store.tx(() => {
    store.insert('pregnancy', { id, person_id: personId, service_id: ctx.serviceId, state: 'ANTENATAL', booked_by: ctx.workerId, booked_at: now(), due_date: due, due_basis: basis, gravida, parity, considerations: considerations || null });
    recordInitial(store, 'pregnancy', id, 'ANTENATAL', { actorId: ctx.workerId, workContextId: ctx.id }, `Due ${due}`);
    addStep(store, ctx, id, 'BOOKED', `Due ${due} (${basis}). Pregnancies ${gravida}, births before ${parity}.${considerations ? ` ${considerations}` : ''}`);
    logged(store, ctx, 'PREGNANCY_BOOK', personId, id, `Due ${due}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; when?: string; mode?: string; baby?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'PREGNANCY', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that booked this pregnancy can record on it.');
  const state = String(r.state);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This pregnancy is ${STATES[state].toLowerCase()}.`); };
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const at = now();
  const step = (to: string | null, kind: string, body: string, update?: [string, ...unknown[]]) => store.tx(() => {
    if (to) transition(store, 'pregnancy', id, to, who, body.slice(0, 200));
    if (update) store.run(update[0], ...(update.slice(1) as (string | number | null)[]));
    addStep(store, ctx, id, kind, body);
    logged(store, ctx, `PREGNANCY_${kind}`, personId, id, body.slice(0, 200));
  });
  switch (action) {
    case 'contact':
      inState('ANTENATAL', 'POSTNATAL');
      need(5, 'Write what happened at the contact.');
      step(null, 'CONTACT', note);
      break;
    case 'labour':
      inState('ANTENATAL');
      step('LABOUR', 'LABOUR', note || 'Labour started.', ['UPDATE pregnancy SET labour_at = ?, labour_by = ? WHERE id = ?', at, ctx.workerId, id]);
      break;
    case 'birth': {
      inState('LABOUR');
      const list = ctx.organisationId ? requireRule<Mode[]>(store, ctx.organisationId, 'pregnancy.birth_modes') : [];
      const mode = list.find((x) => x.code === b.mode);
      if (!mode) throw new HttpError(400, 'MODE_REQUIRED', 'Choose how the baby was born.');
      const when = Date.parse(String(b.when ?? ''));
      if (Number.isNaN(when) || when > Date.now() + 3_600_000 || when < Date.parse(String(r.labourAt ?? r.bookedAt)) - 3_600_000) throw new HttpError(400, 'DATE', 'Enter when the baby was born, after labour started and not in the future.');
      const baby = text(b.baby, 1000);
      if (baby.length < 5) throw new HttpError(400, 'BABY_REQUIRED', 'Say how the baby is, e.g. "Girl, 3.4 kg, cried at once, skin to skin".');
      if (mode.code === 'OTHER' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say how the baby was born.');
      const iso = new Date(when).toISOString();
      step('BIRTHED', 'BIRTH', `${mode.label} at ${iso.slice(0, 16).replace('T', ' ')} (UTC).${note ? ` ${note}` : ''} Baby: ${baby}`,
        ['UPDATE pregnancy SET birth_at = ?, birth_by = ?, birth_mode = ?, birth_note = ?, baby_note = ? WHERE id = ?', iso, ctx.workerId, mode.code, note || null, baby, id]);
      break;
    }
    case 'postnatal':
      inState('BIRTHED');
      step('POSTNATAL', 'POSTNATAL', note || 'Postnatal care started.', ['UPDATE pregnancy SET postnatal_at = ?, postnatal_by = ? WHERE id = ?', at, ctx.workerId, id]);
      break;
    case 'close':
      inState('ANTENATAL', 'POSTNATAL');
      need(5, state === 'ANTENATAL' ? 'Say why care is ending, e.g. "Moved to another region" or what happened.' : 'Say how care ended, e.g. "Handed to the Well Child provider and her GP".');
      step('CLOSED', 'CLOSED', note, ['UPDATE pregnancy SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id]);
      break;
    case 'error':
      inState(...OPEN);
      need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".');
      step('ENTERED_IN_ERROR', 'ERROR', note, ['UPDATE pregnancy SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id]);
      break;
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Pregnancy view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE g.person_id = ? AND g.service_id = ? ORDER BY g.booked_at DESC`, personId, ctx.serviceId).map((r) => shape(store, ctx, r, can));
  return { open: all.filter((x) => x.open), ended: all.filter((x) => !x.open), canBook: can && !all.some((x) => x.open) && !isBaby(store, personId), options: { modes: modes(store, ctx) } };
}
