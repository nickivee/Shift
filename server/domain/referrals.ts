import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ROLES } from '../config/workstations.ts';
import { addRequest, bookForReferral, cancelForReferral } from './appointments.ts';
import { startFromReferral } from './rehab.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Referral (Shared Lifecycle Object 203):
//   draft → authorised → sent → received → triaged → accepted, declined or redirected →
//   scheduled → seen → service responsibility accepted where applicable → outcome → closed.
// Unlike a consultation, a referral asks another service to take the person on. The
// receiving service reads the record while the referral is with it, and keeps access only
// if it accepts responsibility (a care relationship). Clinical information goes with the
// referral as references to canonical events, never as copies.

type Row = Record<string, string | number | null>;
const OPEN = "('DRAFT', 'AUTHORISED', 'SENT', 'RECEIVED', 'TRIAGED', 'ACCEPTED', 'SCHEDULED', 'SEEN', 'RESPONSIBILITY_ACCEPTED', 'OUTCOME_RECORDED')";
const WITH_RECEIVER = ['SENT', 'RECEIVED', 'TRIAGED', 'ACCEPTED', 'SCHEDULED'];
const PRIORITIES = ['URGENT', 'SEMI_URGENT', 'ROUTINE'];

const SELECT = `
  SELECT r.id, r.state, r.priority, r.reason, r.request, r.patient_aware AS patientAware, r.person_id AS personId, r.parent_id AS parentId,
         p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = r.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         r.from_service_id AS fromServiceId, fs.name AS fromService, r.to_service_id AS toServiceId, ts.name AS toService,
         dr.display_name AS draftedBy, r.drafted_at AS draftedAt, au.display_name AS authorisedBy, r.sent_at AS sentAt,
         rc.display_name AS receivedBy, tr.display_name AS triagedBy, r.triage_priority AS triagePriority, r.triage_note AS triageNote,
         de.display_name AS decidedBy, r.decision_note AS decisionNote, r.scheduled_for AS scheduledFor, sc.display_name AS scheduledBy,
         se.display_name AS seenBy, r.seen_at AS seenAt, r.seen_note AS seenNote, rs.display_name AS responsibilityBy,
         r.outcome, oc.display_name AS outcomeBy, r.outcome_at AS outcomeAt, cl.display_name AS closedBy, r.closed_at AS closedAt,
         (SELECT x.name FROM referral n JOIN service x ON x.id = n.to_service_id WHERE n.parent_id = r.id) AS redirectedTo,
         (SELECT x.name FROM referral n JOIN service x ON x.id = n.to_service_id WHERE n.id = r.parent_id) AS redirectedFrom
    FROM referral r
    JOIN person p ON p.id = r.person_id
    JOIN service fs ON fs.id = r.from_service_id
    JOIN service ts ON ts.id = r.to_service_id
    JOIN workforce_person dr ON dr.id = r.drafted_by
    LEFT JOIN workforce_person au ON au.id = r.authorised_by
    LEFT JOIN workforce_person rc ON rc.id = r.received_by
    LEFT JOIN workforce_person tr ON tr.id = r.triaged_by
    LEFT JOIN workforce_person de ON de.id = r.decided_by
    LEFT JOIN workforce_person sc ON sc.id = r.scheduled_by
    LEFT JOIN workforce_person se ON se.id = r.seen_by
    LEFT JOIN workforce_person rs ON rs.id = r.responsibility_by
    LEFT JOIN workforce_person oc ON oc.id = r.outcome_by
    LEFT JOIN workforce_person cl ON cl.id = r.closed_by`;

// Services this role may refer to: those configured for the role, in this organisation.
// Referring to another organisation is a disclosure (RR-DISC-001) and is not offered.
function targets(store: Store, ctx: WorkContext) {
  const ids = (ctx.role.refersTo ?? []).filter((id) => id !== ctx.serviceId);
  if (!ids.length) return [];
  return store.all<{ id: string; label: string }>(
    `SELECT id, name AS label FROM service WHERE organisation_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`,
    ctx.organisationId, ...ids,
  );
}

// Where a receiving service can redirect a referral: other services in the organisation
// that receive referrals (have a position whose role triages them).
function redirectTargets(store: Store, ctx: WorkContext) {
  const rows = store.all<{ id: string; label: string }>(
    `SELECT DISTINCT s.id, s.name AS label FROM position ps JOIN service s ON s.id = ps.service_id
      WHERE s.organisation_id = ? AND s.id <> ? ORDER BY s.name`, ctx.organisationId, ctx.serviceId,
  );
  return rows.filter((s) => store.all<{ role_key: string }>('SELECT DISTINCT role_key FROM position WHERE service_id = ?', s.id)
    .some((p) => receivesReferrals(p.role_key)));
}
const receivesReferrals = (roleKey: string) => ROLES.some((r) => r.roleKey === roleKey && r.capabilities.includes('referral.triage'));

const receiver = (store: Store, ctx: WorkContext, r: Row) =>
  evaluate(store, ctx, { op: 'REFERRAL_TRIAGE', serviceId: String(r.toServiceId) }).decision === 'ALLOW';
const referrer = (store: Store, ctx: WorkContext, r: Row, cap: 'referral.request' | 'referral.authorise' = 'referral.request') =>
  r.fromServiceId === ctx.serviceId && ctx.role.capabilities.includes(cap)
  && evaluate(store, ctx, { op: 'REFERRAL_REQUEST', personId: String(r.personId), cap }).decision === 'ALLOW';

function evidence(store: Store, id: string) {
  return store.all<{ lineageId: string; category: string; text: string; at: string; author: string | null; amended: number }>(
    `SELECT e.lineage_id AS lineageId, e.category, e.rendered_text AS text, e.effective_at AS at, w.display_name AS author, e.version > 1 AS amended
       FROM referral_evidence x
       JOIN clinical_event e ON e.lineage_id = x.event_lineage_id AND e.state <> 'SUPERSEDED'
       LEFT JOIN workforce_person w ON w.id = e.author_id
      WHERE x.referral_id = ? ORDER BY e.effective_at DESC`, id,
  );
}

function shape(store: Store, ctx: WorkContext, r: Row) {
  const actions: string[] = [];
  const state = String(r.state);
  const recv = receiver(store, ctx, r);
  const ref = referrer(store, ctx, r);
  if (ref && state === 'DRAFT' && referrer(store, ctx, r, 'referral.authorise')) actions.push('authorise');
  if (ref && state === 'AUTHORISED') actions.push('send');
  if (recv && state === 'SENT') actions.push('receive');
  if (recv && state === 'RECEIVED') actions.push('triage');
  if (recv && state === 'TRIAGED') actions.push('accept', 'redirect', 'decline');
  if (recv && (state === 'ACCEPTED' || state === 'SCHEDULED')) actions.push('schedule', 'seen');
  if (recv && state === 'SEEN') actions.push('responsibility', 'outcome');
  if (recv && state === 'RESPONSIBILITY_ACCEPTED') actions.push('outcome');
  if (ref && state === 'OUTCOME_RECORDED') actions.push('close');
  if (ref && ['DRAFT', 'AUTHORISED', ...WITH_RECEIVER].includes(state)) actions.push('cancel');
  const incoming = r.toServiceId === ctx.serviceId;
  // The receiving service opens a referral before reading it, so arrival is recorded.
  const sealed = incoming && state === 'SENT';
  return {
    ...r, patientAware: Boolean(r.patientAware), reason: sealed ? null : r.reason, request: sealed ? null : r.request,
    evidence: sealed ? [] : evidence(store, String(r.id)), sealed, actions, incoming,
    redirectTargets: actions.includes('redirect') ? redirectTargets(store, ctx) : [],
    history: history(store, 'referral', String(r.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'referral', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1', 'LAW-NZ-002'], engines: [13, 42],
  });
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(
    `${SELECT} WHERE r.person_id = ? AND (r.from_service_id = ? OR (r.to_service_id = ? AND r.state <> 'DRAFT' AND r.state <> 'AUTHORISED'))
      ORDER BY CASE WHEN r.state IN ${OPEN} THEN 0 ELSE 1 END, r.drafted_at DESC`,
    personId, ctx.serviceId, ctx.serviceId,
  );
  const allowed = ctx.role.capabilities.includes('referral.request') && evaluate(store, ctx, { op: 'REFERRAL_REQUEST', personId, cap: 'referral.request' }).decision === 'ALLOW';
  const to = allowed ? targets(store, ctx) : [];
  const canAuthorise = to.length > 0 && ctx.role.capabilities.includes('referral.authorise');
  // Recent entries the referrer can attach by reference.
  const events = to.length ? store.all(
    `SELECT e.lineage_id AS lineageId, e.category, e.rendered_text AS text, e.effective_at AS at
       FROM clinical_event e WHERE e.person_id = ? AND e.state = 'CURRENT' ORDER BY e.effective_at DESC LIMIT 15`, personId,
  ) : [];
  return { referrals: rows.map((r) => shape(store, ctx, r)), canRequest: to.length > 0, canAuthorise, targets: to, events };
}

export function create(store: Store, ctx: WorkContext, personId: string, b: {
  to?: string; reason?: string; request?: string; priority?: string; patientAware?: boolean; evidence?: string[]; send?: boolean;
}) {
  enforce(store, ctx, { op: 'REFERRAL_REQUEST', personId, cap: 'referral.request' }, personId);
  const target = targets(store, ctx).find((t) => t.id === b.to);
  if (!target) throw new HttpError(400, 'INVALID_TARGET', 'Choose the service you are referring to.');
  const reason = (b.reason ?? '').trim().slice(0, 2000);
  const request = (b.request ?? '').trim().slice(0, 1000);
  if (reason.length < 10) throw new HttpError(400, 'REASON_REQUIRED', 'Write the clinical reason for the referral.');
  if (request.length < 5) throw new HttpError(400, 'REQUEST_REQUIRED', 'Write what you are asking the service to do.');
  const priority = PRIORITIES.includes(String(b.priority)) ? String(b.priority) : 'ROUTINE';
  if (store.get(`SELECT 1 FROM referral WHERE person_id = ? AND to_service_id = ? AND state IN ${OPEN}`, personId, target.id)) {
    throw new HttpError(409, 'ALREADY_OPEN', `There is already an open referral to ${target.label} for this patient.`);
  }
  if (b.send) enforce(store, ctx, { op: 'REFERRAL_REQUEST', personId, cap: 'referral.authorise' }, personId);
  const lineages = [...new Set((b.evidence ?? []).map(String))].slice(0, 15);
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    for (const l of lineages) {
      if (!store.get("SELECT 1 FROM clinical_event WHERE lineage_id = ? AND person_id = ? AND state = 'CURRENT'", l, personId)) {
        throw new HttpError(400, 'INVALID_EVIDENCE', 'One of the attached entries is not part of this record.');
      }
    }
    store.insert('referral', {
      id, person_id: personId, from_service_id: ctx.serviceId, to_service_id: target.id, reason, request, priority,
      patient_aware: b.patientAware ? 1 : 0, state: 'DRAFT', drafted_by: ctx.workerId, drafted_at: now(),
    });
    for (const l of lineages) store.insert('referral_evidence', { referral_id: id, event_lineage_id: l });
    recordInitial(store, 'referral', id, 'DRAFT', who, `To ${target.label}`);
    logged(store, ctx, 'REFERRAL_DRAFT', personId, id, `To ${target.label}`);
    if (b.send) {
      transition(store, 'referral', id, 'AUTHORISED', who);
      transition(store, 'referral', id, 'SENT', who);
      store.run('UPDATE referral SET authorised_by = ?, sent_at = ? WHERE id = ?', ctx.workerId, now(), id);
      logged(store, ctx, 'REFERRAL_SEND', personId, id, `To ${target.label}`);
    }
  });
  return { id, state: b.send ? 'SENT' : 'DRAFT' };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${SELECT} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That referral no longer exists.');
  return r;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; priority?: string; when?: string; to?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = b.note?.trim().slice(0, 2000) || '';
  const recv = () => enforce(store, ctx, { op: 'REFERRAL_TRIAGE', serviceId: String(r.toServiceId) }, personId);
  const ref = (cap: 'referral.request' | 'referral.authorise' = 'referral.request') => {
    if (r.fromServiceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'Only the referring service can do this.');
    enforce(store, ctx, { op: 'REFERRAL_REQUEST', personId, cap }, personId);
  };
  const need = (min: number, message: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', message); };
  let result: { id: string } = { id };
  store.tx(() => {
    switch (action) {
      case 'authorise':
        ref('referral.authorise');
        transition(store, 'referral', id, 'AUTHORISED', who);
        store.run('UPDATE referral SET authorised_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'send':
        ref();
        transition(store, 'referral', id, 'SENT', who);
        store.run('UPDATE referral SET sent_at = ? WHERE id = ?', now(), id);
        break;
      case 'receive':
        recv();
        transition(store, 'referral', id, 'RECEIVED', who);
        store.run('UPDATE referral SET received_by = ? WHERE id = ?', ctx.workerId, id);
        break;
      case 'triage': {
        recv();
        const priority = String(b.priority ?? '');
        if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'PRIORITY_REQUIRED', 'Choose the triage priority.');
        transition(store, 'referral', id, 'TRIAGED', who, `${priority.replace('_', '-').toLowerCase()}${note ? `: ${note}` : ''}`);
        store.run('UPDATE referral SET triaged_by = ?, triage_priority = ?, triage_note = ? WHERE id = ?', ctx.workerId, priority, note || null, id);
        break;
      }
      case 'accept': {
        recv();
        transition(store, 'referral', id, 'ACCEPTED', who, note || undefined);
        store.run('UPDATE referral SET decided_by = ?, decision_note = ? WHERE id = ?', ctx.workerId, note || null, id);
        // Accepting puts the person on the service's waitlist at the triaged priority.
        const src = store.get<{ request: string; priority: string; triage_priority: string | null }>('SELECT request, priority, triage_priority FROM referral WHERE id = ?', id)!;
        addRequest(store, ctx, personId, String(r.toServiceId), { reason: src.request, priority: src.triage_priority ?? src.priority, referralId: id });
        break;
      }
      case 'decline':
        recv();
        need(5, 'Give the reason for declining, and what the referrer could do instead.');
        transition(store, 'referral', id, 'DECLINED', who, note);
        store.run('UPDATE referral SET decided_by = ?, decision_note = ?, closed_at = ? WHERE id = ?', ctx.workerId, note, now(), id);
        break;
      case 'redirect': {
        recv();
        need(5, 'Say why this referral belongs with another service.');
        const target = redirectTargets(store, ctx).find((t) => t.id === b.to);
        if (!target) throw new HttpError(400, 'INVALID_TARGET', 'Choose the service to redirect to.');
        if (store.get(`SELECT 1 FROM referral WHERE person_id = ? AND to_service_id = ? AND state IN ${OPEN}`, personId, target.id)) {
          throw new HttpError(409, 'ALREADY_OPEN', `${target.label} already has an open referral for this patient.`);
        }
        transition(store, 'referral', id, 'REDIRECTED', who, `To ${target.label}: ${note}`);
        store.run('UPDATE referral SET decided_by = ?, decision_note = ?, closed_at = ? WHERE id = ?', ctx.workerId, note, now(), id);
        // The redirected referral carries the same request and references, arrives at the
        // new service as sent, and stays the referring service's referral.
        const src = store.get<Row>('SELECT * FROM referral WHERE id = ?', id)!;
        const nid = newId();
        store.insert('referral', {
          id: nid, person_id: personId, from_service_id: src.from_service_id, to_service_id: target.id, parent_id: id,
          reason: src.reason, request: src.request, priority: src.priority, patient_aware: src.patient_aware, state: 'SENT',
          drafted_by: src.drafted_by, drafted_at: src.drafted_at, authorised_by: src.authorised_by, sent_at: now(),
        });
        store.run('INSERT INTO referral_evidence (referral_id, event_lineage_id) SELECT ?, event_lineage_id FROM referral_evidence WHERE referral_id = ?', nid, id);
        recordInitial(store, 'referral', nid, 'SENT', who, `Redirected from ${r.toService}: ${note}`);
        result = { id: nid };
        break;
      }
      case 'schedule': {
        recv();
        const when = String(b.when ?? '');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when)) throw new HttpError(400, 'WHEN_REQUIRED', 'Choose the date and time.');
        bookForReferral(store, ctx, id, when);
        transition(store, 'referral', id, 'SCHEDULED', who, when.replace('T', ' '));
        store.run('UPDATE referral SET scheduled_for = ?, scheduled_by = ? WHERE id = ?', when, ctx.workerId, id);
        break;
      }
      case 'seen':
        recv();
        need(3, 'Record how the patient was seen or contacted.');
        transition(store, 'referral', id, 'SEEN', who, note);
        store.run('UPDATE referral SET seen_by = ?, seen_at = ?, seen_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
        break;
      case 'responsibility': {
        recv();
        // Taking the person on is an explicit act; it gives the service a care relationship.
        // If another service still has them admitted, care is shared.
        const admitted = store.get("SELECT 1 FROM encounter WHERE person_id = ? AND state = 'ACTIVE' AND service_id <> ?", personId, ctx.serviceId);
        const kind = admitted ? 'SHARED_CARE' : 'ENROLLED';
        let crId = store.get<{ id: string }>('SELECT id FROM care_relationship WHERE person_id = ? AND service_id = ? AND ended_at IS NULL', personId, ctx.serviceId)?.id;
        if (!crId) {
          crId = newId();
          store.insert('care_relationship', { id: crId, person_id: personId, service_id: ctx.serviceId, kind, started_at: now() });
        }
        transition(store, 'referral', id, 'RESPONSIBILITY_ACCEPTED', who, kind === 'SHARED_CARE' ? 'Shared care' : 'On caseload');
        store.run('UPDATE referral SET responsibility_by = ?, care_relationship_id = ? WHERE id = ?', ctx.workerId, crId, id);
        startFromReferral(store, ctx, personId, id);
        break;
      }
      case 'outcome':
        recv();
        need(5, 'Write the outcome for the referring team.');
        transition(store, 'referral', id, 'OUTCOME_RECORDED', who);
        store.run('UPDATE referral SET outcome = ?, outcome_by = ?, outcome_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        break;
      case 'close':
        ref();
        transition(store, 'referral', id, 'CLOSED', who, note || 'Outcome read');
        store.run('UPDATE referral SET closed_by = ?, closed_at = ? WHERE id = ?', ctx.workerId, now(), id);
        break;
      case 'cancel':
        ref();
        need(5, 'Give the reason for cancelling.');
        transition(store, 'referral', id, 'CANCELLED', who, note);
        cancelForReferral(store, ctx, id, 'cancelled');
        store.run('UPDATE referral SET closed_by = ?, closed_at = ? WHERE id = ?', ctx.workerId, now(), id);
        break;
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `REFERRAL_${action.toUpperCase()}`, personId, id, note || undefined);
  });
  return shape(store, ctx, load(store, action === 'redirect' ? id : result.id));
}

// Referrals this service has made, and those sent to it.
export function list(store: Store, ctx: WorkContext) {
  const caps = ctx.role.capabilities;
  if (!caps.includes('referral.request') && !caps.includes('referral.triage')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include referrals`);
  }
  const rows = store.all<Row>(
    `${SELECT} WHERE (r.state IN ${OPEN} OR r.closed_at > datetime('now', '-1 day'))
        AND (r.from_service_id = ? OR (r.to_service_id = ? AND r.state NOT IN ('DRAFT', 'AUTHORISED')))
      ORDER BY CASE WHEN r.state IN ${OPEN} THEN 0 ELSE 1 END,
               CASE COALESCE(r.triage_priority, r.priority) WHEN 'URGENT' THEN 0 WHEN 'SEMI_URGENT' THEN 1 ELSE 2 END, r.drafted_at`,
    ctx.serviceId, ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_REFERRALS', decision: 'ALLOW', outcome: 'VIEWED', engines: [13, 42] });
  return rows.map((r) => shape(store, ctx, r));
}
