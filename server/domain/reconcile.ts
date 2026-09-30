import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, revise } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';
import { FACT_KINDS, DIFFERENCES, DECISIONS, CERTAINTY, REFS, allowed } from '../config/reconcile.ts';

// Data reconciliation: incoming data → matching → comparison → conflict/duplicate detection →
// authorised reconciliation → canonical linkage/state → provenance retained.
// Once information from another provider is matched to a person, what it lists is compared with
// their record. Each difference needs a clinician's decision before the information can be signed
// off as reviewed. Allergies can be added or changed here, each linked back to where it came from;
// medicines are never changed here, a prescriber is asked instead. Decisions keep what both sides
// said at the time, so the comparison can be read later even after the record has moved on.

type Row = Record<string, string | number | null>;
interface Fact { id: string; kind: string; name: string | null; detail: string | null; severity: string | null; transcribedBy: string | null; transcribedAt: string | null }
interface Ours { id: string; kind: string; name: string | null; detail: string | null; severity: string | null; state: string }

const text = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);
const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Medicines are matched on their first word (the active ingredient as usually written), so a
// different strength or combination still shows as a difference rather than slipping past.
const keyOf = (kind: string, name: string | null) => (kind === 'MEDICINE' ? `MEDICINE:${norm(name).split(' ')[0]}` : kind === 'NO_KNOWN_ALLERGIES' ? 'NKA' : `ALLERGY:${norm(name)}`);
const say = (kind: string, name: string | null, detail: string | null, severity: string | null, state?: string) =>
  kind === 'NO_KNOWN_ALLERGIES' ? 'No known allergies'
    : [name, detail, severity ? severity.toLowerCase() : null].filter(Boolean).join(', ') + (state === 'HELD' ? ' (held)' : '');

export const mayReconcile = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'RECONCILE', personId }).decision === 'ALLOW';

function facts(store: Store, externalId: string): Fact[] {
  return store.all<Fact>(
    `SELECT f.id, f.kind, f.name, f.detail, f.severity, w.display_name AS transcribedBy, f.transcribed_at AS transcribedAt
       FROM external_fact f LEFT JOIN workforce_person w ON w.id = f.transcribed_by WHERE f.external_id = ? ORDER BY f.kind, f.name`, externalId);
}

function ours(store: Store, personId: string) {
  const allergies = store.all<Ours>(
    "SELECT id, kind, substance AS name, reaction AS detail, severity, state FROM allergy WHERE person_id = ? AND state = 'ACTIVE'", personId);
  const medicines = store.all<Ours>(
    `SELECT id, 'MEDICINE' AS kind, medicine AS name, trim(COALESCE(dose, '') || ' ' || COALESCE(frequency, '')) AS detail, NULL AS severity, state
       FROM medication WHERE person_id = ? AND state IN ('ORDERED', 'VERIFIED', 'ACTIVE', 'HELD')`, personId);
  return { allergies, medicines };
}

// Compare what they list with what this record holds now.
function compare(store: Store, x: Row, list: Fact[]) {
  const personId = String(x.personId);
  const { allergies, medicines } = ours(store, personId);
  const nka = allergies.find((a) => a.kind === 'NO_KNOWN_ALLERGIES');
  const reactions = allergies.filter((a) => a.kind !== 'NO_KNOWN_ALLERGIES');
  const out: { key: string; kind: string; difference: string; theirs: string | null; ours: string | null; fact: Fact | null; record: Ours | null }[] = [];
  const seen = new Set<string>();
  for (const f of list) {
    const key = keyOf(f.kind, f.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const theirs = say(f.kind, f.name, f.detail, f.severity);
    if (f.kind === 'NO_KNOWN_ALLERGIES') {
      out.push(reactions.length
        ? { key, kind: f.kind, difference: 'CONFLICT', theirs, ours: reactions.map((a) => say(a.kind, a.name, a.detail, a.severity)).join('; '), fact: f, record: null }
        : { key, kind: f.kind, difference: nka ? 'SAME' : 'NEW', theirs, ours: nka ? 'No known allergies' : null, fact: f, record: nka ?? null });
      continue;
    }
    const pool = f.kind === 'MEDICINE' ? medicines : reactions;
    const match = pool.find((o) => keyOf(f.kind, o.name) === key);
    if (!match) {
      out.push({ key, kind: f.kind, difference: f.kind === 'ALLERGY' && nka ? 'CONFLICT' : 'NEW', theirs, ours: f.kind === 'ALLERGY' && nka ? 'No known allergies' : null, fact: f, record: f.kind === 'ALLERGY' ? nka ?? null : null });
      continue;
    }
    const same = f.kind === 'MEDICINE'
      ? norm(`${f.name} ${f.detail}`) === norm(`${match.name} ${match.detail}`) && match.state !== 'HELD'
      : (!f.detail || !match.detail || norm(f.detail) === norm(match.detail)) && (!f.severity || !match.severity || norm(f.severity) === norm(match.severity));
    out.push({ key, kind: f.kind, difference: same ? 'SAME' : 'DIFFERENT', theirs, ours: say(match.kind === 'MEDICINE' ? 'MEDICINE' : 'ALLERGY', match.name, match.detail, match.severity, match.state), fact: f, record: match });
  }
  // A full medicines list from the sender also shows what we have that they do not.
  if (x.kind === 'MEDICINES' && list.some((f) => f.kind === 'MEDICINE')) {
    for (const m of medicines) {
      const key = keyOf('MEDICINE', m.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, kind: 'MEDICINE', difference: 'OURS_ONLY', theirs: null, ours: say('MEDICINE', m.name, m.detail, null, m.state), fact: null, record: m });
    }
  }
  if (list.some((f) => f.kind === 'ALLERGY' || f.kind === 'NO_KNOWN_ALLERGIES')) {
    for (const a of reactions) {
      const key = keyOf('ALLERGY', a.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, kind: 'ALLERGY', difference: 'OURS_ONLY', theirs: null, ours: say(a.kind, a.name, a.detail, a.severity), fact: null, record: a });
    }
  }
  return out;
}

function decisions(store: Store, externalId: string) {
  return store.all<Row>(
    `SELECT r.id, r.item_key AS key, r.kind, r.difference, r.theirs, r.ours, r.decision, r.note, r.task_id AS taskId, r.record_type AS recordType,
            w.display_name AS decidedBy, r.decided_at AS decidedAt
       FROM reconciliation r JOIN workforce_person w ON w.id = r.decided_by WHERE r.external_id = ? ORDER BY r.decided_at`, externalId);
}

// The comparison as the card shows it. While the information is waiting for review it is compared
// live; afterwards only the decisions (with what both sides said then) are shown.
export function comparison(store: Store, ctx: WorkContext, x: Row) {
  if (!x.personId) return null;
  const list = facts(store, String(x.id));
  const done = decisions(store, String(x.id));
  const byKey = new Map(done.map((d) => [String(d.key), d]));
  const shapeDecision = (d: Row) => ({
    ...d, kindLabel: FACT_KINDS[String(d.kind)], differenceLabel: DIFFERENCES[String(d.difference)], decisionLabel: DECISIONS[String(d.decision)],
  });
  if (x.state !== 'MATCHED') {
    return done.length || list.length ? { live: false, items: done.map((d) => ({ ...shapeDecision(d), decided: true })), open: 0, facts: list.length, canReconcile: false, options: null } : null;
  }
  const can = mayReconcile(store, ctx, String(x.personId));
  const items = compare(store, x, list).map((c) => {
    const d = byKey.get(c.key);
    if (d) return { ...shapeDecision(d), decided: true };
    return {
      key: c.key, kind: c.kind, kindLabel: FACT_KINDS[c.kind], difference: c.difference, differenceLabel: DIFFERENCES[c.difference],
      theirs: c.theirs, ours: c.ours, decided: false,
      factId: c.fact?.id ?? null, transcribedBy: c.fact?.transcribedBy ?? null,
      choices: c.difference === 'SAME' ? [] : allowed(c.kind, c.difference).map((k) => [k, DECISIONS[k]]),
    };
  });
  // Decisions whose item no longer shows (e.g. an allergy added makes it the same) stay listed.
  for (const d of done) if (!items.some((i) => i.key === d.key)) items.push({ ...shapeDecision(d), decided: true });
  const open = items.filter((i) => !i.decided && i.difference !== 'SAME').length;
  return { live: true, items, open, facts: list.length, canReconcile: can, options: { kinds: FACT_KINDS, certainty: CERTAINTY } };
}

// Open differences still to decide: review cannot be signed off until there are none.
export function openDifferences(store: Store, ctx: WorkContext, x: Row) {
  return comparison(store, ctx, x)?.open ?? 0;
}

function load(store: Store, ctx: WorkContext, id: string) {
  const x = store.get<Row>(
    `SELECT id, state, person_id AS personId, service_id AS serviceId, source_org AS sourceOrg, source_kind AS kind, title, written_at AS writtenAt
       FROM external_info WHERE id = ?`, id);
  if (!x) throw new HttpError(404, 'NOT_FOUND', 'That information is no longer in SHIFT.');
  if (!x.personId) throw new HttpError(409, 'NOT_MATCHED', 'Match it to someone first.');
  if (x.state !== 'MATCHED') throw new HttpError(409, 'WRONG_STATE', 'This has already been reviewed. Differences can only be reconciled while it is waiting for review.');
  enforce(store, ctx, { op: 'RECONCILE', personId: String(x.personId) }, String(x.personId));
  return x;
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, objectType: string, objectId: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType, objectId, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}

// Write down what a paper, fax or letter lists, so it can be compared. Marked as transcribed.
export function addFact(store: Store, ctx: WorkContext, id: string, b: { kind?: string; name?: string; detail?: string; severity?: string }) {
  const x = load(store, ctx, id);
  const kind = FACT_KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what it lists: an allergy, no known allergies, or a medicine.');
  const name = kind === 'NO_KNOWN_ALLERGIES' ? null : text(b.name, 120);
  if (kind !== 'NO_KNOWN_ALLERGIES' && (name ?? '').length < 2) throw new HttpError(400, 'NAME_REQUIRED', kind === 'MEDICINE' ? 'Write the medicine exactly as it is written, e.g. "Donepezil".' : 'Write what they are allergic to, e.g. "Penicillin".');
  const key = keyOf(kind, name);
  if (facts(store, id).some((f) => keyOf(f.kind, f.name) === key)) throw new HttpError(409, 'ALREADY_LISTED', 'That is already listed from this information.');
  const fid = newId();
  store.tx(() => {
    store.insert('external_fact', {
      id: fid, external_id: id, kind, name, detail: kind === 'NO_KNOWN_ALLERGIES' ? null : text(b.detail, 120) || null,
      severity: kind === 'ALLERGY' ? text(b.severity, 40) || null : null, transcribed_by: ctx.workerId, transcribed_at: now(),
    });
    logged(store, ctx, 'RECONCILE_TRANSCRIBE', String(x.personId), 'external_fact', fid, `${FACT_KINDS[kind]}: ${name ?? 'none'}`);
  });
}

// A transcription mistake can be taken out, but only before anyone has decided on it.
export function removeFact(store: Store, ctx: WorkContext, id: string, factId: string) {
  const x = load(store, ctx, id);
  const f = store.get<{ kind: string; name: string | null; transcribed_by: string | null }>('SELECT kind, name, transcribed_by FROM external_fact WHERE id = ? AND external_id = ?', factId, id);
  if (!f) throw new HttpError(404, 'NOT_FOUND', 'That line is no longer listed.');
  if (!f.transcribed_by) throw new HttpError(409, 'AS_RECEIVED', 'This came in the message itself and cannot be taken out.');
  if (store.get('SELECT 1 FROM reconciliation WHERE external_id = ? AND item_key = ?', id, keyOf(f.kind, f.name))) throw new HttpError(409, 'DECIDED', 'This has already been decided, so it stays.');
  store.tx(() => {
    store.run('DELETE FROM external_fact WHERE id = ?', factId);
    logged(store, ctx, 'RECONCILE_UNTRANSCRIBE', String(x.personId), 'external_fact', factId, `${FACT_KINDS[f.kind]}: ${f.name ?? 'none'}`);
  });
}

// Decide one difference.
export function decide(store: Store, ctx: WorkContext, id: string, b: { key?: string; decision?: string; note?: string; certainty?: string }) {
  const x = load(store, ctx, id);
  const personId = String(x.personId);
  const key = text(b.key, 200);
  const item = compare(store, x, facts(store, id)).find((c) => c.key === key);
  if (!item) throw new HttpError(404, 'NOT_FOUND', 'That difference is no longer listed. Reload and look again.');
  if (item.difference === 'SAME') throw new HttpError(409, 'SAME', 'This already matches the record. There is nothing to decide.');
  if (store.get('SELECT 1 FROM reconciliation WHERE external_id = ? AND item_key = ?', id, key)) throw new HttpError(409, 'DECIDED', 'This difference has already been decided.');
  const decision = String(b.decision ?? '');
  if (!allowed(item.kind, item.difference).includes(decision)) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose what to do about this difference.');
  const note = text(b.note, 500);
  if ((decision === 'KEEP_OURS' || decision === 'NO_CHANGE') && note.length < 5) {
    throw new HttpError(400, 'NOTE_REQUIRED', decision === 'KEEP_OURS' ? 'Write why our record stays as it is, e.g. "Checked with Wiremu: he has taken aspirin since without a problem".' : 'Write why no change is needed, e.g. "Held on admission; the GP will be told in the discharge letter".');
  }
  const certainty = decision === 'ADD' && item.kind === 'ALLERGY' ? (CERTAINTY[String(b.certainty)] ? String(b.certainty) : '') : null;
  if (certainty === '') throw new HttpError(400, 'CERTAINTY_REQUIRED', 'Say whether the allergy has been confirmed with the person or their whānau.');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const rid = newId();
  const from = `${x.sourceOrg}, ${String(x.title)}`;
  let recordType: string | null = null;
  let recordId: string | null = null;
  let taskId: string | null = null;
  store.tx(() => {
    store.insert('reconciliation', {
      id: rid, external_id: id, person_id: personId, item_key: key, kind: item.kind, difference: item.difference, theirs: item.theirs, ours: item.ours,
      decision, note: note || null, record_type: null, record_id: null, task_id: null, decided_by: ctx.workerId, decided_at: at,
    });
    if (decision === 'ADD') {
      recordType = 'allergy';
      recordId = newId();
      const f = item.fact!;
      store.insert('allergy', {
        id: recordId, person_id: personId, kind: item.kind === 'NO_KNOWN_ALLERGIES' ? 'NO_KNOWN_ALLERGIES' : 'ALLERGY', substance: f.name, reaction: f.detail, severity: f.severity,
        certainty, state: 'ACTIVE', source: `From ${from}`, recorded_by: ctx.workerId, recorded_at: at, data_source: 'SHIFT', reconciliation_id: rid,
      });
      recordInitial(store, 'allergy', recordId, 'ACTIVE', who, `Reconciled from ${from}`);
      // An allergy now recorded means "no known allergies" is no longer true.
      if (item.kind === 'ALLERGY' && item.record?.kind === 'NO_KNOWN_ALLERGIES') {
        transition(store, 'allergy', item.record.id, 'INACTIVE', who, `${f.name} allergy added from ${from}`);
      }
    }
    if (decision === 'UPDATE' && item.record) {
      recordType = 'allergy';
      recordId = item.record.id;
      const f = item.fact!;
      const before = { reaction: item.record.detail, severity: item.record.severity };
      const after = { reaction: f.detail ?? item.record.detail, severity: f.severity ?? item.record.severity };
      revise(store, 'allergy', recordId, before, after, { reaction: 'Reaction', severity: 'Severity' }, who, `Reconciled from ${from}`);
      store.run('UPDATE allergy SET reaction = ?, severity = ? WHERE id = ?', after.reaction, after.severity, recordId);
    }
    if (decision === 'PRESCRIBER') {
      taskId = newId();
      const what = item.difference === 'NEW' ? `lists ${item.theirs}, which is not on our chart`
        : item.difference === 'OURS_ONLY' ? `does not list ${item.ours}, which is on our chart`
          : `lists ${item.theirs}; our chart has ${item.ours}`;
      store.insert('task', {
        id: taskId, person_id: personId, source_event_id: null, service_id: ctx.serviceId, assigned_to: null, state: 'CREATED', created_by: ctx.workerId, created_at: at, due_at: null,
        description: `Medicines reconciliation: ${x.sourceOrg} ${what}. A prescriber needs to decide.${note ? ` ${note}` : ''}`.slice(0, 500),
      });
      recordInitial(store, 'task', taskId, 'CREATED', who, 'Medicine difference found when reconciling');
    }
    if (recordType || taskId) store.run('UPDATE reconciliation SET record_type = ?, record_id = ?, task_id = ? WHERE id = ?', recordType, recordId, taskId, rid);
    logged(store, ctx, `RECONCILE_${decision}`, personId, 'reconciliation', rid, `${FACT_KINDS[item.kind]}: ${item.theirs ?? item.ours}`);
  });
}
