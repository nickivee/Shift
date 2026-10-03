import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, SOURCE, FINDING, REFS } from '../config/privacyreview.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Privacy access review (entries 32, 33):
//   a record's access is looked at (raised by a concern, a flag on the list below, or a routine check)
//   → notes on what staff said → finding (appropriate / not / could not tell) → closed with what was done.
// The list "worth a look" shows records opened by a service with no care link to the person on file.
// That is a fact SHIFT can see, not a finding: it can have good reasons, and only a person decides.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const mayManage = (ctx: WorkContext) => (ctx.role.capabilities as string[]).includes('privacy.manage');
const WINDOW_DAYS = 30;

const NO_LINK = (svc: string, person: string) => `
  NOT EXISTS (SELECT 1 FROM encounter x WHERE x.person_id = ${person} AND x.service_id = ${svc})
  AND NOT EXISTS (SELECT 1 FROM care_relationship x WHERE x.person_id = ${person} AND x.service_id = ${svc})
  AND NOT EXISTS (SELECT 1 FROM transfer x WHERE x.person_id = ${person} AND (x.from_service_id = ${svc} OR x.to_service_id = ${svc}))
  AND NOT EXISTS (SELECT 1 FROM consultation x WHERE x.person_id = ${person} AND (x.from_service_id = ${svc} OR x.to_service_id = ${svc}))
  AND NOT EXISTS (SELECT 1 FROM referral x WHERE x.person_id = ${person} AND (x.from_service_id = ${svc} OR x.to_service_id = ${svc}))`;

// Who opened a record, grouped by person and service, with whether a care link is on file.
const VIEWERS = `
  SELECT w.display_name AS name, a.actor_id AS actorId, COALESCE(po.title, 'Unknown role') AS role, s.name AS service,
         COUNT(*) AS opened, MIN(a.at) AS first, MAX(a.at) AS last,
         CASE WHEN ${NO_LINK('wc.service_id', 'a.subject_person_id')} AND NOT EXISTS (
           SELECT 1 FROM exceptional_access e WHERE e.person_id = a.subject_person_id AND e.workforce_person_id = a.actor_id) THEN 1 ELSE 0 END AS noLink
    FROM audit_event a
    JOIN workforce_person w ON w.id = a.actor_id
    JOIN work_context wc ON wc.id = a.work_context_id
    JOIN service s ON s.id = wc.service_id
    LEFT JOIN position po ON po.id = wc.position_id`;

const Q = `
  SELECT r.id, r.state, r.person_id AS personId, p.given_name || ' ' || p.family_name AS person,
         (SELECT value FROM external_identifier WHERE person_id = r.person_id AND system = 'NHI') AS nhi,
         r.source, r.why, ob.display_name AS openedBy, r.opened_at AS openedAt,
         r.finding, r.finding_note AS findingNote, fb.display_name AS foundBy, r.found_at AS foundAt,
         r.outcome_note AS outcomeNote, cb.display_name AS closedBy, r.closed_at AS closedAt
    FROM privacy_review r JOIN person p ON p.id = r.person_id
    JOIN workforce_person ob ON ob.id = r.opened_by
    LEFT JOIN workforce_person fb ON fb.id = r.found_by
    LEFT JOIN workforce_person cb ON cb.id = r.closed_by`;

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'privacy_review', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
function gate(ctx: WorkContext) {
  if (!mayManage(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include privacy reviews`);
}

const shape = (store: Store, r: Row): Record<string, any> => ({
  ...r, stateLabel: STATES[String(r.state)], sourceLabel: SOURCE[String(r.source)], findingLabel: r.finding ? FINDING[String(r.finding)] : null,
  actions: r.state === 'OPEN' ? ['note', 'finding'] : r.state === 'FINDING' ? ['close'] : [],
  viewers: store.all<Row>(`${VIEWERS} WHERE a.subject_person_id = ? AND a.outcome = 'VIEWED' AND a.space = 'WORK' GROUP BY a.actor_id, wc.service_id ORDER BY noLink DESC, last DESC`, String(r.personId)),
  steps: store.all<Row>('SELECT s.body, w.display_name AS "by", s.at FROM privacy_review_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.review_id = ? ORDER BY s.at, s.rowid', String(r.id)),
});

export function list(store: Store, ctx: WorkContext) {
  gate(ctx);
  enforce(store, ctx, { op: 'PRIVACY', organisationId: ctx.organisationId });
  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 3600_000).toISOString();
  const reviews = (w: string, ...a: unknown[]) => store.all<Row>(`${Q} WHERE r.organisation_id = ? AND ${w}`, ctx.organisationId, ...a).map((r) => shape(store, r));
  const flagged = store.all<Row>(`
    SELECT * FROM (${VIEWERS.replace('SELECT w.display_name', "SELECT a.subject_person_id AS personId, (SELECT given_name || ' ' || family_name FROM person WHERE id = a.subject_person_id) AS person, (SELECT value FROM external_identifier WHERE person_id = a.subject_person_id AND system = 'NHI') AS nhi, w.display_name")}
      WHERE a.operation = 'VIEW_RECORD' AND a.outcome = 'VIEWED' AND a.space = 'WORK' AND a.at >= ? AND a.actor_id <> ?
        AND NOT EXISTS (SELECT 1 FROM privacy_review pr WHERE pr.person_id = a.subject_person_id AND pr.opened_at >= ?)
      GROUP BY a.subject_person_id, a.actor_id, wc.service_id) WHERE noLink = 1 ORDER BY last DESC LIMIT 20`, windowStart, ctx.workerId, windowStart);
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_PRIVACY_REVIEWS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    flagged, windowDays: WINDOW_DAYS,
    open: reviews("r.state = 'OPEN' ORDER BY r.opened_at"),
    toClose: reviews("r.state = 'FINDING' ORDER BY r.found_at"),
    closed: reviews("r.state = 'CLOSED' AND r.closed_at >= ? ORDER BY r.closed_at DESC", since),
    options: { source: SOURCE, finding: FINDING },
  };
}

export function open(store: Store, ctx: WorkContext, b: { nhi?: string; source?: string; why?: string }) {
  gate(ctx);
  enforce(store, ctx, { op: 'PRIVACY', organisationId: ctx.organisationId });
  const nhi = text(b.nhi, 20).toUpperCase().replace(/\s/g, '');
  if (!nhi) throw new HttpError(400, 'NHI_REQUIRED', 'Write the NHI of the person whose record is being looked at.');
  const person = store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi);
  if (!person) throw new HttpError(404, 'NOT_FOUND', 'No one in SHIFT has that NHI. Check it.');
  const source = SOURCE[String(b.source)] ? String(b.source) : '';
  if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose what started this.');
  const why = text(b.why);
  if (why.length < 5) throw new HttpError(400, 'WHY_REQUIRED', 'Say what you are looking into, e.g. "The person says a neighbour who works here knew about her visit".');
  if (store.get("SELECT 1 FROM privacy_review WHERE person_id = ? AND state <> 'CLOSED'", person.id)) throw new HttpError(409, 'ALREADY', 'A review of this record is already open.');
  const id = newId();
  store.tx(() => {
    store.insert('privacy_review', { id, organisation_id: ctx.organisationId, person_id: person.id, state: 'OPEN', source, why, opened_by: ctx.workerId, opened_at: now() });
    recordInitial(store, 'privacy_review', id, 'OPEN', { actorId: ctx.workerId, workContextId: ctx.id }, why);
    logged(store, ctx, 'PRIVACY_REVIEW_OPEN', person.id, id, `${SOURCE[source]}: ${why}`);
  });
  return list(store, ctx);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; finding?: string }) {
  gate(ctx);
  const r = store.get<Row>('SELECT id, person_id AS personId, organisation_id AS org, state FROM privacy_review WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That review is no longer in SHIFT.');
  enforce(store, ctx, { op: 'PRIVACY', organisationId: String(r.org) });
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  store.tx(() => {
    if (action === 'note') {
      if (r.state !== 'OPEN') throw new HttpError(409, 'WRONG_STATE', 'This review has already reached a finding.');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you did or what you were told, e.g. "Spoke to Kate; she was covering for a colleague".');
      store.insert('privacy_review_step', { id: newId(), review_id: id, body: note, by_id: ctx.workerId, at: now() });
      logged(store, ctx, 'PRIVACY_REVIEW_NOTE', personId, id, note);
    } else if (action === 'finding') {
      if (r.state !== 'OPEN') throw new HttpError(409, 'WRONG_STATE', 'This review has already reached a finding.');
      const finding = FINDING[String(b.finding)] ? String(b.finding) : '';
      if (!finding) throw new HttpError(400, 'FINDING_REQUIRED', 'Choose what you found.');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what the finding is based on.');
      transition(store, 'privacy_review', id, 'FINDING', who, `${FINDING[finding]}: ${note.slice(0, 140)}`);
      store.run('UPDATE privacy_review SET finding = ?, finding_note = ?, found_by = ?, found_at = ? WHERE id = ?', finding, note, ctx.workerId, now(), id);
      logged(store, ctx, 'PRIVACY_REVIEW_FINDING', personId, id, `${FINDING[finding]}: ${note}`);
    } else if (action === 'close') {
      if (r.state !== 'FINDING') throw new HttpError(409, 'WRONG_STATE', 'Record a finding first.');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what was done, and who was told, e.g. "Talked with the staff member and her manager; no further action".');
      transition(store, 'privacy_review', id, 'CLOSED', who, note.slice(0, 160));
      store.run('UPDATE privacy_review SET outcome_note = ?, closed_by = ?, closed_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
      logged(store, ctx, 'PRIVACY_REVIEW_CLOSE', personId, id, note);
    } else throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  });
  return list(store, ctx);
}
