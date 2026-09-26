import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Patient preference (Shared Lifecycle Object 249):
//   preference expressed → context / source → current relevance → acknowledged →
//   incorporated where possible → reviewed / changed / withdrawn.
// A preference belongs to the person, so every service caring for them sees it. It is kept in
// the person's words, with who said it. A preference is not consent and not an advance
// directive; those are a research requirement (RR-ADVDIR-001). A change never overwrites:
// the old preference is superseded and the new one points back to it.

type Row = Record<string, string | number | null>;
export const CATEGORIES: Record<string, string> = {
  NAME: 'What to call them', ROUTINE: 'Daily routine', PERSONAL_CARE: 'Personal care', FOOD: 'Food and drink',
  CULTURAL: 'Cultural', SPIRITUAL: 'Spiritual or religious', COMMUNICATION: 'Communication', PRIVACY: 'Privacy and visitors',
  TREATMENT: 'Care and treatment', OTHER: 'Other',
};
const SOURCES: Record<string, string> = {
  PERSON: 'The person themselves', WHANAU: 'Whānau or family', SUPPORT_PERSON: 'Support person or advocate',
  OBSERVED: 'Seen by staff', DOCUMENT: 'From a document',
};
const RELEVANCE: Record<string, string> = { ALWAYS: 'Always', THIS_STAY: 'For this stay', SOMETIMES: 'In some situations' };
const OUTCOMES: Record<string, string> = { MET: 'Followed', PARTLY: 'Partly followed', NOT_MET: 'Could not be followed' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-005'];

const SELECT = `
  SELECT f.id, f.state, f.category, f.statement, f.source, f.source_name AS sourceName, f.context, f.relevance,
         f.review_date AS reviewDate, f.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = f.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         s.name AS service, rb.display_name AS recordedBy, f.recorded_at AS recordedAt, f.supersedes_id AS supersedesId,
         cb.display_name AS closedBy, f.closed_at AS closedAt, f.close_reason AS closeReason
    FROM preference f
    JOIN person p ON p.id = f.person_id
    JOIN service s ON s.id = f.service_id
    JOIN workforce_person rb ON rb.id = f.recorded_by
    LEFT JOIN workforce_person cb ON cb.id = f.closed_by`;

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'PREFERENCE', personId }).decision === 'ALLOW';

function shape(store: Store, ctx: WorkContext, r: Row) {
  const id = String(r.id);
  const acks = store.all<{ by: string; at: string; workerId: string }>(
    `SELECT w.display_name AS by, a.at, a.worker_id AS workerId FROM preference_ack a JOIN workforce_person w ON w.id = a.worker_id
      WHERE a.preference_id = ? ORDER BY a.at`, id,
  );
  const outcomes = store.all<Row>(
    `SELECT o.outcome, o.note, o.at, w.display_name AS by FROM preference_outcome o JOIN workforce_person w ON w.id = o.by_id
      WHERE o.preference_id = ? ORDER BY o.at DESC LIMIT 5`, id,
  );
  const active = r.state === 'ACTIVE';
  const record = active && may(store, ctx, String(r.personId));
  const read = acks.some((a) => a.workerId === ctx.workerId);
  const actions: string[] = [];
  if (active && !read && ctx.role.capabilities.includes('record.view')) actions.push('read');
  if (record) actions.push('outcome', 'change', 'withdraw');
  return {
    ...r, categoryLabel: CATEGORIES[String(r.category)] ?? String(r.category), sourceLabel: SOURCES[String(r.source)],
    relevanceLabel: RELEVANCE[String(r.relevance)], reviewDue: active && !!r.reviewDate && String(r.reviewDate) <= todayLocal(),
    acks: acks.map(({ by, at }) => ({ by, at })), read,
    outcomes: outcomes.map((o) => ({ ...o, outcomeLabel: OUTCOMES[String(o.outcome)] })),
    actions, history: history(store, 'preference', id),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'preference', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const options = () => ({ categories: CATEGORIES, sources: SOURCES, relevance: RELEVANCE, outcomes: OUTCOMES });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const open = store.all<Row>(`${SELECT} WHERE f.person_id = ? AND f.state = 'ACTIVE' ORDER BY f.category, f.recorded_at`, personId);
  const past = store.all<Row>(`${SELECT} WHERE f.person_id = ? AND f.state <> 'ACTIVE' ORDER BY f.closed_at DESC LIMIT 15`, personId);
  return { preferences: open.map((r) => shape(store, ctx, r)), past: past.map((r) => shape(store, ctx, r)), canRecord: may(store, ctx, personId), options: options() };
}

// For the record header: what to call them, and how many preferences there are.
export function current(store: Store, personId: string) {
  const rows = store.all<{ category: string; statement: string }>(
    "SELECT category, statement FROM preference WHERE person_id = ? AND state = 'ACTIVE' ORDER BY category = 'NAME' DESC, recorded_at", personId,
  );
  return rows.length ? { count: rows.length, first: rows.slice(0, 2).map((r) => r.statement) } : null;
}

interface Fields { category?: string; statement?: string; source?: string; sourceName?: string; context?: string; relevance?: string; reviewDate?: string }

function clean(b: Fields) {
  const category = String(b.category);
  if (!CATEGORIES[category]) throw new HttpError(400, 'CATEGORY_REQUIRED', 'Choose what the preference is about.');
  const statement = (b.statement ?? '').trim().slice(0, 500);
  if (statement.length < 3) throw new HttpError(400, 'STATEMENT_REQUIRED', 'Write the preference, in their words where you can.');
  const source = SOURCES[String(b.source)] ? String(b.source) : '';
  if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Say who expressed it.');
  const sourceName = (b.sourceName ?? '').trim().slice(0, 200);
  if (['WHANAU', 'SUPPORT_PERSON', 'DOCUMENT'].includes(source) && sourceName.length < 2) {
    throw new HttpError(400, 'SOURCE_NAME_REQUIRED', source === 'DOCUMENT' ? 'Name the document.' : 'Write who told you.');
  }
  return {
    category, statement, source, source_name: sourceName || null, context: (b.context ?? '').trim().slice(0, 500) || null,
    relevance: RELEVANCE[String(b.relevance)] ? String(b.relevance) : 'ALWAYS',
    review_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null,
  };
}

export function record(store: Store, ctx: WorkContext, personId: string, b: Fields) {
  enforce(store, ctx, { op: 'PREFERENCE', personId }, personId);
  const v = clean(b);
  const id = newId();
  store.tx(() => {
    store.insert('preference', { id, person_id: personId, service_id: ctx.serviceId, ...v, state: 'ACTIVE', recorded_by: ctx.workerId, recorded_at: now() });
    recordInitial(store, 'preference', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, v.statement);
    store.insert('preference_ack', { preference_id: id, worker_id: ctx.workerId, at: now() });
    logged(store, ctx, 'PREFERENCE_RECORD', personId, id, v.statement);
  });
  return { id };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${SELECT} WHERE f.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That preference no longer exists.');
  return r;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Fields & { note?: string; outcome?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  if (r.state !== 'ACTIVE') throw new HttpError(409, 'NOT_ACTIVE', 'This preference has been changed or withdrawn.');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = (b.note ?? '').trim().slice(0, 1000);
  let result = id;
  switch (action) {
    case 'read': {
      enforce(store, ctx, { op: 'VIEW_RECORD', personId }, personId);
      store.run('INSERT OR IGNORE INTO preference_ack (preference_id, worker_id, at) VALUES (?, ?, ?)', id, ctx.workerId, now());
      logged(store, ctx, 'PREFERENCE_READ', personId, id);
      break;
    }
    case 'outcome': {
      enforce(store, ctx, { op: 'PREFERENCE', personId }, personId);
      const outcome = String(b.outcome);
      if (!OUTCOMES[outcome]) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose whether it was followed.');
      if (outcome !== 'MET' && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why, and what the person was told.');
      store.tx(() => {
        store.insert('preference_outcome', { id: newId(), preference_id: id, outcome, note: note || null, by_id: ctx.workerId, at: now() });
        store.run('INSERT OR IGNORE INTO preference_ack (preference_id, worker_id, at) VALUES (?, ?, ?)', id, ctx.workerId, now());
        logged(store, ctx, `PREFERENCE_${outcome}`, personId, id, note || undefined);
      });
      break;
    }
    case 'change': {
      enforce(store, ctx, { op: 'PREFERENCE', personId }, personId);
      const v = clean({ ...b, category: b.category || String(r.category) });
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what changed and who said so.');
      result = newId();
      store.tx(() => {
        transition(store, 'preference', id, 'SUPERSEDED', who, note);
        store.run('UPDATE preference SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
        store.insert('preference', { id: result, person_id: personId, service_id: ctx.serviceId, ...v, state: 'ACTIVE', recorded_by: ctx.workerId, recorded_at: now(), supersedes_id: id });
        recordInitial(store, 'preference', result, 'ACTIVE', who, `Changed: ${v.statement}`);
        store.insert('preference_ack', { preference_id: result, worker_id: ctx.workerId, at: now() });
        logged(store, ctx, 'PREFERENCE_CHANGE', personId, id, note);
      });
      break;
    }
    case 'withdraw': {
      enforce(store, ctx, { op: 'PREFERENCE', personId }, personId);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it no longer applies and who said so.');
      store.tx(() => {
        transition(store, 'preference', id, 'WITHDRAWN', who, note);
        store.run('UPDATE preference SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
        logged(store, ctx, 'PREFERENCE_WITHDRAW', personId, id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do with a preference.');
  }
  return shape(store, ctx, load(store, result));
}

// Home → Preferences: preferences of everyone this service is caring for that this worker has
// not yet read, and ones due for review.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('preference.record')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include preferences`);
  }
  const rows = store.all<Row>(
    `${SELECT} WHERE f.state = 'ACTIVE' AND (f.person_id IN (SELECT person_id FROM encounter WHERE service_id = ? AND state = 'ACTIVE')
       OR f.person_id IN (SELECT person_id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL))
     ORDER BY patient, f.category, f.recorded_at`, ctx.serviceId, ctx.serviceId,
  ).map((r) => shape(store, ctx, r));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_PREFERENCES', decision: 'ALLOW', outcome: 'VIEWED' });
  return { preferences: rows, options: options() };
}
