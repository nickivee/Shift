import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ruleValue } from './rulevalue.ts';
import { STATES, NOT_GIVEN_REASONS, REFS, type Vaccine } from '../config/immunisation.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Immunisation (matrix: Immunisation tab for general practice and practice nursing): each vaccine given or not given,
// when, the dose as the clinician words it, where it was given and the batch number. The vaccines to choose from are the
// jurisdiction's own list (immunisation.vaccines). SHIFT sets no ages, intervals, who may vaccinate or reporting
// (RR-IMMUNISATION-001), so it shows what was recorded and nothing is worked out as due.

type Row = Record<string, string | number | null>;

const Q = `
  SELECT i.id, i.person_id AS personId, i.service_id AS serviceId, i.state, i.vaccine, i.given_at AS givenAt, i.dose, i.site, i.batch,
         i.reason, i.note, i.reaction, rb.display_name AS recordedBy, i.recorded_at AS recordedAt,
         cb.display_name AS closedBy, i.closed_at AS closedAt, i.closed_note AS closedNote
    FROM immunisation i
    JOIN workforce_person rb ON rb.id = i.recorded_by
    LEFT JOIN workforce_person cb ON cb.id = i.closed_by`;

const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'IMMUNISATION', personId }).decision === 'ALLOW';
const vaccines = (store: Store, ctx: WorkContext) => (ctx.organisationId ? ruleValue<Vaccine[]>(store, ctx.organisationId, 'immunisation.vaccines') ?? [] : []);

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'immunisation', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const state = String(r.state);
  const actions: string[] = [];
  if (can && r.serviceId === ctx.serviceId) {
    if (state === 'GIVEN') actions.push('reaction');
    if (state !== 'ENTERED_IN_ERROR') actions.push('error');
  }
  const v = vaccines(store, ctx).find((x) => x.code === r.vaccine);
  return {
    ...r, state, stateLabel: STATES[state], vaccineLabel: v?.label ?? String(r.vaccine),
    reasonLabel: r.reason ? NOT_GIVEN_REASONS.find((x) => x.code === r.reason)?.label ?? String(r.reason) : null, actions,
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE i.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That immunisation record is no longer in SHIFT.');
  return r;
};

export function record(store: Store, ctx: WorkContext, personId: string, b: { given?: string; vaccine?: string; when?: string; dose?: string; site?: string; batch?: string; reason?: string; note?: string }) {
  enforce(store, ctx, { op: 'IMMUNISATION', personId }, personId);
  const list = vaccines(store, ctx);
  if (!list.length) throw new HttpError(409, 'RULE_NOT_SET', 'No list of vaccines has been set for your organisation yet. Ask the person who manages rules.');
  if (!list.some((x) => x.code === b.vaccine)) throw new HttpError(400, 'VACCINE_REQUIRED', 'Choose the vaccine.');
  const given = b.given !== 'no';
  const t = Date.parse(String(b.when ?? ''));
  if (Number.isNaN(t) || t > Date.now() + 5 * 60_000 || t < Date.now() - 400 * 86_400_000) throw new HttpError(400, 'DATE', 'Enter when this happened, within the last year. Earlier vaccines can be written in the note.');
  const dose = text(b.dose, 100);
  const site = text(b.site, 100);
  const batch = text(b.batch, 100);
  const note = text(b.note, 1000);
  let reason: string | null = null;
  if (b.vaccine === 'OTHER' && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write which vaccine it was in the note.');
  if (given) {
    if (!dose) throw new HttpError(400, 'DOSE_REQUIRED', 'Write which dose this was, e.g. "Dose 2".');
    if (!site) throw new HttpError(400, 'SITE_REQUIRED', 'Write where it was given, e.g. "Left thigh".');
    if (!batch) throw new HttpError(400, 'BATCH_REQUIRED', 'Write the batch number from the vial.');
  } else {
    if (!NOT_GIVEN_REASONS.some((x) => x.code === b.reason)) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it was not given.');
    reason = String(b.reason);
    if (reason === 'OTHER' && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write the reason.');
  }
  const state = given ? 'GIVEN' : 'NOT_GIVEN';
  const id = newId();
  const what = `${list.find((x) => x.code === b.vaccine)!.label}: ${given ? 'given' : 'not given'}`;
  store.tx(() => {
    store.insert('immunisation', {
      id, person_id: personId, service_id: ctx.serviceId, state, vaccine: b.vaccine, given_at: new Date(t).toISOString(), dose: dose || null, site: site || null,
      batch: batch || null, reason, note: note || null, recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'immunisation', id, state, { actorId: ctx.workerId, workContextId: ctx.id }, what.slice(0, 200));
    logged(store, ctx, 'IMMUNISATION_RECORD', personId, id, what.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'IMMUNISATION', personId }, personId);
  if (r.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the service that recorded this can act on it.');
  const state = String(r.state);
  const note = text(b.note);
  if (action === 'reaction') {
    if (state !== 'GIVEN') throw new HttpError(409, 'WRONG_STATE', `This vaccine is ${STATES[state].toLowerCase()}.`);
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write the reaction in the person\'s or whānau\'s words and what was done.');
    store.tx(() => {
      const prior = r.reaction ? `${r.reaction}\n` : '';
      store.run('UPDATE immunisation SET reaction = ? WHERE id = ?', `${prior}${now().slice(0, 16).replace('T', ' ')} ${note}`.slice(0, 2000), id);
      logged(store, ctx, 'IMMUNISATION_REACTION', personId, id, note.slice(0, 200));
    });
  } else if (action === 'error') {
    if (state === 'ENTERED_IN_ERROR') throw new HttpError(409, 'WRONG_STATE', 'This is already marked as entered in error.');
    if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why, e.g. "Recorded on the wrong person".');
    store.tx(() => {
      transition(store, 'immunisation', id, 'ENTERED_IN_ERROR', { actorId: ctx.workerId, workContextId: ctx.id }, note.slice(0, 200));
      store.run('UPDATE immunisation SET closed_by = ?, closed_at = ?, closed_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
      logged(store, ctx, 'IMMUNISATION_ERROR', personId, id, note.slice(0, 200));
    });
  } else {
    throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Immunisation view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const rows = store.all<Row>(`${Q} WHERE i.person_id = ? AND i.service_id = ? ORDER BY i.given_at DESC`, personId, ctx.serviceId)
    .map((r) => ({ ...shape(store, ctx, r, can), history: history(store, 'immunisation', String(r.id)) }));
  const list = vaccines(store, ctx);
  return {
    records: rows,
    canRecord: can,
    ruleSet: list.length > 0,
    options: { vaccines: list, reasons: NOT_GIVEN_REASONS },
  };
}
