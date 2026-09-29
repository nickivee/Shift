import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, sha256, HttpError } from '../lib/util.ts';
import { comparison, openDifferences } from './reconcile.ts';

// External / imported clinical information (Shared Lifecycle Object 254):
//   external information received → patient matching → source identified → integrity/provenance
//   retained → authorised availability → clinical review → incorporated or referenced where
//   appropriate → amendment/update from the source where applicable.
// What arrives is kept exactly as received, with its SHA-256, and is never edited. It reaches a
// record only once two identifiers agree. Until then it sits in the service's inbox, seen by no
// record. A newer version from the source replaces it as current; the earlier one is kept.
// Information that is not about this service's people is held, not returned or destroyed, until
// what the law requires is known (RR-IMPORT-001).

type Row = Record<string, string | number | null>;
const KINDS: Record<string, string> = {
  DISCHARGE_SUMMARY: 'Discharge summary', GP_LETTER: 'GP letter', SPECIALIST_LETTER: 'Specialist letter', RESULT: 'Result from another lab',
  MEDICINES: 'Medicines list', AMBULANCE: 'Ambulance record', CARE_PLAN: 'Care plan', OTHER: 'Other',
};
const CHANNELS: Record<string, string> = { ELECTRONIC: 'Electronic message', EMAIL: 'Email', FAX: 'Fax', POST: 'Post', HAND: 'Handed in' };
const STATES: Record<string, string> = {
  RECEIVED: 'Not matched', MATCHED: 'To review', INCORPORATED: 'Acted on', REFERENCED: 'Kept for reference', NOT_OURS: 'Not ours', SUPERSEDED: 'Replaced by a newer version',
};
const CHECKS: Record<string, string> = { NHI: 'NHI', DOB: 'date of birth', NAME: 'name' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002'];

const ITEM = `
  SELECT x.id, x.state, x.service_id AS serviceId, s.name AS service, x.person_id AS personId,
         CASE WHEN x.person_id IS NULL THEN NULL ELSE p.given_name || ' ' || p.family_name END AS patient,
         x.source_org AS sourceOrg, x.source_author AS sourceAuthor, x.source_kind AS kind, x.channel, x.written_at AS writtenAt,
         x.title, x.content, x.content_hash AS contentHash, x.stated_name AS statedName, x.stated_nhi AS statedNhi, x.stated_dob AS statedDob,
         rb.display_name AS receivedBy, x.received_at AS receivedAt, mb.display_name AS matchedBy, x.matched_at AS matchedAt, x.match_checks AS matchChecks,
         vb.display_name AS reviewedBy, x.reviewed_at AS reviewedAt, x.review_summary AS reviewSummary, x.outcome_note AS outcomeNote,
         nb.display_name AS notOursBy, x.not_ours_at AS notOursAt, x.not_ours_reason AS notOursReason, x.supersedes, x.superseded_by AS supersededBy
    FROM external_info x
    JOIN service s ON s.id = x.service_id
    LEFT JOIN person p ON p.id = x.person_id
    JOIN workforce_person rb ON rb.id = x.received_by
    LEFT JOIN workforce_person mb ON mb.id = x.matched_by
    LEFT JOIN workforce_person vb ON vb.id = x.reviewed_by
    LEFT JOIN workforce_person nb ON nb.id = x.not_ours_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'EXTERNAL', personId }).decision === 'ALLOW';
const canReceive = (ctx: WorkContext) => ctx.role.capabilities.includes('external.manage');
const options = () => ({ kinds: KINDS, channels: CHANNELS });

function logged(store: Store, ctx: WorkContext, operation: string, personId: string | null, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'external_info', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

// Which of the identifiers the sender gave agree with the person in SHIFT, and which disagree.
function compare(store: Store, personId: string, r: { statedNhi?: unknown; statedDob?: unknown; statedName?: unknown }) {
  const p = store.get<Row>('SELECT given_name, family_name, preferred_name, date_of_birth FROM person WHERE id = ?', personId);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'That person is not in SHIFT.');
  const nhi = store.get<{ v: string }>("SELECT value AS v FROM external_identifier WHERE person_id = ? AND system = 'NHI'", personId)?.v ?? null;
  const agree: string[] = [];
  const differ: string[] = [];
  if (r.statedNhi) (r.statedNhi === nhi ? agree : differ).push('NHI');
  if (r.statedDob) (r.statedDob === p.date_of_birth ? agree : differ).push('DOB');
  const name = String(r.statedName ?? '').toLowerCase();
  const family = String(p.family_name).toLowerCase();
  const given = [p.given_name, p.preferred_name].filter(Boolean).map((g) => String(g).toLowerCase());
  if (name.includes(family) && given.some((g) => name.includes(g))) agree.push('NAME');
  else differ.push('NAME');
  return { agree, differ, name: `${p.given_name} ${p.family_name}`, nhi, dob: p.date_of_birth };
}

// The people this service cares for whom an item might be about, best match first.
function candidates(store: Store, ctx: WorkContext, r: Row) {
  const people = store.all<{ id: string }>(
    `SELECT DISTINCT person_id AS id FROM encounter WHERE service_id = ? AND state = 'ACTIVE'
      UNION SELECT DISTINCT person_id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL`, ctx.serviceId, ctx.serviceId);
  return people.map((p) => ({ personId: p.id, ...compare(store, p.id, r) }))
    .filter((c) => c.agree.length > 0)
    .sort((a, b) => b.agree.length - a.agree.length || a.differ.length - b.differ.length)
    .slice(0, 4)
    .map((c) => ({ ...c, agreeLabel: c.agree.map((k) => CHECKS[k]).join(', '), differLabel: c.differ.map((k) => CHECKS[k]).join(', '), enough: c.agree.length >= 2 && !c.differ.includes('NHI') }));
}

function shape(store: Store, ctx: WorkContext, r: Row, manage: boolean) {
  const actions: string[] = [];
  if (manage && r.state === 'RECEIVED') actions.push('match', 'notOurs');
  if (manage && r.state === 'MATCHED') actions.push('review', 'update');
  if (manage && (r.state === 'INCORPORATED' || r.state === 'REFERENCED')) actions.push('update');
  return {
    ...r, kindLabel: KINDS[String(r.kind)], channelLabel: CHANNELS[String(r.channel)], stateLabel: STATES[String(r.state)],
    intact: sha256(String(r.content)) === r.contentHash, hashShort: String(r.contentHash).slice(0, 12),
    matchLabel: r.matchChecks ? String(r.matchChecks).split(',').map((k) => CHECKS[k] ?? k).join(', ') : null,
    candidates: r.state === 'RECEIVED' && manage ? candidates(store, ctx, r) : [],
    actions, history: history(store, 'external', String(r.id)),
    reconcile: comparison(store, ctx, r),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${ITEM} WHERE x.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That information is no longer in SHIFT.');
  return r;
};

interface Received {
  sourceOrg?: string; sourceAuthor?: string; kind?: string; channel?: string; writtenAt?: string; title?: string; content?: string;
  statedName?: string; statedNhi?: string; statedDob?: string;
}
function clean(b: Received) {
  const sourceOrg = text(b.sourceOrg, 200);
  if (sourceOrg.length < 2) throw new HttpError(400, 'SOURCE_REQUIRED', 'Write who sent it, e.g. "Te Awa Hospital, Ward 3".');
  const title = text(b.title, 200);
  if (title.length < 3) throw new HttpError(400, 'TITLE_REQUIRED', 'Give it a title, e.g. "Discharge summary, 12 September".');
  const content = String(b.content ?? '').trim().slice(0, 20000);
  if (content.length < 10) throw new HttpError(400, 'CONTENT_REQUIRED', 'Paste or type what was received, exactly as it came.');
  const statedName = text(b.statedName, 200);
  if (statedName.length < 3) throw new HttpError(400, 'NAME_REQUIRED', 'Write the name exactly as the sender gave it.');
  const statedNhi = text(b.statedNhi, 10).toUpperCase().replace(/\s/g, '');
  if (statedNhi && !/^[A-Z]{3}[0-9]{2}[0-9A-Z]{2}$/.test(statedNhi)) throw new HttpError(400, 'NHI_FORMAT', 'That NHI is not in the right form (three letters then four characters).');
  const statedDob = /^\d{4}-\d{2}-\d{2}$/.test(String(b.statedDob)) ? String(b.statedDob) : '';
  if (!statedNhi && !statedDob) throw new HttpError(400, 'IDENTIFIER_REQUIRED', 'Write the NHI or the date of birth the sender gave. A name alone cannot be matched.');
  return {
    source_org: sourceOrg, source_author: text(b.sourceAuthor, 200) || null, source_kind: KINDS[String(b.kind)] ? String(b.kind) : 'OTHER',
    channel: CHANNELS[String(b.channel)] ? String(b.channel) : 'ELECTRONIC', written_at: /^\d{4}-\d{2}-\d{2}$/.test(String(b.writtenAt)) ? String(b.writtenAt) : null,
    title, content, content_hash: sha256(content), stated_name: statedName, stated_nhi: statedNhi || null, stated_dob: statedDob || null,
  };
}

// Two identifiers must agree, and a stated NHI must never disagree (ORG-SYN-001).
function checkMatch(store: Store, personId: string, r: { statedNhi?: unknown; statedDob?: unknown; statedName?: unknown }) {
  const c = compare(store, personId, r);
  if (c.differ.includes('NHI')) throw new HttpError(409, 'NHI_DIFFERS', `The NHI on it is not ${c.name}'s NHI. Do not match it; if it is not about someone here, mark it not ours.`);
  if (c.agree.length < 2) {
    throw new HttpError(409, 'NOT_ENOUGH', `Only the ${c.agree.map((k) => CHECKS[k]).join(', ') || 'nothing'} agrees with ${c.name}. Two identifiers must agree before it joins a record; ask the sender to confirm.`);
  }
  return c.agree.join(',');
}

// Inbox: information arrives for the service, not yet for anyone.
export function receive(store: Store, ctx: WorkContext, b: Received) {
  if (!canReceive(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include information from other providers`);
  const v = clean(b);
  const id = newId();
  store.tx(() => {
    store.insert('external_info', { id, service_id: ctx.serviceId, ...v, state: 'RECEIVED', received_by: ctx.workerId, received_at: now() });
    recordInitial(store, 'external', id, 'RECEIVED', { actorId: ctx.workerId, workContextId: ctx.id }, `${v.source_org}: ${v.title}`);
    logged(store, ctx, 'EXTERNAL_RECEIVE', null, id, v.title);
  });
  return { id };
}

// From a person's record: received for them and matched in one step, with the same checks.
export function receiveFor(store: Store, ctx: WorkContext, personId: string, b: Received) {
  enforce(store, ctx, { op: 'EXTERNAL', personId }, personId);
  const v = clean(b);
  const checks = checkMatch(store, personId, { statedNhi: v.stated_nhi, statedDob: v.stated_dob, statedName: v.stated_name });
  const id = newId();
  const at = now();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('external_info', {
      id, service_id: ctx.serviceId, ...v, person_id: personId, state: 'RECEIVED', received_by: ctx.workerId, received_at: at,
      matched_by: ctx.workerId, matched_at: at, match_checks: checks,
    });
    recordInitial(store, 'external', id, 'RECEIVED', who, `${v.source_org}: ${v.title}`);
    transition(store, 'external', id, 'MATCHED', who, `Matched on ${checks}`);
    logged(store, ctx, 'EXTERNAL_RECEIVE', personId, id, v.title);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: Received & { personId?: string; summary?: string; outcome?: string; outcomeNote?: string; note?: string }) {
  const r = load(store, id);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const open = (states: string[], msg: string) => { if (!states.includes(String(r.state))) throw new HttpError(409, 'WRONG_STATE', msg); };
  if (r.serviceId !== ctx.serviceId && !r.personId) throw new HttpError(403, 'BLOCK', 'This was sent to another service.');
  switch (action) {
    case 'match': {
      open(['RECEIVED'], 'This has already been matched or set aside.');
      if (!canReceive(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include information from other providers`);
      const personId = text(b.personId, 64);
      if (!personId) throw new HttpError(400, 'PERSON_REQUIRED', 'Choose who it is about.');
      enforce(store, ctx, { op: 'EXTERNAL', personId }, personId);
      const checks = checkMatch(store, personId, r);
      store.tx(() => {
        transition(store, 'external', id, 'MATCHED', who, `Matched on ${checks}`);
        store.run('UPDATE external_info SET person_id = ?, matched_by = ?, matched_at = ?, match_checks = ? WHERE id = ?', personId, ctx.workerId, at, checks, id);
        logged(store, ctx, 'EXTERNAL_MATCH', personId, id, checks);
      });
      return shape(store, ctx, load(store, id), true);
    }
    case 'notOurs': {
      open(['RECEIVED'], 'This has already been matched or set aside.');
      if (!canReceive(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include information from other providers`);
      const note = text(b.note);
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is not about anyone here, e.g. "No one of this name or NHI in our care".');
      store.tx(() => {
        transition(store, 'external', id, 'NOT_OURS', who, note);
        store.run('UPDATE external_info SET not_ours_by = ?, not_ours_at = ?, not_ours_reason = ? WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'EXTERNAL_NOT_OURS', null, id, note);
      });
      return shape(store, ctx, load(store, id), true);
    }
  }
  const personId = String(r.personId ?? '');
  if (!personId) throw new HttpError(409, 'NOT_MATCHED', 'Match it to someone first.');
  enforce(store, ctx, { op: 'EXTERNAL', personId }, personId);
  switch (action) {
    case 'review': {
      open(['MATCHED'], 'This has already been reviewed.');
      const summary = text(b.summary, 1000);
      if (summary.length < 10) throw new HttpError(400, 'SUMMARY_REQUIRED', 'Write what matters in it for their care.');
      const outcome = b.outcome === 'INCORPORATED' ? 'INCORPORATED' : b.outcome === 'REFERENCED' ? 'REFERENCED' : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose whether you acted on it or are keeping it for reference.');
      const note = text(b.outcomeNote, 500);
      if (outcome === 'INCORPORATED' && note.length < 5) throw new HttpError(400, 'ACTION_REQUIRED', 'Write what you changed because of it, e.g. "Medicines chart updated to the new doses".');
      const left = openDifferences(store, ctx, r);
      if (left) throw new HttpError(409, 'NOT_RECONCILED', `${left} difference${left === 1 ? '' : 's'} with the record still to decide. Decide each one under "Compare with the record" first.`);
      store.tx(() => {
        transition(store, 'external', id, outcome, who, summary);
        store.run('UPDATE external_info SET reviewed_by = ?, reviewed_at = ?, review_summary = ?, outcome_note = ? WHERE id = ?', ctx.workerId, at, summary, note || null, id);
        logged(store, ctx, `EXTERNAL_${outcome}`, personId, id, summary);
      });
      break;
    }
    case 'update': {
      open(['MATCHED', 'INCORPORATED', 'REFERENCED'], 'Only the current version can be updated.');
      const v = clean({
        sourceOrg: String(r.sourceOrg), sourceAuthor: b.sourceAuthor || String(r.sourceAuthor ?? ''), kind: String(r.kind), channel: b.channel || String(r.channel),
        writtenAt: b.writtenAt, title: b.title || String(r.title), content: b.content, statedName: String(r.statedName), statedNhi: String(r.statedNhi ?? ''), statedDob: String(r.statedDob ?? ''),
      });
      if (v.content_hash === r.contentHash) throw new HttpError(409, 'UNCHANGED', 'This is the same as the version already here.');
      const nid = newId();
      store.tx(() => {
        store.insert('external_info', {
          id: nid, service_id: ctx.serviceId, ...v, person_id: personId, state: 'RECEIVED', received_by: ctx.workerId, received_at: at,
          matched_by: ctx.workerId, matched_at: at, match_checks: String(r.matchChecks), supersedes: id,
        });
        recordInitial(store, 'external', nid, 'RECEIVED', who, `Newer version from ${v.source_org}`);
        transition(store, 'external', nid, 'MATCHED', who, 'Newer version of information already matched');
        transition(store, 'external', id, 'SUPERSEDED', who, `Replaced by a newer version from ${v.source_org}`);
        store.run('UPDATE external_info SET superseded_by = ? WHERE id = ?', nid, id);
        logged(store, ctx, 'EXTERNAL_UPDATE', personId, nid, v.title);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's "From other providers" view: current versions, each with the earlier ones.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = may(store, ctx, personId);
  const rows = store.all<Row>(`${ITEM} WHERE x.person_id = ? ORDER BY x.received_at DESC`, personId);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const items = rows.filter((r) => r.state !== 'SUPERSEDED').map((r) => {
    const earlier: Row[] = [];
    for (let e = r.supersedes ? byId.get(String(r.supersedes)) : undefined; e; e = e.supersedes ? byId.get(String(e.supersedes)) : undefined) earlier.push(e);
    return { ...shape(store, ctx, r, manage), earlier: earlier.map((e) => shape(store, ctx, e, false)) };
  });
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId, operation: 'VIEW_EXTERNAL', decision: 'ALLOW', outcome: 'VIEWED' });
  return { items, canManage: manage, options: options() };
}

// For the record header: what has come in and still needs a clinician to read it.
export function current(store: Store, personId: string) {
  const rows = store.all<Row>("SELECT title, source_org AS sourceOrg FROM external_info WHERE person_id = ? AND state = 'MATCHED' ORDER BY received_at", personId);
  return rows.length ? rows : null;
}

// Home → From other providers: the service's inbox, what is waiting for review, and what was set aside.
export function list(store: Store, ctx: WorkContext) {
  if (!canReceive(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include information from other providers`);
  const rows = (where: string, ...args: unknown[]) => store.all<Row>(`${ITEM} WHERE x.service_id = ? AND ${where} ORDER BY x.received_at`, ctx.serviceId, ...args)
    .map((r) => shape(store, ctx, r, r.personId ? may(store, ctx, String(r.personId)) : true));
  const week = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const out = {
    inbox: rows("x.state = 'RECEIVED'"),
    toReview: rows("x.state = 'MATCHED'"),
    done: rows("x.state IN ('INCORPORATED', 'REFERENCED') AND x.reviewed_at >= ?", week).reverse(),
    notOurs: rows("x.state = 'NOT_OURS'"),
    options: options(),
  };
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_EXTERNAL_INBOX', decision: 'ALLOW', outcome: 'VIEWED' });
  return out;
}
