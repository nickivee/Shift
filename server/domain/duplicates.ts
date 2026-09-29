import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { compare, moveAll, moveBack, counted, type Stated } from './identitymatch.ts';
import { GENDERS } from '../config/identitymatch.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Duplicate Record Resolution (Cross-System Capability 305):
//   possible duplicate detected → review → confirmed duplicate/not duplicate → authorised
//   reconciliation → canonical identity/object relationship → retained provenance → downstream correction.
// SHIFT spots two records with the same date of birth and name; anyone caring for the person can
// flag a pair too. A senior clinician reviews the two side by side and decides. A duplicate is
// reconciled into one canonical record: the record with the NHI is kept, everything on the other
// moves across, and the other stays in SHIFT marked as merged. Every service whose entries moved
// gets a task to check them, and the whole reconciliation can be undone.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = { POSSIBLE: 'Possible duplicate', NOT_DUPLICATE: 'Not the same person', RECONCILED: 'Merged into one record' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-DUP-001'];
// A duplicate merge also moves identity provenance; identities, staff and the audit trail never move.
const FIXED = new Set(['person', 'external_identifier', 'workforce_person', 'audit_event', 'identity_match_log']);
const LOG_LABELS: Record<string, string> = {
  DETECTED: 'Spotted by SHIFT', FLAGGED: 'Flagged', NOT_DUPLICATE: 'Not the same person', MERGED: 'Merged into one record',
  CHECK: 'Follow-up checks', UNDONE: 'Merge undone', REOPENED: 'Reopened',
};

const Q = `
  SELECT d.id, d.person_a AS personA, d.person_b AS personB, d.kept_id AS keptId, d.merged_id AS mergedId,
         d.detected_how AS detectedHow, db.display_name AS detectedBy, d.detected_at AS detectedAt, d.reason, d.state,
         rb.display_name AS reviewedBy, d.reviewed_at AS reviewedAt, d.review_note AS reviewNote, d.manifest,
         ub.display_name AS undoneBy, d.undone_at AS undoneAt, d.undone_note AS undoneNote
    FROM duplicate_case d
    LEFT JOIN workforce_person db ON db.id = d.detected_by
    LEFT JOIN workforce_person rb ON rb.id = d.reviewed_by
    LEFT JOIN workforce_person ub ON ub.id = d.undone_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const canFlag = (ctx: WorkContext) => ctx.role.capabilities.includes('duplicate.flag');
const canResolve = (ctx: WorkContext) => ctx.role.capabilities.includes('duplicate.resolve');
const log = (store: Store, id: string, kind: string, body: string, by: string | null) =>
  store.insert('duplicate_log', { id: newId(), case_id: id, kind, body, by_id: by, at: now() });
function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'duplicate_case', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

// "Margaret Oliver (local record PHY-20417)", so two records with one name can be told apart.
const label = (sd: { personId: string; name: string; nhi: { value: string } | null }) => `${sd.name} (${sd.nhi ? `NHI ${sd.nhi.value}` : 'no NHI'})`;
const genderCode = (label: unknown) => Object.entries(GENDERS).find(([, v]) => v.toLowerCase() === String(label ?? '').toLowerCase())?.[0] ?? '';
const nhiOf = (store: Store, personId: string) =>
  store.get<{ value: string; verification: string }>("SELECT value, verification FROM external_identifier WHERE person_id = ? AND system = 'NHI'", personId) ?? null;

// One side of a pair, as a reviewer needs to see it.
function side(store: Store, personId: string) {
  const p = store.get<Row>('SELECT id, given_name, family_name, preferred_name, date_of_birth, gender, data_source, created_at, merged_into FROM person WHERE id = ?', personId)!;
  const enc = store.all<Row>('SELECT s.name AS service, e.state, e.started_at AS startedAt, e.ended_at AS endedAt FROM encounter e JOIN service s ON s.id = e.service_id WHERE e.person_id = ? ORDER BY e.started_at DESC', personId);
  const allergies = store.all<{ s: string }>("SELECT COALESCE(substance, 'No known allergies') AS s FROM allergy WHERE person_id = ? AND state = 'ACTIVE'", personId).map((a) => a.s);
  return {
    personId, name: `${p.given_name} ${p.family_name}`, preferredName: p.preferred_name, dob: p.date_of_birth, gender: p.gender,
    nhi: nhiOf(store, personId), source: p.data_source, createdAt: p.created_at, mergedInto: p.merged_into,
    encounters: enc, allergies,
  };
}

function pairEvidence(store: Store, a: string, b: string) {
  const p = store.get<Row>('SELECT given_name, family_name, date_of_birth, gender FROM person WHERE id = ?', b)!;
  const s: Stated = { given: String(p.given_name), family: String(p.family_name), nhi: nhiOf(store, b)?.value ?? '', dob: String(p.date_of_birth ?? ''), gender: genderCode(p.gender) };
  return compare(store, a, s);
}

// Pairs of live records with the same date of birth and matching names, and NHIs that do not differ.
function detect(store: Store, ctx: WorkContext) {
  const pairs = store.all<{ a: string; b: string }>(
    `SELECT x.id AS a, y.id AS b FROM person x JOIN person y ON y.date_of_birth = x.date_of_birth AND y.id > x.id
      WHERE x.date_of_birth IS NOT NULL AND x.merged_into IS NULL AND y.merged_into IS NULL
        AND x.id NOT IN (SELECT person_id FROM workforce_person) AND y.id NOT IN (SELECT person_id FROM workforce_person)
        AND NOT EXISTS (SELECT 1 FROM duplicate_case d WHERE (d.person_a = x.id AND d.person_b = y.id) OR (d.person_a = y.id AND d.person_b = x.id))`);
  for (const { a, b } of pairs) {
    const c = pairEvidence(store, a, b);
    if (!c.enough || c.differ.includes('NHI')) continue;
    // The record with an NHI goes first: it is the one to keep.
    const [first, second] = nhiOf(store, b) && !nhiOf(store, a) ? [b, a] : [a, b];
    const id = newId();
    store.tx(() => {
      store.insert('duplicate_case', {
        id, person_a: first, person_b: second, detected_how: 'SHIFT', detected_by: null, detected_at: now(), state: 'POSSIBLE',
        reason: `Same ${c.agreeLabel.toLowerCase()}.`, evidence: JSON.stringify(c),
      });
      recordInitial(store, 'duplicate_case', id, 'POSSIBLE', { actorId: ctx.workerId, workContextId: ctx.id }, 'Spotted by SHIFT');
      log(store, id, 'DETECTED', `Two records agree on ${c.agreeLabel}${c.differLabel ? `, and differ on ${c.differLabel}` : ''}.`, null);
      logged(store, ctx, 'DUPLICATE_DETECTED', first, id, second);
    });
  }
}

function shape(store: Store, ctx: WorkContext, r: Row) {
  const id = String(r.id);
  const state = String(r.state);
  const a = side(store, String(r.personA));
  const b = side(store, String(r.personB));
  const actions: string[] = [];
  if (canResolve(ctx)) {
    if (state === 'POSSIBLE') actions.push('merge', 'not');
    if (state === 'RECONCILED') actions.push('undo');
    if (state === 'NOT_DUPLICATE') actions.push('reopen');
  }
  const { manifest: _m, ...rest } = r;
  return {
    ...rest, id, state, stateLabel: STATES[state], a, b,
    evidence: pairEvidence(store, String(r.personA), String(r.personB)),
    // Only the record with the NHI can be kept when just one has one; two different NHIs cannot be merged here.
    keepable: a.nhi && b.nhi ? [] : a.nhi ? [a.personId] : b.nhi ? [b.personId] : [a.personId, b.personId],
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, COALESCE(w.display_name, \'SHIFT\') AS "by", l.at FROM duplicate_log l LEFT JOIN workforce_person w ON w.id = l.by_id WHERE l.case_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'duplicate_case', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That duplicate case is no longer in SHIFT.');
  return r;
};

// Anyone caring for the person can flag a record that might be the same person.
export function flag(store: Store, ctx: WorkContext, personId: string, b: { otherId?: string; reason?: string }) {
  enforce(store, ctx, { op: 'DUPLICATE', personId }, personId);
  const other = String(b.otherId ?? '');
  if (!other || other === personId || !store.get('SELECT 1 FROM person WHERE id = ? AND merged_into IS NULL', other)) throw new HttpError(400, 'OTHER_REQUIRED', 'Choose the other record.');
  const reason = text(b.reason);
  if (reason.length < 10) throw new HttpError(400, 'REASON_REQUIRED', 'Say why they might be the same person, e.g. "Same name and date of birth; old physio record has no NHI".');
  if (store.get("SELECT 1 FROM duplicate_case WHERE state != 'NOT_DUPLICATE' AND ((person_a = ? AND person_b = ?) OR (person_a = ? AND person_b = ?))", personId, other, other, personId)) {
    throw new HttpError(409, 'ALREADY_OPEN', 'These two records are already being looked at as possible duplicates.');
  }
  const [first, second] = nhiOf(store, other) && !nhiOf(store, personId) ? [other, personId] : [personId, other];
  const id = newId();
  store.tx(() => {
    store.insert('duplicate_case', {
      id, person_a: first, person_b: second, detected_how: 'FLAGGED', detected_by: ctx.workerId, detected_at: now(), state: 'POSSIBLE', reason,
      evidence: JSON.stringify(pairEvidence(store, first, second)),
    });
    recordInitial(store, 'duplicate_case', id, 'POSSIBLE', { actorId: ctx.workerId, workContextId: ctx.id }, reason.slice(0, 200));
    log(store, id, 'FLAGGED', reason, ctx.workerId);
    logged(store, ctx, 'DUPLICATE_FLAGGED', personId, id, other);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { keep?: string; note?: string; from?: string }) {
  const r = load(store, id);
  const state = String(r.state);
  const pa = String(r.personA);
  const pb = String(r.personB);
  if (!canResolve(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot decide duplicates. Ask a senior clinician.`);
  const viewFrom = String(b.from ?? '') || pa;
  enforce(store, ctx, { op: 'DUPLICATE', personId: viewFrom === pb ? pb : pa }, viewFrom === pb ? pb : pa);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  let result = viewFrom;
  switch (action) {
    case 'not': {
      if (state !== 'POSSIBLE') throw new HttpError(409, 'WRONG_STATE', `This is ${STATES[state].toLowerCase()}.`);
      need(10, 'Say how you know they are different people, e.g. "Different mothers\' names and addresses; twins".');
      store.tx(() => {
        transition(store, 'duplicate_case', id, 'NOT_DUPLICATE', who, note.slice(0, 200));
        store.run('UPDATE duplicate_case SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, id, 'NOT_DUPLICATE', note, ctx.workerId);
        logged(store, ctx, 'DUPLICATE_NOT', pa, id, note.slice(0, 200));
      });
      break;
    }
    case 'reopen': {
      if (state !== 'NOT_DUPLICATE') throw new HttpError(409, 'WRONG_STATE', `This is ${STATES[state].toLowerCase()}.`);
      need(10, 'Say what has changed, e.g. "GP confirmed they are the same person".');
      store.tx(() => {
        transition(store, 'duplicate_case', id, 'POSSIBLE', who, note.slice(0, 200));
        log(store, id, 'REOPENED', note, ctx.workerId);
        logged(store, ctx, 'DUPLICATE_REOPEN', pa, id, note.slice(0, 200));
      });
      break;
    }
    case 'merge': {
      if (state !== 'POSSIBLE') throw new HttpError(409, 'WRONG_STATE', `This is ${STATES[state].toLowerCase()}.`);
      const keep = String(b.keep ?? '');
      if (keep !== pa && keep !== pb) throw new HttpError(400, 'KEEP_REQUIRED', 'Choose the record to keep.');
      const drop = keep === pa ? pb : pa;
      const nk = nhiOf(store, keep);
      const nd = nhiOf(store, drop);
      if (nk && nd) throw new HttpError(409, 'TWO_NHIS', 'Both records have an NHI, and they differ. SHIFT cannot merge them; the NHI duplicate has to be resolved first (RR-DUP-001).');
      if (nd && !nk) throw new HttpError(409, 'KEEP_NHI', 'Keep the record with the NHI. The other record merges into it.');
      if (store.get<Row>('SELECT merged_into FROM person WHERE id = ?', keep)?.merged_into || store.get<Row>('SELECT merged_into FROM person WHERE id = ?', drop)?.merged_into) {
        throw new HttpError(409, 'ALREADY_MERGED', 'One of these records has already been merged into another.');
      }
      const both = store.get<{ s: string }>(`SELECT s.name AS s FROM encounter x JOIN encounter y ON y.service_id = x.service_id AND y.state = 'ACTIVE' JOIN service s ON s.id = x.service_id
        WHERE x.person_id = ? AND y.person_id = ? AND x.state = 'ACTIVE'`, keep, drop);
      if (both) throw new HttpError(409, 'BOTH_ACTIVE', `Both records are open in ${both.s} at the same time. End one of those stays before merging.`);
      const keptName = side(store, keep).name;
      const dropped = side(store, drop);
      store.tx(() => {
        const moved = moveAll(store, drop, keep, FIXED);
        // Identifiers the kept record lacks (such as a local number) move with it.
        const ids = store.all<{ id: string }>('SELECT id FROM external_identifier WHERE person_id = ? AND system NOT IN (SELECT system FROM external_identifier WHERE person_id = ?)', drop, keep).map((x) => x.id);
        for (const x of ids) store.run('UPDATE external_identifier SET person_id = ? WHERE id = ?', keep, x);
        store.run('UPDATE person SET merged_into = ? WHERE id = ?', keep, drop);
        // Downstream correction: every other service whose entries moved checks them.
        const services = new Set<string>();
        for (const [table, rows] of Object.entries(moved)) {
          if (!store.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === 'service_id')) continue;
          for (const x of rows) {
            const s = store.get<{ s: string }>(`SELECT service_id AS s FROM ${table} WHERE rowid = ?`, x)?.s;
            if (s) services.add(s);
          }
        }
        const tasks: string[] = [];
        for (const s of services) {
          if (s === ctx.serviceId) continue;
          const t = newId();
          store.insert('task', {
            id: t, person_id: keep, source_event_id: null, service_id: s, assigned_to: null, state: 'CREATED', created_by: ctx.workerId, created_at: at, due_at: null,
            description: `Records merged: ${dropped.name}${dropped.dob ? ` (born ${dropped.dob})` : ''} is now part of ${keptName}'s record. Check your service's entries that moved across.`,
          });
          recordInitial(store, 'task', t, 'CREATED', who, 'Duplicate records merged');
          tasks.push(t);
        }
        const dupAllergies = store.all<{ s: string }>("SELECT substance AS s FROM allergy WHERE person_id = ? AND state = 'ACTIVE' AND substance IS NOT NULL GROUP BY lower(substance) HAVING count(*) > 1", keep).map((x) => x.s);
        const dupMeds = store.all<{ s: string }>("SELECT medicine AS s FROM medication WHERE person_id = ? AND state = 'ACTIVE' GROUP BY lower(medicine) HAVING count(*) > 1", keep).map((x) => x.s);
        const nka = store.get("SELECT 1 FROM allergy WHERE person_id = ? AND state = 'ACTIVE' AND kind = 'NO_KNOWN_ALLERGIES'", keep) && store.get("SELECT 1 FROM allergy WHERE person_id = ? AND state = 'ACTIVE' AND kind != 'NO_KNOWN_ALLERGIES'", keep);
        transition(store, 'duplicate_case', id, 'RECONCILED', who, `Kept ${keptName}`.slice(0, 200));
        store.run('UPDATE duplicate_case SET kept_id = ?, merged_id = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, manifest = ?, undone_by = NULL, undone_at = NULL, undone_note = NULL WHERE id = ?',
          keep, drop, ctx.workerId, at, note || null, JSON.stringify({ moved, ids, tasks }), id);
        log(store, id, 'MERGED', `${label(dropped)} merged into ${label(side(store, keep))}: ${counted(moved)} entries moved${ids.length ? ` with ${ids.length} identifier${ids.length > 1 ? 's' : ''}` : ''}. The merged record is kept, marked as merged.${note ? ` ${note}` : ''}`, ctx.workerId);
        const checks = [
          dupAllergies.length ? `the same allergy is recorded twice (${dupAllergies.join(', ')})` : null,
          nka ? '"No known allergies" is recorded alongside an allergy' : null,
          dupMeds.length ? `the same medicine is active twice (${dupMeds.join(', ')})` : null,
          tasks.length ? `${tasks.length} other service${tasks.length > 1 ? 's have' : ' has'} a task to check their entries` : null,
        ].filter(Boolean);
        log(store, id, 'CHECK', checks.length ? `Check: ${checks.join('; ')}.` : 'Nothing conflicting found. No other service had entries on the merged record.', ctx.workerId);
        logged(store, ctx, 'DUPLICATE_MERGE', keep, id, `${drop} into ${keep}`);
      });
      result = keep;
      break;
    }
    case 'undo': {
      if (state !== 'RECONCILED') throw new HttpError(409, 'WRONG_STATE', `This is ${STATES[state].toLowerCase()}.`);
      need(10, 'Say why the merge was wrong, e.g. "Two different people: GP confirmed different addresses".');
      const m = JSON.parse(String(r.manifest)) as { moved: Record<string, number[]>; ids: string[]; tasks: string[] };
      const keep = String(r.keptId);
      const drop = String(r.mergedId);
      store.tx(() => {
        moveBack(store, m.moved, drop);
        for (const x of m.ids) store.run('UPDATE external_identifier SET person_id = ? WHERE id = ?', drop, x);
        store.run('UPDATE person SET merged_into = NULL WHERE id = ?', drop);
        let cancelled = 0;
        for (const t of m.tasks) {
          if (store.get("SELECT 1 FROM task WHERE id = ? AND state IN ('CREATED', 'ASSIGNED')", t)) {
            transition(store, 'task', t, 'CANCELLED', who, 'Duplicate merge undone');
            cancelled++;
          }
        }
        transition(store, 'duplicate_case', id, 'POSSIBLE', who, note.slice(0, 200));
        store.run('UPDATE duplicate_case SET kept_id = NULL, merged_id = NULL, manifest = NULL, undone_by = ?, undone_at = ?, undone_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, id, 'UNDONE', `${counted(m.moved)} entries moved back to the separate record.${cancelled ? ` ${cancelled} follow-up task${cancelled > 1 ? 's' : ''} cancelled.` : ''} ${note}`, ctx.workerId);
        logged(store, ctx, 'DUPLICATE_UNMERGE', keep, id, note.slice(0, 200));
      });
      result = viewFrom === keep ? keep : viewFrom;
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return { personId: result, ...forPerson(store, ctx, result) };
}

// Duplicate cases about this person, for their Identity view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  detect(store, ctx);
  const cases = store.all<Row>(`${Q} WHERE d.person_a = ? OR d.person_b = ? ORDER BY d.detected_at DESC`, personId, personId).map((r) => shape(store, ctx, r));
  return { cases, canFlag: canFlag(ctx), canResolve: canResolve(ctx) };
}

// For the record header: an open possible duplicate.
export function current(store: Store, personId: string) {
  return store.get<Row>("SELECT id FROM duplicate_case WHERE state = 'POSSIBLE' AND (person_a = ? OR person_b = ?) LIMIT 1", personId, personId) ?? null;
}

// Home → Duplicates: possible duplicates involving anyone this service has cared for, and recent decisions.
export function list(store: Store, ctx: WorkContext) {
  if (!canResolve(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not decide duplicates`);
  detect(store, ctx);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ours = `(SELECT person_id FROM encounter WHERE service_id = ? UNION SELECT person_id FROM care_relationship WHERE service_id = ?)`;
  const rows = store.all<Row>(`${Q} WHERE (d.person_a IN ${ours} OR d.person_b IN ${ours})
      AND (d.state = 'POSSIBLE' OR d.reviewed_at >= ? OR d.undone_at >= ?) ORDER BY d.detected_at DESC`,
  ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId, since, since).map((r) => ({ ...shape(store, ctx, r), actions: [] }));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_DUPLICATES', decision: 'ALLOW', outcome: 'VIEWED' });
  return { possible: rows.filter((x) => x.state === 'POSSIBLE'), decided: rows.filter((x) => x.state !== 'POSSIBLE') };
}
