import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { BABY_STATES, FEED_STATES, METHODS, REFS } from '../config/baby.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// The baby's own record and feeding (matrix: Baby and Feeding tabs for maternity). When a baby has been born on a pregnancy
// in this service, the midwife can open the baby's record: a person linked to the mother, with a placeholder name, the birth
// time and a local number only. SHIFT creates no NHI and registers nothing (RR-NEWBORN-001). Feeds are recorded as written.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'BABY', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, type: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: type, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const BQ = `
  SELECT b.id, b.person_id AS personId, b.mother_person_id AS motherId, b.pregnancy_id AS pregnancyId, b.service_id AS serviceId, b.state, b.born_at AS bornAt, b.note,
         p.given_name || ' ' || p.family_name AS name, m.given_name || ' ' || m.family_name AS mother, ob.display_name AS openedBy, b.opened_at AS openedAt,
         cb.display_name AS closedBy, b.closed_at AS closedAt, b.closed_note AS closedNote
    FROM baby_record b
    JOIN person p ON p.id = b.person_id
    JOIN person m ON m.id = b.mother_person_id
    JOIN workforce_person ob ON ob.id = b.opened_by
    LEFT JOIN workforce_person cb ON cb.id = b.closed_by`;

const FQ = `
  SELECT f.id, f.baby_person_id AS personId, f.service_id AS serviceId, f.state, f.method, f.fed_at AS fedAt, f.amount, f.note, rb.display_name AS recordedBy,
         f.recorded_at AS recordedAt, cb.display_name AS closedBy, f.closed_at AS closedAt, f.closed_note AS closedNote
    FROM baby_feed f
    JOIN workforce_person rb ON rb.id = f.recorded_by
    LEFT JOIN workforce_person cb ON cb.id = f.closed_by`;

const activeBaby = (store: Store, personId: string) => store.get<Row>(`${BQ} WHERE b.person_id = ? AND b.state = 'ACTIVE'`, personId);

// Open a baby's record on a pregnancy whose baby has been born.
export function open(store: Store, ctx: WorkContext, pregnancyId: string, b: { when?: string; note?: string; another?: string }) {
  const g = store.get<Row>('SELECT id, person_id AS personId, service_id AS serviceId, state, birth_at AS birthAt, labour_at AS labourAt, booked_at AS bookedAt FROM pregnancy WHERE id = ?', pregnancyId);
  if (!g) throw new HttpError(404, 'NOT_FOUND', 'That pregnancy is no longer in SHIFT.');
  const motherId = String(g.personId);
  enforce(store, ctx, { op: 'BABY', personId: motherId }, motherId);
  if (g.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that booked this pregnancy can open the baby\'s record.');
  if (!['BIRTHED', 'POSTNATAL'].includes(String(g.state))) throw new HttpError(409, 'WRONG_STATE', 'Record the birth on the pregnancy first.');
  const existing = store.get<{ n: number }>("SELECT count(*) AS n FROM baby_record WHERE pregnancy_id = ? AND state = 'ACTIVE'", pregnancyId)!.n;
  if (existing && b.another !== 'yes') throw new HttpError(409, 'ALREADY_OPEN', 'A baby\'s record is already open for this pregnancy. If there was another baby, tick that box.');
  const bornAt = b.when ? Date.parse(b.when) : Date.parse(String(g.birthAt));
  if (Number.isNaN(bornAt) || bornAt > Date.now() + 3_600_000 || bornAt < Date.parse(String(g.labourAt ?? g.bookedAt)) - 3_600_000) throw new HttpError(400, 'DATE', 'Enter when the baby was born, after labour started and not in the future.');
  const note = text(b.note);
  if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say how the baby is, e.g. "Girl, 3.4 kg, cried at once, skin to skin".');
  const mother = store.get<Row>('SELECT id, given_name, family_name, data_source FROM person WHERE id = ?', motherId)!;
  const enc = store.get<Row>("SELECT location, kind FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE' ORDER BY started_at DESC", motherId, ctx.serviceId);
  const prefix = mother.data_source === 'SYNTHETIC' ? 'TEST' : 'LOCAL';
  let n = store.get<{ n: number }>("SELECT count(*) AS n FROM external_identifier WHERE system = 'LOCAL_MRN'")!.n;
  let mrn = '';
  do { mrn = `${prefix}-${String(++n).padStart(5, '0')}`; } while (store.get("SELECT 1 FROM external_identifier WHERE system = 'LOCAL_MRN' AND value = ?", mrn));
  const personId = newId();
  const id = newId();
  const iso = new Date(bornAt).toISOString();
  store.tx(() => {
    store.insert('person', {
      id: personId, family_name: String(mother.family_name), given_name: `Baby of ${mother.given_name}`, date_of_birth: iso.slice(0, 10), gender: null, ethnicity: null, iwi: null,
      data_source: String(mother.data_source), created_at: now(),
    });
    store.insert('external_identifier', { id: newId(), person_id: personId, system: 'LOCAL_MRN', value: mrn, verification: String(mother.data_source) === 'SYNTHETIC' ? 'SYNTHETIC' : 'UNVERIFIED', created_at: now() });
    store.insert('encounter', { id: newId(), person_id: personId, service_id: ctx.serviceId, location: enc ? `With mother · ${enc.location}` : 'With mother', kind: String(enc?.kind ?? 'COMMUNITY'), started_at: iso, state: 'ACTIVE' });
    store.insert('baby_record', { id, person_id: personId, mother_person_id: motherId, pregnancy_id: pregnancyId, service_id: ctx.serviceId, state: 'ACTIVE', born_at: iso, note, opened_by: ctx.workerId, opened_at: now() });
    recordInitial(store, 'baby', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, note.slice(0, 200));
    logged(store, ctx, 'BABY_OPEN', personId, 'baby', id, note.slice(0, 200));
    logged(store, ctx, 'BABY_OPEN_FOR_MOTHER', motherId, 'baby', id, 'A baby\'s record was opened for this pregnancy.');
  });
  return forPerson(store, ctx, motherId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const r = store.get<Row>(`${BQ} WHERE b.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That baby\'s record is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'BABY', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that opened this record can act on it.');
  if (action !== 'error') throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  if (r.state === 'ENTERED_IN_ERROR') throw new HttpError(409, 'WRONG_STATE', 'This is already marked as entered in error.');
  const note = text(b.note);
  if (note.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why this was entered in error, e.g. "Opened for the wrong pregnancy".');
  store.tx(() => {
    transition(store, 'baby', id, 'ENTERED_IN_ERROR', { actorId: ctx.workerId, workContextId: ctx.id }, note.slice(0, 200));
    store.run('UPDATE baby_record SET closed_by = ?, closed_at = ?, closed_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
    logged(store, ctx, 'BABY_ERROR', personId, 'baby', id, note.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

// The Baby view: on a baby's own record, the baby's details and mother; on a mother's record, her babies and the births that can have a record opened.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const own = store.get<Row>(`${BQ} WHERE b.person_id = ?`, personId);
  const shapeBaby = (r: Row) => ({ ...r, stateLabel: BABY_STATES[String(r.state)], history: history(store, 'baby', String(r.id)),
    actions: can && r.serviceId === ctx.serviceId && r.state === 'ACTIVE' ? ['error'] : [] });
  const babyRows = store.all<Row>(`${BQ} WHERE b.mother_person_id = ? AND b.service_id = ? ORDER BY b.born_at`, personId, ctx.serviceId);
  const babies = babyRows.map(shapeBaby);
  const openable = can ? store.all<Row>("SELECT id, state, birth_at AS birthAt, baby_note AS babyNote, due_date AS dueDate FROM pregnancy WHERE person_id = ? AND service_id = ? AND state IN ('BIRTHED', 'POSTNATAL') ORDER BY birth_at", personId, ctx.serviceId)
    .map((g) => ({ ...g, babies: babyRows.filter((x) => x.pregnancyId === g.id && x.state === 'ACTIVE').length })) : [];
  return { baby: own ? shapeBaby(own) : null, babies, openable, canRecord: can };
}

export const isBaby = (store: Store, personId: string) => !!activeBaby(store, personId);

// Feeding on the baby's own record.
export function recordFeed(store: Store, ctx: WorkContext, personId: string, b: { method?: string; when?: string; amount?: string; note?: string }) {
  enforce(store, ctx, { op: 'BABY', personId }, personId);
  if (!activeBaby(store, personId)) throw new HttpError(409, 'NOT_A_BABY', 'Feeds are recorded on a baby\'s own record. Open the baby\'s record from the mother\'s Baby tab first.');
  if (!METHODS.some((x) => x.code === b.method)) throw new HttpError(400, 'METHOD_REQUIRED', 'Choose how the baby was fed.');
  const t = Date.parse(String(b.when ?? ''));
  if (Number.isNaN(t) || t > Date.now() + 5 * 60_000 || t < Date.now() - 30 * 86_400_000) throw new HttpError(400, 'DATE', 'Enter when the feed was, within the last 30 days.');
  const amount = text(b.amount, 100);
  const note = text(b.note);
  if (b.method === 'OTHER' && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how the baby was fed in the note.');
  const id = newId();
  store.tx(() => {
    store.insert('baby_feed', { id, baby_person_id: personId, service_id: ctx.serviceId, state: 'GIVEN', method: b.method, fed_at: new Date(t).toISOString(), amount: amount || null, note: note || null, recorded_by: ctx.workerId, recorded_at: now() });
    recordInitial(store, 'babyfeed', id, 'GIVEN', { actorId: ctx.workerId, workContextId: ctx.id }, String(b.method));
    logged(store, ctx, 'BABY_FEED_RECORD', personId, 'babyfeed', id, `${b.method}${amount ? ` ${amount}` : ''}`);
  });
  return feedsFor(store, ctx, personId);
}

export function feedAct(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const r = store.get<Row>(`${FQ} WHERE f.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That feed is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'BABY', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that recorded this can act on it.');
  if (action !== 'error') throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  if (r.state === 'ENTERED_IN_ERROR') throw new HttpError(409, 'WRONG_STATE', 'This is already marked as entered in error.');
  const note = text(b.note);
  if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why, e.g. "Recorded on the wrong baby".');
  store.tx(() => {
    transition(store, 'babyfeed', id, 'ENTERED_IN_ERROR', { actorId: ctx.workerId, workContextId: ctx.id }, note.slice(0, 200));
    store.run('UPDATE baby_feed SET closed_by = ?, closed_at = ?, closed_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
    logged(store, ctx, 'BABY_FEED_ERROR', personId, 'babyfeed', id, note.slice(0, 200));
  });
  return feedsFor(store, ctx, personId);
}

export function feedsFor(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const baby = !!activeBaby(store, personId);
  const rows = store.all<Row>(`${FQ} WHERE f.baby_person_id = ? AND f.service_id = ? ORDER BY f.fed_at DESC`, personId, ctx.serviceId).map((r) => ({
    ...r, stateLabel: FEED_STATES[String(r.state)], methodLabel: METHODS.find((x) => x.code === r.method)?.label ?? String(r.method),
    actions: can && r.state === 'GIVEN' ? ['error'] : [], history: history(store, 'babyfeed', String(r.id)),
  }));
  return { isBaby: baby, feeds: rows, canRecord: can && baby, options: { methods: METHODS } };
}
