import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, transitionAll, recordInitial, history } from './lifecycle.ts';
import { vacate, bedTo } from './locations.ts';
import { endForService } from './assignments.ts';
import { requireCoding } from './coding.ts';
import { EXPECTED, CERT, NOTIFY, NOTIFY_BY_ID, DONATION, RELEASE } from '../config/deaths.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Death event (Shared Lifecycle Object 270):
//   death occurs/identified → verification → certification references → notifications →
//   clinical episode closure/transition → mortuary/coronial/donation pathways where applicable.
// Anyone caring for the person records that they have died or been found dead. A nurse or
// doctor verifies it and records what they checked. SHIFT then holds a reference to the
// medical certificate of cause of death or the report to the coroner (it never issues either),
// who has been told, what was decided about donation, the person's and whānau wishes, and who
// they were released to. Closing it ends their stay: the bed, allocations, care team and any
// open deterioration episode. Who may verify and certify, and which deaths go to the coroner,
// are research requirements (RR-DTH-001, RR-DTH-002).

type Row = Record<string, string | number | null>;
type Cap = 'death.record' | 'death.manage';
const STATES: Record<string, string> = {
  IDENTIFIED: 'Not yet verified', VERIFIED: 'Verified', CLOSED: 'Closed', ENTERED_IN_ERROR: 'Entered in error',
};
const KINDS: Record<string, string> = {
  IDENTIFIED: 'Died', VERIFIED: 'Death verified', CERTIFIED: 'Certificate', NOTIFIED: 'Told', DONATION: 'Donation',
  WISHES: 'Wishes', RELEASED: 'Released', CLOSED: 'Stay ended', ERROR: 'Entered in error',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-DTH-001', 'RR-DTH-002'];

const Q = `
  SELECT d.id, d.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, p.preferred_name AS preferred,
         (SELECT location FROM encounter e WHERE e.person_id = d.person_id AND e.service_id = d.service_id ORDER BY e.started_at DESC LIMIT 1) AS location,
         d.service_id AS serviceId, d.died_at AS diedAt, d.expected, d.place, d.circumstances, d.state,
         ib.display_name AS identifiedBy, d.identified_at AS identifiedAt,
         vb.display_name AS verifiedBy, d.verified_at AS verifiedAt, d.verify_note AS verifyNote,
         d.cert_kind AS certKind, d.cert_by AS certBy, d.cert_ref AS certRef, d.cert_note AS certNote,
         d.donation, d.donation_note AS donationNote, d.wishes,
         d.released_to AS releasedTo, d.released_name AS releasedName, d.released_at AS releasedAt, d.release_note AS releaseNote,
         cb.display_name AS closedBy, d.closed_at AS closedAt, d.close_note AS closeNote, d.error_reason AS errorReason
    FROM death_event d
    JOIN person p ON p.id = d.person_id
    JOIN workforce_person ib ON ib.id = d.identified_by
    LEFT JOIN workforce_person vb ON vb.id = d.verified_by
    LEFT JOIN workforce_person cb ON cb.id = d.closed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'DEATH', personId, cap }).decision === 'ALLOW';
const options = () => ({ expected: EXPECTED, cert: CERT, notify: NOTIFY.map((n) => ({ id: n.id, label: n.label })), donation: DONATION, release: RELEASE });

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'death', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('death_step', { id: newId(), event_id: id, kind, body, by_id: ctx.workerId, at: now() });

const notices = (store: Store, id: string) => store.all<Row>(`SELECT n.kind, n.name, n.note, w.display_name AS "by", n.at
    FROM death_notification n JOIN workforce_person w ON w.id = n.by_id WHERE n.event_id = ? ORDER BY n.at, n.rowid`, id)
  .map((n) => ({ ...n, kind: String(n.kind), kindLabel: NOTIFY_BY_ID.get(String(n.kind))?.label ?? String(n.kind) }));

// What is still needed before the stay can be ended.
function outstanding(r: Row, told: Set<string>) {
  const out: string[] = [];
  if (r.state === 'IDENTIFIED') out.push('Verify the death');
  if (!r.certKind) out.push('Record the certificate or report to the coroner');
  for (const n of NOTIFY) if (n.required && !told.has(n.id)) out.push(`Tell ${n.label.toLowerCase()}`);
  if (r.certKind === 'CORONER' && !told.has('CORONER')) out.push('Record that the coroner was told');
  if (!r.donation) out.push('Record the donation decision');
  if (!r.releasedAt) out.push('Record who they were released to');
  return out;
}

function shape(store: Store, r: Row, canManage: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const notifications = notices(store, id);
  const told = new Set(notifications.map((n) => String(n.kind)));
  const open = state === 'IDENTIFIED' || state === 'VERIFIED';
  const todo = open ? outstanding(r, told) : [];
  const can: string[] = [];
  if (canManage && open) {
    if (state === 'IDENTIFIED') can.push('verify');
    can.push('notify', 'wishes');
    if (state === 'VERIFIED') can.push('certify', 'donation');
    if (state === 'VERIFIED' && !r.releasedAt) can.push('release');
    if (state === 'VERIFIED' && !todo.length) can.push('close');
    can.push('error');
  }
  return {
    ...r, id, state, stateLabel: STATES[state], expectedLabel: EXPECTED[String(r.expected)] ?? '',
    certLabel: r.certKind ? CERT[String(r.certKind)] : null, donationLabel: r.donation ? DONATION[String(r.donation)] : null,
    releasedToLabel: r.releasedTo ? RELEASE[String(r.releasedTo)] : null,
    notifications, outstanding: todo, can,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM death_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.event_id = ? ORDER BY s.at, s.rowid`, id).map((s) => ({ ...s, kindLabel: KINDS[String(s.kind)] ?? String(s.kind) })),
    history: history(store, 'death', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That death record is no longer in SHIFT.');
  return r;
};

const when = (v: unknown, fallback: string, what: string) => {
  if (!v) return fallback;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60_000) throw new HttpError(400, 'WHEN_REQUIRED', `Give ${what}. It cannot be in the future.`);
  return new Date(t).toISOString();
};

export function identify(store: Store, ctx: WorkContext, personId: string,
  b: { diedAt?: string; expected?: string; place?: string; circumstances?: string }) {
  enforce(store, ctx, { op: 'DEATH', personId, cap: 'death.record' }, personId);
  if (store.get("SELECT 1 FROM death_event WHERE person_id = ? AND state != 'ENTERED_IN_ERROR'", personId)) {
    throw new HttpError(409, 'ALREADY_RECORDED', 'Their death is already recorded.');
  }
  if (!b.diedAt) throw new HttpError(400, 'WHEN_REQUIRED', 'Give the time they died, or were found.');
  const diedAt = when(b.diedAt, '', 'the time they died, or were found');
  const expected = EXPECTED[String(b.expected)] ? String(b.expected) : '';
  if (!expected) throw new HttpError(400, 'EXPECTED_REQUIRED', 'Say whether their death was expected.');
  const circumstances = text(b.circumstances);
  if (circumstances.length < 10) throw new HttpError(400, 'CIRCUMSTANCES_REQUIRED', 'Say what happened, e.g. "Found not breathing at the 03:00 check; comfortable at 01:00".');
  const id = newId();
  store.tx(() => {
    store.insert('death_event', {
      id, person_id: personId, service_id: ctx.serviceId, died_at: diedAt, expected, place: text(b.place, 200) || null, circumstances,
      state: 'IDENTIFIED', identified_by: ctx.workerId, identified_at: now(),
    });
    recordInitial(store, 'death', id, 'IDENTIFIED', { actorId: ctx.workerId, workContextId: ctx.id }, `${EXPECTED[expected]}: ${circumstances.slice(0, 200)}`);
    addStep(store, ctx, id, 'IDENTIFIED', `${EXPECTED[expected]}. ${circumstances}`);
    logged(store, ctx, 'DEATH_IDENTIFY', personId, id, EXPECTED[expected]);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; at?: string; kind?: string; by?: string; ref?: string; name?: string; to?: string; donation?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'DEATH', personId, cap: 'death.manage' }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', state === 'IDENTIFIED' ? 'Their death needs verifying first.' : `This is ${STATES[state].toLowerCase()}.`); };
  const note = text(b.note);
  switch (action) {
    case 'verify': {
      inState('IDENTIFIED');
      if (note.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you checked and found, e.g. "No pulse or breath sounds for one minute, pupils fixed and dilated".');
      const verifiedAt = when(b.at, at, 'the time you verified it');
      if (verifiedAt < String(r.diedAt)) throw new HttpError(400, 'BEFORE_DEATH', 'Verification cannot be before the time they died.');
      store.tx(() => {
        transition(store, 'death', id, 'VERIFIED', who, note.slice(0, 200));
        store.run('UPDATE death_event SET verified_by = ?, verified_at = ?, verify_note = ? WHERE id = ?', ctx.workerId, verifiedAt, note, id);
        addStep(store, ctx, id, 'VERIFIED', note);
        logged(store, ctx, 'DEATH_VERIFY', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'certify': {
      inState('VERIFIED');
      const kind = CERT[String(b.kind)] ? String(b.kind) : '';
      if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose whether a certificate was completed or their death was reported to the coroner.');
      const by = text(b.by, 200);
      if (by.length < 3) throw new HttpError(400, 'BY_REQUIRED', kind === 'CERTIFICATE' ? 'Write who completed the certificate.' : 'Write who reported it to the coroner.');
      const ref = text(b.ref, 200) || null;
      store.tx(() => {
        store.run('UPDATE death_event SET cert_kind = ?, cert_by = ?, cert_ref = ?, cert_note = ? WHERE id = ?', kind, by, ref, note || null, id);
        addStep(store, ctx, id, 'CERTIFIED', [`${CERT[kind]} by ${by}${ref ? ` (reference ${ref})` : ''}.`, note].filter(Boolean).join(' '));
        logged(store, ctx, 'DEATH_CERTIFY', personId, id, CERT[kind]);
      });
      break;
    }
    case 'notify': {
      inState('IDENTIFIED', 'VERIFIED');
      const n = NOTIFY_BY_ID.get(String(b.kind));
      if (!n) throw new HttpError(400, 'WHO_REQUIRED', 'Choose who was told.');
      const name = text(b.name, 200);
      if (name.length < 2) throw new HttpError(400, 'NAME_REQUIRED', 'Write their name or role.');
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how they were told, e.g. "Phoned at 03:40, coming in".');
      store.tx(() => {
        store.insert('death_notification', { id: newId(), event_id: id, kind: n.id, name, note, by_id: ctx.workerId, at });
        addStep(store, ctx, id, 'NOTIFIED', `${n.label}: ${name}. ${note}`);
        logged(store, ctx, 'DEATH_NOTIFY', personId, id, n.label);
      });
      break;
    }
    case 'donation': {
      inState('VERIFIED');
      const donation = DONATION[String(b.donation)] ? String(b.donation) : '';
      if (!donation) throw new HttpError(400, 'DONATION_REQUIRED', 'Choose what was decided about organ and tissue donation.');
      if (donation !== 'NOT_APPLICABLE' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', donation === 'REFERRED' ? 'Write who it was referred to and any reference.' : 'Write who it was discussed with.');
      store.tx(() => {
        store.run('UPDATE death_event SET donation = ?, donation_note = ? WHERE id = ?', donation, note || null, id);
        addStep(store, ctx, id, 'DONATION', `${DONATION[donation]}${note ? `: ${note}` : ''}`);
        logged(store, ctx, 'DEATH_DONATION', personId, id, DONATION[donation]);
      });
      break;
    }
    case 'wishes': {
      inState('IDENTIFIED', 'VERIFIED');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write their wishes and whānau wishes, e.g. "Whānau to stay with her; karakia before she leaves; window opened".');
      store.tx(() => {
        store.run('UPDATE death_event SET wishes = ? WHERE id = ?', note, id);
        addStep(store, ctx, id, 'WISHES', note);
        logged(store, ctx, 'DEATH_WISHES', personId, id);
      });
      break;
    }
    case 'release': {
      inState('VERIFIED');
      if (r.releasedAt) throw new HttpError(409, 'ALREADY_RELEASED', 'Their release is already recorded.');
      const to = RELEASE[String(b.to)] ? String(b.to) : '';
      if (!to) throw new HttpError(400, 'TO_REQUIRED', 'Choose who they were released to.');
      const name = text(b.name, 200);
      if (name.length < 3) throw new HttpError(400, 'NAME_REQUIRED', 'Write who collected them, e.g. "Hope Funeral Services, J. Smith".');
      const releasedAt = when(b.at, at, 'the time they left');
      store.tx(() => {
        store.run('UPDATE death_event SET released_to = ?, released_name = ?, released_at = ?, release_note = ?, released_by = ? WHERE id = ?', to, name, releasedAt, note || null, ctx.workerId, id);
        addStep(store, ctx, id, 'RELEASED', [`${RELEASE[to]}: ${name}.`, note].filter(Boolean).join(' '));
        logged(store, ctx, 'DEATH_RELEASE', personId, id, `${RELEASE[to]}: ${name}`);
      });
      break;
    }
    case 'close': {
      inState('VERIFIED');
      const todo = outstanding(r, new Set(notices(store, id).map((n) => String(n.kind))));
      if (todo.length) throw new HttpError(409, 'OUTSTANDING', `Still to do: ${todo.join('; ')}.`);
      const serviceId = String(r.serviceId);
      store.tx(() => {
        transition(store, 'death', id, 'CLOSED', who, note.slice(0, 200) || 'Stay ended');
        store.run('UPDATE death_event SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, at, note || null, id);
        // Everything that belonged to their stay here ends with it.
        for (const d of store.all<{ id: string }>("SELECT id FROM deterioration_event WHERE person_id = ? AND state != 'CLOSED'", personId)) {
          transition(store, 'deterioration', d.id, 'CLOSED', who, 'Died');
          store.run("UPDATE deterioration_event SET outcome = 'DIED', outcome_note = ?, closed_by = ?, closed_at = ? WHERE id = ?", 'Closed with their death record', ctx.workerId, at, d.id);
        }
        for (const a of transitionAll(store, 'allocation', 'person_id = ?', [personId], 'ENDED', who, 'Died')) store.run("UPDATE allocation SET ended_at = ?, end_reason = 'Died' WHERE id = ?", at, a);
        endForService(store, personId, serviceId, 'Died', who);
        vacate(store, personId, serviceId, 'Died', at);
        bedTo(store, "person_id = ? AND service_id = ? AND state = 'OCCUPIED'", [personId, serviceId], 'CLEANING', who, 'Died', null);
        bedTo(store, "person_id = ? AND service_id = ? AND state = 'RESERVED'", [personId, serviceId], 'AVAILABLE', who, 'Died', null);
        const enc = store.get<{ id: string }>("SELECT id FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, serviceId);
        if (enc) {
          transition(store, 'encounter', enc.id, 'ENDED', who, 'Died');
          store.run('UPDATE encounter SET ended_at = ? WHERE id = ?', at, enc.id);
          requireCoding(store, enc.id, 'Died', who);
        }
        store.run('UPDATE care_relationship SET ended_at = ? WHERE person_id = ? AND ended_at IS NULL AND service_id IN (SELECT id FROM service WHERE organisation_id = ?)',
          at, personId, ctx.organisationId);
        addStep(store, ctx, id, 'CLOSED', note || 'Stay ended.');
        logged(store, ctx, 'DEATH_CLOSE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      inState('IDENTIFIED', 'VERIFIED');
      if (note.length < 10) throw new HttpError(400, 'REASON_REQUIRED', 'Write why this was entered in error, e.g. "Recorded on the wrong person".');
      store.tx(() => {
        transition(store, 'death', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE death_event SET error_reason = ? WHERE id = ?', note, id);
        addStep(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'DEATH_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, load(store, id), true);
}

// The person's Death view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canRecord = may(store, ctx, personId, 'death.record');
  const canManage = may(store, ctx, personId, 'death.manage');
  const all = store.all<Row>(`${Q} WHERE d.person_id = ? ORDER BY d.identified_at DESC`, personId).map((r) => shape(store, r, canManage));
  const event = all.find((e) => e.state !== 'ENTERED_IN_ERROR') ?? null;
  return { event, errors: all.filter((e) => e.state === 'ENTERED_IN_ERROR'), canRecord: canRecord && !event, canManage, options: options() };
}

// For the record header.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE d.person_id = ? AND d.state != 'ENTERED_IN_ERROR'`, personId);
  if (!r) return null;
  const s = shape(store, r, false);
  return { id: s.id, diedAt: String(r.diedAt), state: s.state, stateLabel: s.stateLabel, outstanding: s.outstanding.length };
}

// Home → Deaths: open ones first with what is still to do, then those closed in the last 30 days.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('death.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include managing deaths`);
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const rows = store.all<Row>(`${Q} WHERE d.service_id = ? AND (d.state IN ('IDENTIFIED', 'VERIFIED') OR (d.state = 'CLOSED' AND d.closed_at >= ?)) ORDER BY d.died_at DESC`,
    ctx.serviceId, since).map((r) => shape(store, r, false));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_DEATHS', decision: 'ALLOW', outcome: 'VIEWED' });
  return { open: rows.filter((r) => r.state !== 'CLOSED'), closed: rows.filter((r) => r.state === 'CLOSED') };
}
