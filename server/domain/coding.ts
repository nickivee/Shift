import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Clinical coding / classification (Shared Lifecycle Object 255):
//   source clinical information → coding requirement → code assignment → validation →
//   finalised coding → amendment where appropriate.
// A hospital episode needs coding when it ends. A coder reads what was recorded in that episode
// (and nothing else of the person's record), assigns codes that each point back to where they
// came from, asks the treating service when the record is unclear, and finalises once the checks
// pass. Finalised coding can be reopened with a reason; nothing is overwritten. Codes are checked
// for form only until the official code tables and reporting rules are known (RR-CODE-001).

type Row = Record<string, string | number | null>;
const SYSTEMS: Record<string, string> = { ICD10AM: 'ICD-10-AM diagnosis', ACHI: 'ACHI procedure', SNOMEDCT: 'SNOMED CT' };
const ROLES: Record<string, string> = { PRINCIPAL: 'Principal diagnosis', ADDITIONAL: 'Additional diagnosis', PROCEDURE: 'Procedure' };
const STATES: Record<string, string> = { REQUIRED: 'To code', IN_PROGRESS: 'Being coded', FINALISED: 'Finalised' };
const FORM: Record<string, [RegExp, string]> = {
  ICD10AM: [/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,2})?$/, 'a letter, two digits, then an optional point and one or two characters, e.g. A00.0'],
  ACHI: [/^[0-9]{5}-[0-9]{2}$/, 'five digits, a dash and two digits, e.g. 00000-00'],
  SNOMEDCT: [/^[1-9][0-9]{5,17}$/, 'a number of 6 to 18 digits'],
};
const FORM_ONLY = 'Codes are checked for form only. Checking them against the official code tables is still being researched (RR-CODE-001).';
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-CODE-001'];

const CASE = `
  SELECT c.id, c.state, c.encounter_id AS encounterId, c.person_id AS personId, c.service_id AS serviceId, s.name AS service,
         c.organisation_id AS organisationId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT value FROM external_identifier WHERE person_id = c.person_id AND system = 'NHI') AS nhi,
         e.location, e.kind AS encounterKind, e.started_at AS startedAt, e.ended_at AS endedAt,
         c.required_at AS requiredAt, c.required_reason AS requiredReason, cw.display_name AS coder, c.coder_id AS coderId, c.started_at AS codingStartedAt,
         fb.display_name AS finalisedBy, c.finalised_at AS finalisedAt, c.amendments,
         (SELECT COUNT(*) FROM coding_entry WHERE case_id = c.id AND state = 'ACTIVE') AS codes,
         (SELECT COUNT(*) FROM coding_query WHERE case_id = c.id AND state = 'OPEN') AS openQueries
    FROM coding_case c
    JOIN person p ON p.id = c.person_id
    JOIN service s ON s.id = c.service_id
    JOIN encounter e ON e.id = c.encounter_id
    LEFT JOIN workforce_person cw ON cw.id = c.coder_id
    LEFT JOIN workforce_person fb ON fb.id = c.finalised_by`;

const ENTRY = `
  SELECT x.id, x.state, x.system, x.code, x.term, x.role, x.source_event_id AS sourceEventId, x.source_note AS sourceNote,
         (SELECT rendered_text FROM clinical_event WHERE id = x.source_event_id) AS sourceText,
         ab.display_name AS addedBy, x.added_at AS addedAt, rb.display_name AS removedBy, x.removed_at AS removedAt, x.removed_reason AS removedReason
    FROM coding_entry x
    JOIN workforce_person ab ON ab.id = x.added_by
    LEFT JOIN workforce_person rb ON rb.id = x.removed_by`;

const QUERY = `
  SELECT q.id, q.case_id AS caseId, q.state, q.question, q.service_id AS serviceId, ab.display_name AS askedBy, q.asked_at AS askedAt,
         q.answer, nb.display_name AS answeredBy, q.answered_at AS answeredAt
    FROM coding_query q
    JOIN workforce_person ab ON ab.id = q.asked_by
    LEFT JOIN workforce_person nb ON nb.id = q.answered_by`;

// An entry belongs to an episode when it was recorded against it, or (for entries without an
// episode) when it was recorded by that service for that person during the stay.
const IN_EPISODE = `ev.state = 'CURRENT' AND (ev.encounter_id = ? OR (ev.encounter_id IS NULL AND EXISTS (
  SELECT 1 FROM encounter e WHERE e.id = ? AND e.person_id = ev.person_id AND e.service_id = ev.service_id
     AND ev.effective_at >= e.started_at AND ev.effective_at <= COALESCE(e.ended_at, ev.effective_at))))`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const options = () => ({ systems: SYSTEMS, roles: ROLES });
const isCoder = (ctx: WorkContext) => ctx.role.capabilities.includes('coding.assign');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, type: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: type, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

// A hospital episode needs coding once it ends. Called where an encounter ends.
export function requireCoding(store: Store, encounterId: string, reason: string, actor: { actorId: string; workContextId: string | null }) {
  const e = store.get<Row>(
    `SELECT e.id, e.person_id AS personId, e.service_id AS serviceId, s.organisation_id AS organisationId FROM encounter e
       JOIN service s ON s.id = e.service_id JOIN organisation o ON o.id = s.organisation_id
      WHERE e.id = ? AND o.kind = 'HOSPITAL'`, encounterId);
  if (!e || store.get('SELECT 1 FROM coding_case WHERE encounter_id = ?', encounterId)) return;
  const id = newId();
  store.insert('coding_case', {
    id, encounter_id: encounterId, person_id: e.personId, service_id: e.serviceId, organisation_id: e.organisationId,
    state: 'REQUIRED', required_at: now(), required_reason: reason,
  });
  recordInitial(store, 'coding', id, 'REQUIRED', actor, reason);
}

function validate(store: Store, id: string) {
  const entries = store.all<Row>("SELECT system, code, role FROM coding_entry WHERE case_id = ? AND state = 'ACTIVE'", id);
  const problems: string[] = [];
  const principal = entries.filter((e) => e.role === 'PRINCIPAL');
  if (principal.length !== 1) problems.push('Choose one principal diagnosis.');
  for (const e of entries) {
    const [re, form] = FORM[String(e.system)];
    if (!re.test(String(e.code))) problems.push(`${e.code} is not in the form of ${SYSTEMS[String(e.system)]} (${form}).`);
  }
  const open = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM coding_query WHERE case_id = ? AND state = 'OPEN'", id)?.n ?? 0;
  if (open) problems.push(open === 1 ? 'A question to the treating service is still open.' : `${open} questions to the treating service are still open.`);
  return { ok: problems.length === 0, problems, note: FORM_ONLY };
}

function loadCase(store: Store, ctx: WorkContext, id: string) {
  const c = store.get<Row>(`${CASE} WHERE c.id = ?`, id);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'That coding is no longer in SHIFT.');
  enforce(store, ctx, { op: 'CODING', organisationId: String(c.organisationId) }, String(c.personId));
  return c;
}

const shapeCase = (c: Row) => ({ ...c, stateLabel: STATES[String(c.state)] });
const shapeEntry = (e: Row): Row => ({ ...e, systemLabel: SYSTEMS[String(e.system)], roleLabel: ROLES[String(e.role)] });

// Home → Clinical coding: episodes to code, being coded, and finalised in the last fortnight.
export function list(store: Store, ctx: WorkContext) {
  if (!isCoder(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include clinical coding`);
  const rows = (where: string, ...args: unknown[]) => store.all<Row>(`${CASE} WHERE c.organisation_id = ? AND ${where}`, ctx.organisationId, ...args).map(shapeCase);
  const out = {
    toCode: rows("c.state = 'REQUIRED' ORDER BY e.ended_at"),
    inProgress: rows("c.state = 'IN_PROGRESS' ORDER BY e.ended_at"),
    finalised: rows("c.state = 'FINALISED' AND c.finalised_at >= ? ORDER BY c.finalised_at DESC", new Date(Date.now() - 14 * 24 * 3600_000).toISOString()),
  };
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_CODING_WORKLIST', decision: 'ALLOW', outcome: 'VIEWED' });
  return out;
}

// One episode as the coder sees it: what was recorded in it, the codes, the questions and the checks.
export function getCase(store: Store, ctx: WorkContext, id: string) {
  if (!isCoder(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include clinical coding`);
  const c = loadCase(store, ctx, id);
  const sources = store.all<Row>(
    `SELECT id, category, rendered_text AS text, author_role_label AS author, effective_at AS at FROM clinical_event ev WHERE ${IN_EPISODE} ORDER BY effective_at`,
    String(c.encounterId), String(c.encounterId));
  const discharge = store.get<Row>(
    "SELECT destination, note, discharged_at AS dischargedAt FROM discharge WHERE encounter_id = ? AND state = 'DISCHARGED'", String(c.encounterId)) ?? null;
  const entries = store.all<Row>(`${ENTRY} WHERE x.case_id = ? ORDER BY x.role = 'PRINCIPAL' DESC, x.role = 'PROCEDURE', x.added_at`, id).map(shapeEntry);
  const queries = store.all<Row>(`${QUERY} WHERE q.case_id = ? ORDER BY q.asked_at`, id);
  const actions: string[] = [];
  if (c.state === 'REQUIRED') actions.push('start');
  if (c.state === 'IN_PROGRESS') actions.push('add', 'ask', 'finalise');
  if (c.state === 'FINALISED') actions.push('amend');
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: String(c.personId),
    operation: 'VIEW_CODING_EPISODE', objectType: 'coding_case', objectId: id, decision: 'ALLOW', outcome: 'VIEWED', ruleRefs: REFS,
  });
  return {
    ...shapeCase(c), sources, discharge,
    entries: entries.filter((e) => e.state === 'ACTIVE'), removed: entries.filter((e) => e.state === 'REMOVED'),
    queries, validation: validate(store, id), actions, history: history(store, 'coding', id), options: options(),
  };
}

interface EntryFields { system?: string; code?: string; term?: string; role?: string; sourceEventId?: string; sourceNote?: string }

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: EntryFields & { entryId?: string; queryId?: string; question?: string; note?: string }) {
  if (!isCoder(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include clinical coding`);
  const c = loadCase(store, ctx, id);
  const personId = String(c.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const coding = () => { if (c.state !== 'IN_PROGRESS') throw new HttpError(409, 'WRONG_STATE', c.state === 'FINALISED' ? 'This coding is finalised. Reopen it to change it.' : 'Start coding this episode first.'); };
  switch (action) {
    case 'start': {
      if (c.state !== 'REQUIRED') throw new HttpError(409, 'WRONG_STATE', 'Someone has already started coding this episode.');
      store.tx(() => {
        transition(store, 'coding', id, 'IN_PROGRESS', who, 'Coding started');
        store.run('UPDATE coding_case SET coder_id = ?, started_at = ? WHERE id = ?', ctx.workerId, at, id);
        logged(store, ctx, 'CODING_START', personId, 'coding_case', id);
      });
      break;
    }
    case 'add': {
      coding();
      const system = SYSTEMS[String(b.system)] ? String(b.system) : '';
      if (!system) throw new HttpError(400, 'SYSTEM_REQUIRED', 'Choose the classification.');
      const role = ROLES[String(b.role)] ? String(b.role) : '';
      if (!role) throw new HttpError(400, 'ROLE_REQUIRED', 'Choose what the code is for.');
      if (role === 'PROCEDURE' && system !== 'ACHI') throw new HttpError(400, 'ROLE_SYSTEM', 'Procedures are coded in ACHI.');
      if (role !== 'PROCEDURE' && system === 'ACHI') throw new HttpError(400, 'ROLE_SYSTEM', 'ACHI codes are for procedures.');
      if (role === 'PRINCIPAL' && system !== 'ICD10AM') throw new HttpError(400, 'ROLE_SYSTEM', 'The principal diagnosis is coded in ICD-10-AM.');
      const code = text(b.code, 20).toUpperCase().replace(/\s/g, '');
      const [re, form] = FORM[system];
      if (!re.test(code)) throw new HttpError(400, 'CODE_FORM', `That is not in the form of ${SYSTEMS[system]}: ${form}.`);
      const term = text(b.term, 200);
      if (term.length < 3) throw new HttpError(400, 'TERM_REQUIRED', 'Write the term the code stands for.');
      const eventId = text(b.sourceEventId, 64);
      const sourceNote = text(b.sourceNote, 300);
      if (eventId && !store.get(`SELECT 1 FROM clinical_event ev WHERE id = ? AND ${IN_EPISODE}`, eventId, String(c.encounterId), String(c.encounterId))) {
        throw new HttpError(400, 'SOURCE_NOT_IN_EPISODE', 'That entry is not part of this episode.');
      }
      if (!eventId && sourceNote.length < 5) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose the entry it comes from, or write where in the record it comes from.');
      if (role === 'PRINCIPAL' && store.get("SELECT 1 FROM coding_entry WHERE case_id = ? AND role = 'PRINCIPAL' AND state = 'ACTIVE'", id)) {
        throw new HttpError(409, 'PRINCIPAL_EXISTS', 'There is already a principal diagnosis. Remove it first if this one replaces it.');
      }
      if (store.get("SELECT 1 FROM coding_entry WHERE case_id = ? AND system = ? AND code = ? AND state = 'ACTIVE'", id, system, code)) {
        throw new HttpError(409, 'DUPLICATE', 'That code is already on this episode.');
      }
      const eid = newId();
      store.tx(() => {
        store.insert('coding_entry', {
          id: eid, case_id: id, system, code, term, role, source_event_id: eventId || null, source_note: sourceNote || null, state: 'ACTIVE', added_by: ctx.workerId, added_at: at,
        });
        logged(store, ctx, 'CODING_ASSIGN', personId, 'coding_entry', eid, `${code} ${term}`);
      });
      break;
    }
    case 'remove': {
      coding();
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the code is removed.');
      const e = store.get<Row>("SELECT id, code FROM coding_entry WHERE id = ? AND case_id = ? AND state = 'ACTIVE'", text(b.entryId, 64), id);
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'That code is not on this episode.');
      store.tx(() => {
        store.run("UPDATE coding_entry SET state = 'REMOVED', removed_by = ?, removed_at = ?, removed_reason = ? WHERE id = ?", ctx.workerId, at, note, e.id);
        logged(store, ctx, 'CODING_REMOVE', personId, 'coding_entry', String(e.id), note);
      });
      break;
    }
    case 'ask': {
      coding();
      const question = text(b.question, 1000);
      if (question.length < 10) throw new HttpError(400, 'QUESTION_REQUIRED', 'Write the question for the treating service.');
      const qid = newId();
      store.tx(() => {
        store.insert('coding_query', { id: qid, case_id: id, service_id: c.serviceId, question, state: 'OPEN', asked_by: ctx.workerId, asked_at: at });
        recordInitial(store, 'codingquery', qid, 'OPEN', who, question);
        logged(store, ctx, 'CODING_QUERY', personId, 'coding_query', qid, question);
      });
      break;
    }
    case 'withdraw': {
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the question is withdrawn.');
      const q = store.get<Row>("SELECT id FROM coding_query WHERE id = ? AND case_id = ? AND state = 'OPEN'", text(b.queryId, 64), id);
      if (!q) throw new HttpError(404, 'NOT_FOUND', 'That question is no longer open.');
      store.tx(() => {
        transition(store, 'codingquery', String(q.id), 'WITHDRAWN', who, note);
        store.run('UPDATE coding_query SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?', `Withdrawn: ${note}`, ctx.workerId, at, q.id);
        logged(store, ctx, 'CODING_QUERY_WITHDRAW', personId, 'coding_query', String(q.id), note);
      });
      break;
    }
    case 'finalise': {
      coding();
      const v = validate(store, id);
      if (!v.ok) throw new HttpError(409, 'NOT_VALID', `Not ready to finalise: ${v.problems.join(' ')}`);
      store.tx(() => {
        transition(store, 'coding', id, 'FINALISED', who, 'Coding finalised');
        store.run('UPDATE coding_case SET finalised_by = ?, finalised_at = ? WHERE id = ?', ctx.workerId, at, id);
        logged(store, ctx, 'CODING_FINALISE', personId, 'coding_case', id);
      });
      break;
    }
    case 'amend': {
      if (c.state !== 'FINALISED') throw new HttpError(409, 'WRONG_STATE', 'Only finalised coding can be reopened.');
      const note = text(b.note);
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why the coding is being reopened.');
      store.tx(() => {
        transition(store, 'coding', id, 'IN_PROGRESS', who, `Reopened: ${note}`);
        store.run('UPDATE coding_case SET amendments = amendments + 1, coder_id = ?, finalised_by = NULL, finalised_at = NULL WHERE id = ?', ctx.workerId, id);
        logged(store, ctx, 'CODING_AMEND', personId, 'coding_case', id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return getCase(store, ctx, id);
}

// Home → Coding questions: what coders have asked this service about its episodes.
export function queries(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('coding.answer')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include coding questions`);
  const rows = (where: string, ...args: unknown[]) => store.all<Row>(
    `${QUERY.replace('FROM coding_query q', `, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, e.started_at AS startedAt, e.ended_at AS endedAt, e.location
      FROM coding_query q JOIN coding_case c ON c.id = q.case_id JOIN person p ON p.id = c.person_id JOIN encounter e ON e.id = c.encounter_id`)}
      WHERE q.service_id = ? AND ${where}`, ctx.serviceId, ...args);
  const withCodes = (q: Row) => ({ ...q, codes: store.all<Row>("SELECT code, term, role FROM coding_entry WHERE case_id = ? AND state = 'ACTIVE' ORDER BY role = 'PRINCIPAL' DESC", String(q.caseId)).map(shapeEntry) });
  return {
    open: rows("q.state = 'OPEN' ORDER BY q.asked_at").map(withCodes),
    answered: rows("q.state = 'ANSWERED' AND q.answered_at >= ? ORDER BY q.answered_at DESC", new Date(Date.now() - 7 * 24 * 3600_000).toISOString()).map(withCodes),
  };
}

export function answer(store: Store, ctx: WorkContext, queryId: string, b: { answer?: string }) {
  const q = store.get<Row>("SELECT q.id, q.service_id AS serviceId, q.state, c.person_id AS personId FROM coding_query q JOIN coding_case c ON c.id = q.case_id WHERE q.id = ?", queryId);
  if (!q) throw new HttpError(404, 'NOT_FOUND', 'That question is no longer in SHIFT.');
  enforce(store, ctx, { op: 'CODING_ANSWER', serviceId: String(q.serviceId) }, String(q.personId));
  if (q.state !== 'OPEN') throw new HttpError(409, 'WRONG_STATE', 'This question has already been answered or withdrawn.');
  const a = text(b.answer, 1000);
  if (a.length < 3) throw new HttpError(400, 'ANSWER_REQUIRED', 'Write your answer.');
  store.tx(() => {
    transition(store, 'codingquery', queryId, 'ANSWERED', { actorId: ctx.workerId, workContextId: ctx.id }, a);
    store.run('UPDATE coding_query SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?', a, ctx.workerId, now(), queryId);
    logged(store, ctx, 'CODING_QUERY_ANSWER', String(q.personId), 'coding_query', queryId, a);
  });
  return { ok: true };
}

// The person's Coding view in the Live Workstation: how each hospital episode was coded, and
// any open questions for this service.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const cases = store.all<Row>(`${CASE} WHERE c.person_id = ? AND c.organisation_id = ? ORDER BY e.ended_at DESC`, personId, ctx.organisationId).map((c) => ({
    ...shapeCase(c),
    entries: store.all<Row>(`${ENTRY} WHERE x.case_id = ? AND x.state = 'ACTIVE' ORDER BY x.role = 'PRINCIPAL' DESC, x.role = 'PROCEDURE'`, String(c.id)).map(shapeEntry),
    queries: store.all<Row>(`${QUERY} WHERE q.case_id = ? ORDER BY q.asked_at`, String(c.id)),
  }));
  const canAnswer = evaluate(store, ctx, { op: 'CODING_ANSWER', serviceId: ctx.serviceId }).decision === 'ALLOW';
  return { cases, canAnswer, serviceId: ctx.serviceId, note: FORM_ONLY };
}
