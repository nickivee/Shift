import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { pagesFor } from './cdbook.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { STATES, REFS, CD_REFS } from '../config/medicines.ts';
import { ruleValue, requireRule } from './rulevalue.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Medicines (entry 11):
//   an authorised prescriber writes the order → a nurse gives each dose, or records why it was not
//   given and who was told → the prescriber holds, resumes or stops it. A controlled drug is entered
//   in the ward's book in the same step it is given.
//   A medicine is given only on a prescriber's order; SHIFT gives no doses, rates or advice, and the
//   limits on an "as needed" medicine are the prescriber's own.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 600) => String(v ?? '').trim().slice(0, max);
const sentence = (s: string) => s.replace(/\.?$/, '.');
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const HOUR = 3_600_000;

const may = (store: Store, ctx: WorkContext, personId: string, op: 'MEDICINE_PRESCRIBE' | 'MEDICINE_GIVE') => evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string, controlled = false) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'medication', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: controlled ? CD_REFS : REFS, engines: [11],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('medication_step', { id: newId(), medication_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT m.id, m.person_id AS personId, m.medicine, m.dose, m.route, m.frequency, m.indication, m.state, m.prescriber, m.prescribed_by_id AS prescribedById,
         m.started_at AS startedAt, m.ceased_at AS ceasedAt, m.source, m.controlled, m.prn, m.prn_indication AS prnIndication, m.prn_min_hours AS prnMinHours,
         m.prn_max_24h AS prnMax24h, m.allergy_override AS allergyOverride, m.stop_note AS stopNote
    FROM medication m`;

// Active recorded allergies and intolerances that name a substance in the medicine's name.
const matches = (store: Store, personId: string, medicine: string) => store.all<Row>(
  `SELECT substance, kind, reaction, severity FROM allergy WHERE person_id = ? AND state = 'ACTIVE' AND kind IN ('ALLERGY', 'INTOLERANCE')
      AND coalesce(substance, '') <> '' AND instr(lower(?), lower(substance)) > 0`, personId, medicine);

// The chart carries the person's allergy status (HQSC Medication Charting Standard).
function allergyStatus(store: Store, personId: string) {
  const rows = store.all<Row>("SELECT kind, substance, reaction, severity FROM allergy WHERE person_id = ? AND state = 'ACTIVE'", personId);
  const items = rows.filter((r) => r.kind !== 'NO_KNOWN_ALLERGIES');
  return { status: items.length ? 'RECORDED' : rows.length ? 'NONE_KNOWN' : 'NOT_RECORDED', items };
}

// The organisation's own list of reasons a dose is not given (a setting, see ruleset.ts).
type Reason = { code: string; label: string };
const reasonMap = (store: Store, organisationId: string | null | undefined): Record<string, string> =>
  Object.fromEntries((organisationId ? ruleValue<Reason[]>(store, organisationId, 'medicine.not_given_reasons') ?? [] : []).map((x) => [x.code, x.label]));

const dosesOf = (store: Store, id: string, limit = 6) => store.all<Row>(
  `SELECT d.id, d.kind, d.dose, d.reason, d.note, d.told, d.given_at AS givenAt, w.display_name AS "by", wi.display_name AS witness
     FROM medication_dose d JOIN workforce_person w ON w.id = d.by_id LEFT JOIN workforce_person wi ON wi.id = d.witness_id
    WHERE d.medication_id = ? ORDER BY d.given_at DESC, d.rowid DESC LIMIT ${limit}`, id)
  .map((d, _i, all): Record<string, any> => {
    const labels = reasonMap(store, store.get<{ o: string }>('SELECT s.organisation_id AS o FROM medication m JOIN service s ON s.id = m.service_id WHERE m.id = ?', id)?.o);
    return { ...d, reasonLabel: d.reason ? labels[String(d.reason)] ?? null : null };
  });

// For an "as needed" medicine: what the prescriber's limits allow now.
function prnState(store: Store, r: Row, at = Date.now()) {
  if (!r.prn) return null;
  const given = store.all<{ givenAt: string }>("SELECT given_at AS givenAt FROM medication_dose WHERE medication_id = ? AND kind = 'GIVEN' ORDER BY given_at DESC", String(r.id));
  const last = given[0] ? Date.parse(given[0].givenAt) : null;
  const count24 = given.filter((g) => Date.parse(g.givenAt) > at - 24 * HOUR).length;
  const nextAt = last !== null && r.prnMinHours ? last + Number(r.prnMinHours) * HOUR : null;
  const tooSoon = nextAt !== null && at < nextAt;
  const atMax = r.prnMax24h !== null && count24 >= Number(r.prnMax24h);
  return { count24, nextAt: tooSoon ? new Date(nextAt!).toISOString() : null, tooSoon, atMax, last: last !== null ? new Date(last).toISOString() : null };
}

function shape(store: Store, r: Row, canGive: boolean, canPrescribe: boolean): Record<string, any> {
  const state = String(r.state);
  const live = state === 'ACTIVE';
  const prn = prnState(store, r);
  const acts: string[] = [];
  if (canGive && live) acts.push('give', 'notgiven');
  if (canPrescribe && (live || state === 'HELD')) acts.push(live ? 'hold' : 'resume', 'stop');
  return {
    ...r, controlled: !!r.controlled, prn: !!r.prn, stateLabel: STATES[state] ?? state, acts, prnNow: prn,
    allergy: live ? matches(store, String(r.personId), String(r.medicine)) : [],
    doses: dosesOf(store, String(r.id)),
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM medication_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.medication_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  const canPrescribe = caps.includes('medicine.prescribe') && may(store, ctx, personId, 'MEDICINE_PRESCRIBE');
  const canGive = caps.includes('medicine.give') && may(store, ctx, personId, 'MEDICINE_GIVE');
  const order: Record<string, number> = { ACTIVE: 0, HELD: 1, ORDERED: 2, VERIFIED: 2, CEASED: 3 };
  const all = store.all<Row>(`${Q} WHERE m.person_id = ?`, personId).map((r) => shape(store, r, canGive, canPrescribe))
    .sort((a, b) => (order[a.state] ?? 4) - (order[b.state] ?? 4) || String(a.medicine).localeCompare(String(b.medicine)));
  return {
    canPrescribe, canGive, allergies: allergyStatus(store, personId),
    current: all.filter((x) => ['ACTIVE', 'HELD', 'ORDERED', 'VERIFIED'].includes(x.state)), past: all.filter((x) => x.state === 'CEASED'),
    options: { notGiven: reasonMap(store, ctx.organisationId) }, pages: canGive ? pagesFor(store, ctx.serviceId) : [],
    witnesses: canGive ? witnessOptions(store, ctx) : [],
  };
}

// For the record header and Home: the count of current medicines is read elsewhere.
// Colleagues in the same role in this service who could witness a dose, if the service uses a witness.
function witnessOptions(store: Store, ctx: WorkContext) {
  const today = todayLocal();
  const profession = ROLE_BY_KEY.get(ctx.role.roleKey)?.profession;
  return store.all<{ id: string; name: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name FROM position pos JOIN employment em ON em.id = pos.employment_id JOIN workforce_person w ON w.id = em.workforce_person_id
      WHERE pos.service_id = ? AND pos.role_key = ? AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE' AND w.id != ?
      ORDER BY w.display_name`, ctx.serviceId, ctx.role.roleKey, today, today, ctx.workerId)
    .filter((r) => {
      if (!profession) return true;
      const a = store.get<{ status: string; valid_from: string; valid_to: string | null }>(
        'SELECT status, valid_from, valid_to FROM professional_authority WHERE workforce_person_id = ? AND profession = ? ORDER BY valid_from DESC LIMIT 1', r.id, profession);
      return !!a && a.status === 'CURRENT' && a.valid_from <= today && (a.valid_to === null || a.valid_to >= today);
    });
}

interface Body {
  medicine?: string; dose?: string; route?: string; frequency?: string; indication?: string; prn?: string; prnIndication?: string; prnMinHours?: string; prnMax24h?: string;
  controlled?: string; override?: string;
  doseGiven?: string; minutesAgo?: string; note?: string; pageId?: string; qty?: string; witness?: string; reason?: string; told?: string;
}
const yes = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1' || v === 'yes';

export function prescribe(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'MEDICINE_PRESCRIBE', personId }, personId);
  const medicine = text(b.medicine, 120).toUpperCase();
  if (medicine.length < 3) throw new HttpError(400, 'MEDICINE_REQUIRED', 'Write the medicine name in full, preferably the generic name, with no abbreviations.');
  const dose = text(b.dose, 80), route = text(b.route, 60), indication = text(b.indication, 200);
  if (!dose) throw new HttpError(400, 'DOSE_REQUIRED', 'Write the dose, e.g. "500 mg".');
  if (!route) throw new HttpError(400, 'ROUTE_REQUIRED', 'Write the route, e.g. "Oral".');
  if (indication.length < 3) throw new HttpError(400, 'INDICATION_REQUIRED', 'Say what it is for.');
  const prn = yes(b.prn);
  let frequency = text(b.frequency, 80);
  let prnIndication: string | null = null, minHours: number | null = null, max24: number | null = null;
  if (prn) {
    prnIndication = text(b.prnIndication, 200);
    if (prnIndication.length < 3) throw new HttpError(400, 'PRN_INDICATION', 'An "as needed" medicine needs the reason it may be given, e.g. "Pain not eased by rest".');
    minHours = Number(text(b.prnMinHours, 10));
    if (!(minHours > 0) || minHours > 72) throw new HttpError(400, 'PRN_INTERVAL', 'Write the shortest time between doses in hours, e.g. 4.');
    max24 = Number(text(b.prnMax24h, 10));
    if (!Number.isInteger(max24) || max24 < 1 || max24 > 48) throw new HttpError(400, 'PRN_MAX', 'Write the most doses that may be given in 24 hours, as a whole number.');
    frequency = frequency || 'As needed';
  } else if (!frequency) throw new HttpError(400, 'FREQUENCY_REQUIRED', 'Write how often, e.g. "Twice daily".');
  const allergies = allergyStatus(store, personId);
  if (allergies.status === 'NOT_RECORDED') {
    throw new HttpError(409, 'ALLERGY_STATUS', 'No allergy status is recorded for them. Record their allergies, or that none are known, in the Allergies screen first.');
  }
  const clash = matches(store, personId, medicine);
  const override = text(b.override, 300);
  if (clash.length && override.length < 5) {
    throw new HttpError(409, 'ALLERGY_MATCH', `They have a recorded ${String(clash[0].kind).toLowerCase()} to ${clash[0].substance}. Say why you are prescribing it anyway, or choose another medicine.`);
  }
  if (store.get("SELECT 1 FROM medication WHERE person_id = ? AND upper(medicine) = ? AND state IN ('ORDERED', 'VERIFIED', 'ACTIVE', 'HELD')", personId, medicine)) {
    throw new HttpError(409, 'ALREADY', `They already have ${medicine} ordered. Stop that order first, or change nothing.`);
  }
  const controlled = yes(b.controlled);
  const id = newId();
  const who = store.get<{ n: string }>('SELECT display_name AS n FROM workforce_person WHERE id = ?', ctx.workerId)!.n;
  store.tx(() => {
    store.insert('medication', {
      id, person_id: personId, medicine, dose, route, frequency, indication, state: 'ACTIVE', prescriber: who, started_at: now(), source: 'Prescribed in SHIFT', data_source: 'SHIFT',
      service_id: ctx.serviceId, prescribed_by_id: ctx.workerId, controlled: controlled ? 1 : 0, prn: prn ? 1 : 0, prn_indication: prnIndication, prn_min_hours: minHours, prn_max_24h: max24,
      allergy_override: clash.length ? override : null,
    });
    recordInitial(store, 'medication', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, `${medicine} ${dose}`);
    step(store, id, 'PRESCRIBED', `Prescribed: ${medicine} ${dose}, ${route}, ${frequency.toLowerCase()}, for ${indication}.${prn ? ` As needed for ${prnIndication}: at least ${minHours} hours apart, at most ${max24} in 24 hours.` : ''}${controlled ? ' Controlled drug.' : ''}${clash.length ? ` Recorded ${String(clash[0].kind).toLowerCase()} to ${clash[0].substance}; prescribed anyway: ${sentence(override)}` : ''}`, ctx.workerId);
    logged(store, ctx, 'MEDICINE_PRESCRIBE', personId, id, `${medicine} ${dose}`, controlled);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE m.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That medicine is no longer in SHIFT.');
  const personId = String(r.personId);
  const state = String(r.state);
  const prescriberAct = ['hold', 'resume', 'stop'].includes(action);
  enforce(store, ctx, { op: prescriberAct ? 'MEDICINE_PRESCRIBE' : 'MEDICINE_GIVE', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const medicine = String(r.medicine);
  const controlled = !!r.controlled;
  store.tx(() => {
    switch (action) {
      case 'give': {
        if (state !== 'ACTIVE') throw new HttpError(409, 'STATE', `${medicine} is ${(STATES[state] ?? state).toLowerCase()}, so it cannot be given.`);
        const given = text(b.doseGiven, 80);
        if (!given) throw new HttpError(400, 'DOSE_REQUIRED', 'Write the dose you gave.');
        if (norm(given) !== norm(r.dose)) {
          throw new HttpError(409, 'DOSE_DIFFERS', `The order is ${r.dose}. A medicine is given as prescribed: ask the prescriber to change the order, or record it as not given.`);
        }
        const ago = Math.round(Number(text(b.minutesAgo, 6) || '0'));
        if (!Number.isFinite(ago) || ago < 0 || ago > 24 * 60) throw new HttpError(400, 'WHEN', 'Say how many minutes ago it was given, from 0 to 1440.');
        const at = Date.now() - ago * 60_000;
        if (matches(store, personId, medicine).length && !r.allergyOverride) {
          throw new HttpError(409, 'ALLERGY_MATCH', 'A recorded allergy matches this medicine and the prescriber has not written why it is given. Ask the prescriber before you give it.');
        }
        const prn = prnState(store, r, at);
        if (prn?.tooSoon) throw new HttpError(409, 'PRN_TOO_SOON', `The prescriber set at least ${r.prnMinHours} hours between doses. The last was ${new Date(String(prn.last)).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false })}. Ask the prescriber if it needs to change.`);
        if (prn?.atMax) throw new HttpError(409, 'PRN_MAX', `The prescriber set at most ${r.prnMax24h} doses in 24 hours and ${prn.count24} have been given. Ask the prescriber if it needs to change.`);
        const doseId = newId();
        let bookEntry: string | null = null;
        let witness: string | null = null;
        if (b.witness) {
          const w = witnessOptions(store, ctx).find((x) => x.id === String(b.witness));
          if (!w) throw new HttpError(400, 'WITNESS', 'Choose a colleague in your role in this service, with current practising authority.');
          witness = w.id;
        }
        if (controlled) {
          if (!(ctx.role.capabilities as string[]).includes('cd.register')) throw new HttpError(403, 'BLOCK', 'Your workstation does not record controlled drugs.');
          const page = store.get<Row>('SELECT id, drug, unit FROM cd_book_page WHERE id = ? AND service_id = ?', text(b.pageId, 64), ctx.serviceId);
          if (!page) throw new HttpError(400, 'PAGE_REQUIRED', 'Choose the page of this ward\'s controlled drug book for this drug.');
          const qty = Number(text(b.qty, 12));
          if (!(qty > 0)) throw new HttpError(400, 'QTY_REQUIRED', `Write how much was used from the book, in ${page.unit}.`);
          const bal = store.get<{ balance: number }>('SELECT balance FROM cd_book_entry WHERE page_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', String(page.id))?.balance ?? 0;
          if (qty > bal + 1e-9) throw new HttpError(409, 'BOOK_SHORT', `The book shows ${bal} ${page.unit} for this drug, less than ${qty}. Check the count and tell the person in charge.`);
          bookEntry = newId();
          store.insert('cd_book_entry', {
            id: bookEntry, page_id: page.id, kind: 'GIVEN', qty, balance: Math.round((bal - qty) * 1e6) / 1e6, variance: 0, person_id: personId, medication_id: id,
            second_id: witness, note: note || null, by_id: ctx.workerId, at: new Date(at).toISOString(),
          });
        }
        store.insert('medication_dose', {
          id: doseId, medication_id: id, person_id: personId, service_id: ctx.serviceId, kind: 'GIVEN', dose: given, note: note || null, given_at: new Date(at).toISOString(),
          by_id: ctx.workerId, witness_id: witness, book_entry_id: bookEntry, recorded_at: now(),
        });
        step(store, id, 'GIVEN', `Given: ${given}, ${String(r.route).toLowerCase()}.${controlled ? ' Entered in the controlled drug book.' : ''}${note ? ` ${sentence(note)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'MEDICINE_GIVE', personId, id, `${medicine} ${given}`, controlled);
        break;
      }
      case 'notgiven': {
        if (state !== 'ACTIVE') throw new HttpError(409, 'STATE', `${medicine} is ${(STATES[state] ?? state).toLowerCase()}.`);
        const reasons = reasonMap(store, ctx.organisationId);
        if (!Object.keys(reasons).length) requireRule(store, ctx.organisationId, 'medicine.not_given_reasons');
        const reason = reasons[String(b.reason)] ? String(b.reason) : '';
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it was not given.');
        if (reason === 'OTHER' && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write the reason.');
        const told = text(b.told, 120);
        if (told.length < 2) throw new HttpError(400, 'TOLD_REQUIRED', 'A dose not given is told to the prescriber. Write who you told, e.g. "Dr Li".');
        store.insert('medication_dose', {
          id: newId(), medication_id: id, person_id: personId, service_id: ctx.serviceId, kind: 'NOT_GIVEN', reason, note: note || null, told, given_at: now(), by_id: ctx.workerId, recorded_at: now(),
        });
        step(store, id, 'NOT_GIVEN', `Not given: ${reasons[reason].toLowerCase()}. Told ${told}.${note ? ` ${sentence(note)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'MEDICINE_NOT_GIVEN', personId, id, `${medicine}: ${reason}`, controlled);
        break;
      }
      case 'hold':
      case 'resume':
      case 'stop': {
        if (!(ctx.role.capabilities as string[]).includes('medicine.prescribe')) throw new HttpError(403, 'BLOCK', 'Only the prescriber holds, resumes or stops a medicine.');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why.');
        if (action === 'hold') {
          if (state !== 'ACTIVE') throw new HttpError(409, 'STATE', 'Only a current medicine can be held.');
          transition(store, 'medication', id, 'HELD', who, note.slice(0, 160));
          step(store, id, 'HELD', `Held: ${sentence(note)}`, ctx.workerId);
        } else if (action === 'resume') {
          if (state !== 'HELD') throw new HttpError(409, 'STATE', 'Only a held medicine can be resumed.');
          transition(store, 'medication', id, 'ACTIVE', who, note.slice(0, 160));
          step(store, id, 'RESUMED', `Resumed: ${sentence(note)}`, ctx.workerId);
        } else {
          if (!['ACTIVE', 'HELD'].includes(state)) throw new HttpError(409, 'STATE', 'That order has already stopped.');
          transition(store, 'medication', id, 'CEASED', who, note.slice(0, 160));
          store.run('UPDATE medication SET ceased_at = ?, stop_note = ? WHERE id = ?', now(), note, id);
          step(store, id, 'STOPPED', `Stopped: ${sentence(note)}`, ctx.workerId);
        }
        logged(store, ctx, `MEDICINE_${action.toUpperCase()}`, personId, id, note, controlled);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
