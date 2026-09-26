import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { evaluate, relationship, type Operation } from './authority.ts';
import { audit } from './audit.ts';
import { history } from './lifecycle.ts';
import { forPerson as transfersFor } from './transfers.ts';
import { forPerson as dischargesFor } from './discharges.ts';
import { forPerson as escalationsFor } from './escalations.ts';
import { forPerson as consultationsFor } from './consultations.ts';
import { forPerson as woundsFor } from './wounds.ts';
import { forPerson as carePlanFor } from './careplans.ts';
import { VIEW_BY_CODE, KEY_BY_CODE } from '../config/keys.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Enforce an authority decision: anything other than ALLOW is refused and audited.
export function enforce(store: Store, ctx: WorkContext | null, o: Operation, personId?: string | null): void {
  const r = evaluate(store, ctx, o);
  if (r.decision === 'ALLOW') return;
  audit(store, {
    actorId: ctx?.workerId, sessionId: ctx?.sessionId, workContextId: ctx?.id, space: 'WORK',
    subjectPersonId: personId ?? null, operation: o.op, decision: r.decision,
    outcome: r.decision === 'HOLD' ? 'HELD' : 'BLOCKED', reason: r.reasons.join('; '), ruleRefs: r.ruleRefs,
  });
  throw new HttpError(403, r.decision, r.reasons.join(' '), { decision: r.decision, reasons: r.reasons, ruleRefs: r.ruleRefs });
}

function viewed(store: Store, ctx: WorkContext, personId: string, operation: string, objectType: string, purpose = 'DIRECT_CARE'): void {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType, purpose, decision: 'ALLOW', outcome: 'VIEWED', ruleRefs: ['ORG-SYN-001 v1', 'LAW-NZ-002'],
  });
}

function ageOn(dob: string | null, on = todayLocal()): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = on.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

// Patient list ------------------------------------------------------------------------

export function patientList(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'TASK', serviceId: ctx.serviceId });
  const today = todayLocal();
  // The service's list is everyone with an active encounter in it, plus anyone the service
  // holds an active care relationship with (e.g. a physiotherapy caseload on a ward).
  const rows = store.all<Record<string, string | number | null>>(
    `SELECT p.id, p.given_name, p.family_name, p.preferred_name, p.date_of_birth, p.gender,
            COALESCE(e.location, (SELECT o.location FROM encounter o WHERE o.person_id = p.id AND o.state = 'ACTIVE' ORDER BY o.started_at DESC LIMIT 1)) AS location,
            e.started_at AS arrived_at,
            (SELECT value FROM external_identifier x WHERE x.person_id = p.id AND x.system = 'NHI') AS nhi,
            (SELECT 1 FROM allocation a WHERE a.person_id = p.id AND a.workforce_person_id = ? AND a.service_id = ? AND a.shift_date = ?) AS allocated,
            (SELECT count(*) FROM handover_mark h WHERE h.person_id = p.id AND h.service_id = ? AND h.cleared_at IS NULL) AS handover,
            (SELECT count(*) FROM task t WHERE t.person_id = p.id AND t.service_id = ? AND t.state NOT IN ('COMPLETED','CLOSED','CANCELLED')) AS open_tasks,
            (SELECT count(*) FROM allergy g WHERE g.person_id = p.id AND g.state = 'ACTIVE' AND g.kind <> 'NO_KNOWN_ALLERGIES') AS allergies,
            (SELECT fields_json FROM clinical_event c WHERE c.person_id = p.id AND c.service_id = ? AND c.category = 'TRIAGE' AND c.state = 'CURRENT' ORDER BY c.effective_at DESC LIMIT 1) AS triage,
            (SELECT t.state || '|' || s.name FROM transfer t JOIN service s ON s.id = t.to_service_id
              WHERE t.person_id = p.id AND t.state IN ('REQUESTED','ACCEPTED','BED_ALLOCATED','ARRIVED') LIMIT 1) AS transfer,
            (SELECT x.urgency FROM escalation x WHERE x.person_id = p.id AND x.state IN ('RAISED','RECEIVED','ACKNOWLEDGED','RESPONDED')
              ORDER BY CASE x.urgency WHEN 'IMMEDIATE' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END LIMIT 1) AS escalation,
            (SELECT d.state || '|' || COALESCE(d.expected_date, '') FROM discharge d WHERE d.person_id = p.id AND d.service_id = ? AND d.state IN ('CONSIDERED','DECIDED') LIMIT 1) AS discharge
       FROM person p
       LEFT JOIN encounter e ON e.person_id = p.id AND e.service_id = ? AND e.state = 'ACTIVE'
      WHERE e.id IS NOT NULL
         OR EXISTS (SELECT 1 FROM care_relationship r WHERE r.person_id = p.id AND r.service_id = ? AND r.ended_at IS NULL)
      ORDER BY location, p.family_name`,
    ctx.workerId, ctx.serviceId, today, ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_LIST', objectType: 'service', objectId: ctx.serviceId, decision: 'ALLOW', outcome: 'VIEWED', engines: [28, 266] });
  const list = rows.map((r) => {
    const triage = r.triage ? (JSON.parse(String(r.triage)) as Record<string, string>) : null;
    return {
      id: r.id, name: `${r.given_name} ${r.family_name}`, preferredName: r.preferred_name, nhi: r.nhi,
      age: ageOn(r.date_of_birth as string), gender: r.gender, location: r.location,
      allocated: Boolean(r.allocated), handover: Number(r.handover), openTasks: Number(r.open_tasks), hasAllergy: Number(r.allergies) > 0,
      arrivedAt: r.arrived_at, triage: triage ? { category: triage.category ?? null, complaint: triage.complaint ?? null } : null,
      escalation: r.escalation ?? null,
      discharge: r.discharge ? { state: String(r.discharge).split('|')[0], expected: String(r.discharge).split('|')[1] || null } : null,
      transfer: r.transfer ? { state: String(r.transfer).split('|')[0], to: String(r.transfer).split('|')[1] } : null,
    };
  });
  // Board order: triage category as recorded by the triage nurse, untriaged first so they
  // are seen, then time waiting. SHIFT never assigns a category itself.
  if (ctx.role.board) {
    const rank = (p: (typeof list)[number]) => (p.triage?.category ? Number(p.triage.category.replace(/\D/g, '')) : 0);
    list.sort((a, b) => rank(a) - rank(b) || String(a.arrivedAt).localeCompare(String(b.arrivedAt)));
  }
  return list;
}

// Search returns minimal identifying details only, and says whether the worker has a
// relationship. Opening a record without one goes through exceptional access.
export function search(store: Store, ctx: WorkContext, q: string) {
  enforce(store, ctx, { op: 'TASK', serviceId: ctx.serviceId });
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_]/g, '')}%`;
  const rows = store.all<Record<string, string>>(
    `SELECT DISTINCT p.id, p.given_name, p.family_name, p.date_of_birth,
            (SELECT value FROM external_identifier x WHERE x.person_id = p.id AND x.system = 'NHI') AS nhi
       FROM person p
       LEFT JOIN external_identifier x ON x.person_id = p.id
      WHERE p.id NOT IN (SELECT person_id FROM workforce_person)
        AND (p.given_name || ' ' || p.family_name LIKE ? OR p.family_name LIKE ? OR x.value LIKE ?)
      ORDER BY p.family_name LIMIT 25`,
    like, like, like.toUpperCase(),
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'SEARCH', purpose: 'DIRECT_CARE', decision: 'ALLOW', outcome: 'VIEWED', reason: `${rows.length} results`, engines: [7, 26] });
  return rows.map((r) => ({
    id: r.id, name: `${r.given_name} ${r.family_name}`, nhi: r.nhi, dateOfBirth: r.date_of_birth,
    relationship: relationship(store, ctx, r.id),
  }));
}

export function grantExceptionalAccess(store: Store, ctx: WorkContext, personId: string, reason: string) {
  const text = reason.trim();
  if (text.length < 10) throw new HttpError(400, 'REASON_REQUIRED', 'Give the reason you need this record (at least a short sentence).');
  if (!store.get('SELECT 1 FROM person WHERE id = ?', personId)) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const id = newId();
  store.tx(() => {
    store.insert('exceptional_access', { id, work_context_id: ctx.id, workforce_person_id: ctx.workerId, person_id: personId, reason: text, granted_at: now(), expires_at: expires });
    audit(store, {
      actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
      operation: 'EXCEPTIONAL_ACCESS', objectType: 'exceptional_access', objectId: id, purpose: 'DIRECT_CARE', decision: 'ALLOW',
      outcome: 'COMMITTED', reason: text, ruleRefs: ['ORG-SYN-001 v1', 'LAW-NZ-002'], engines: [26],
    });
  });
  return { expiresAt: expires };
}

// Patient header and safety banner ------------------------------------------------------

export function header(store: Store, ctx: WorkContext, personId: string) {
  enforce(store, ctx, { op: 'VIEW_RECORD', personId }, personId);
  const p = store.get<Record<string, string>>('SELECT * FROM person WHERE id = ?', personId);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  const ids = store.all<{ system: string; value: string; verification: string }>(
    'SELECT system, value, verification FROM external_identifier WHERE person_id = ?', personId,
  );
  const enc = store.get<{ location: string | null; kind: string }>(
    "SELECT location, kind FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId,
  );
  const allergies = store.all<Record<string, string>>(
    "SELECT kind, substance, reaction, severity, certainty FROM allergy WHERE person_id = ? AND state = 'ACTIVE' ORDER BY kind, substance",
    personId,
  );
  const reactions = allergies.filter((a) => a.kind !== 'NO_KNOWN_ALLERGIES');
  const allergyStatus = reactions.length ? 'RECORDED' : allergies.length ? 'NO_KNOWN_ALLERGIES' : 'NOT_RECORDED';
  viewed(store, ctx, personId, 'VIEW_RECORD', 'person');
  return {
    id: p.id,
    name: `${p.given_name} ${p.family_name}`,
    preferredName: p.preferred_name,
    localId: ids.find((i) => i.system === 'LOCAL_MRN')?.value ?? null,
    nhi: ids.find((i) => i.system === 'NHI') ?? null,
    dateOfBirth: p.date_of_birth,
    age: ageOn(p.date_of_birth),
    gender: p.gender,
    ethnicity: p.ethnicity,
    iwi: p.iwi,
    location: enc?.location ?? null,
    relationship: relationship(store, ctx, personId),
    synthetic: p.data_source === 'SYNTHETIC',
    allergyStatus,
    allergies: reactions.map((a) => ({ kind: a.kind, substance: a.substance, reaction: a.reaction, severity: a.severity, certainty: a.certainty })),
  };
}

// Retrieval (?view). Brings existing authorised information into the workspace from its
// canonical source; nothing is copied and no new record is created.

interface EventRow {
  id: string; lineage_id: string; version: number; category: string; key_code: string | null; fields_json: string;
  rendered_text: string; author: string | null; author_role_label: string | null; author_id: string | null;
  recorded_at: string; effective_at: string; effective_end: string | null; state: string; urgent: number;
  amendment_reason: string | null; service_name: string | null; collection: string;
}

const EVENT_SELECT = `
  SELECT e.id, e.lineage_id, e.version, e.category, e.key_code, e.fields_json, e.rendered_text, w.display_name AS author,
         e.author_role_label, e.author_id, e.recorded_at, e.effective_at, e.effective_end, e.state, e.urgent, e.amendment_reason,
         s.name AS service_name, e.collection
    FROM clinical_event e
    LEFT JOIN workforce_person w ON w.id = e.author_id
    LEFT JOIN service s ON s.id = e.service_id`;

function shapeEvent(store: Store, ctx: WorkContext, e: EventRow) {
  const routes = store.all<{ id: string; label: string; state: string }>(
    `SELECT r.id, d.label, r.state FROM route r JOIN destination d ON d.id = r.destination_id WHERE r.source_lineage_id = ? ORDER BY r.created_at`,
    e.lineage_id,
  );
  const mark = store.get<{ id: string }>(
    'SELECT id FROM handover_mark WHERE event_lineage_id = ? AND service_id = ? AND cleared_at IS NULL', e.lineage_id, ctx.serviceId,
  );
  return {
    id: e.id, lineageId: e.lineage_id, version: e.version, category: e.category, key: e.key_code,
    fields: JSON.parse(e.fields_json), text: e.rendered_text, author: e.author, authorRole: e.author_role_label,
    mine: e.author_id === ctx.workerId, recordedAt: e.recorded_at, effectiveAt: e.effective_at, effectiveEnd: e.effective_end,
    state: e.state, urgent: Boolean(e.urgent), amendmentReason: e.amendment_reason, service: e.service_name,
    collection: e.collection, routes, handover: Boolean(mark),
  };
}

export function retrieve(store: Store, ctx: WorkContext, personId: string, code: string) {
  const view = VIEW_BY_CODE.get(code);
  if (!view) throw new HttpError(404, 'UNKNOWN_VIEW', `?${code} is not a SHIFT retrieve.`);
  enforce(store, ctx, { op: 'RETRIEVE', personId, view: code }, personId);
  const canAdd = view.key && ctx.role.keys.includes(view.key) ? view.key : null;
  let body: unknown;
  switch (view.kind) {
    case 'events': {
      const ph = view.categories!.map(() => '?').join(',');
      const rows = store.all<EventRow>(
        `${EVENT_SELECT} WHERE e.person_id = ? AND e.category IN (${ph}) AND e.state <> 'SUPERSEDED' ORDER BY e.effective_at DESC LIMIT 200`,
        personId, ...view.categories!,
      );
      body = { events: rows.map((r) => shapeEvent(store, ctx, r)) };
      break;
    }
    case 'history': {
      const rows = store.all<EventRow>(`${EVENT_SELECT} WHERE e.person_id = ? AND e.state <> 'SUPERSEDED' ORDER BY e.effective_at DESC LIMIT 300`, personId);
      body = { events: rows.map((r) => shapeEvent(store, ctx, r)) };
      break;
    }
    case 'overview':
      body = overview(store, ctx, personId);
      break;
    case 'meds':
      body = {
        medicines: store.all(
          `SELECT medicine, dose, route, frequency, indication, state, prescriber, started_at AS startedAt, ceased_at AS ceasedAt, source
             FROM medication WHERE person_id = ? ORDER BY CASE state WHEN 'ACTIVE' THEN 0 WHEN 'HELD' THEN 1 ELSE 2 END, medicine`,
          personId,
        ),
        prescribing: evaluate(store, ctx, { op: 'PRESCRIBE' }),
        administration: evaluate(store, ctx, { op: 'ADMINISTER' }),
      };
      break;
    case 'results':
      body = {
        results: store.all(
          `SELECT r.id, r.test, r.value, r.units, r.reference_range AS referenceRange, r.flag, r.state, r.performed_at AS performedAt,
                  r.released_at AS releasedAt, r.source, w.display_name AS reviewedBy, r.reviewed_at AS reviewedAt
             FROM result r LEFT JOIN workforce_person w ON w.id = r.reviewed_by
            WHERE r.person_id = ? ORDER BY r.performed_at DESC, r.test`,
          personId,
        ),
        canReview: evaluate(store, ctx, { op: 'REVIEW_RESULT', personId }).decision === 'ALLOW',
      };
      break;
    case 'allergies':
      body = {
        allergies: store.all(
          `SELECT a.kind, a.substance, a.reaction, a.severity, a.certainty, a.state, a.source, a.recorded_at AS recordedAt, w.display_name AS recordedBy
             FROM allergy a LEFT JOIN workforce_person w ON w.id = a.recorded_by WHERE a.person_id = ? ORDER BY a.state, a.substance`,
          personId,
        ),
      };
      break;
    case 'careplan':
      body = carePlanFor(store, ctx, personId);
      break;
    case 'tasks':
      body = { tasks: tasksFor(store, ctx, { personId }) };
      break;
    case 'handover': {
      const rows = store.all<EventRow>(
        `${EVENT_SELECT} JOIN handover_mark h ON h.event_lineage_id = e.lineage_id
          WHERE e.person_id = ? AND h.service_id = ? AND h.cleared_at IS NULL AND e.state = 'CURRENT' ORDER BY e.effective_at DESC`,
        personId, ctx.serviceId,
      );
      body = { events: rows.map((r) => shapeEvent(store, ctx, r)) };
      break;
    }
    case 'transfers':
      body = transfersFor(store, ctx, personId);
      break;
    case 'discharge':
      body = dischargesFor(store, ctx, personId);
      break;
    case 'escalations':
      body = escalationsFor(store, ctx, personId);
      break;
    case 'consults':
      body = consultationsFor(store, ctx, personId);
      break;
    case 'wounds':
      body = woundsFor(store, ctx, personId);
      break;
    case 'routes':
      body = {
        routes: store.all(
          `SELECT r.id, r.state, r.purpose, r.created_at AS createdAt, d.label AS destination, e.rendered_text AS text, e.category,
                  w.display_name AS sender, r.requires_acceptance AS requiresAcceptance, e.id <> r.source_event_id AS amended
             FROM route r JOIN destination d ON d.id = r.destination_id
             JOIN clinical_event e ON e.lineage_id = r.source_lineage_id AND e.state <> 'SUPERSEDED'
             JOIN workforce_person w ON w.id = r.actor_id
            WHERE r.person_id = ? ORDER BY r.created_at DESC`,
          personId,
        ),
      };
      break;
  }
  viewed(store, ctx, personId, 'RETRIEVE', `?${code}`);
  return { view: { code: view.code, label: view.label, kind: view.kind }, canAdd, ...(body as object) };
}

function overview(store: Store, ctx: WorkContext, personId: string) {
  const latest = (cat: string) => {
    const r = store.get<EventRow>(`${EVENT_SELECT} WHERE e.person_id = ? AND e.category = ? AND e.state = 'CURRENT' ORDER BY e.effective_at DESC LIMIT 1`, personId, cat);
    return r ? shapeEvent(store, ctx, r) : null;
  };
  return {
    latestObs: ctx.role.views.includes('obs') ? latest('OBS') : null,
    latestWeight: latest('WEIGHT'),
    activeMedicines: ctx.role.views.includes('meds')
      ? Number(store.get<{ n: number }>("SELECT count(*) AS n FROM medication WHERE person_id = ? AND state = 'ACTIVE'", personId)?.n ?? 0)
      : null,
    unreviewedResults: ctx.role.views.includes('results')
      ? Number(store.get<{ n: number }>("SELECT count(*) AS n FROM result WHERE person_id = ? AND state = 'AVAILABLE'", personId)?.n ?? 0)
      : null,
    carePlan: store.all("SELECT need, intervention FROM care_plan_item WHERE person_id = ? AND state = 'ACTIVE' ORDER BY created_at LIMIT 6", personId),
    openTasks: tasksFor(store, ctx, { personId }).filter((t) => !['COMPLETED', 'CLOSED', 'CANCELLED'].includes(t.state)).length,
    handover: Number(store.get<{ n: number }>('SELECT count(*) AS n FROM handover_mark WHERE person_id = ? AND service_id = ? AND cleared_at IS NULL', personId, ctx.serviceId)?.n ?? 0),
    earlyWarning: evaluate(store, ctx, { op: 'EARLY_WARNING_SCORE' }),
  };
}

export function eventDetail(store: Store, ctx: WorkContext, eventId: string) {
  const e = store.get<EventRow & { person_id: string }>(`${EVENT_SELECT.replace('SELECT e.id', 'SELECT e.person_id, e.id')} WHERE e.id = ?`, eventId);
  if (!e) throw new HttpError(404, 'NOT_FOUND', 'Entry not found.');
  enforce(store, ctx, { op: 'VIEW_RECORD', personId: e.person_id }, e.person_id);
  const versions = store.all<EventRow>(`${EVENT_SELECT} WHERE e.lineage_id = ? ORDER BY e.version DESC`, e.lineage_id);
  const routes = store.all<{ id: string }>('SELECT id FROM route WHERE source_lineage_id = ?', e.lineage_id);
  viewed(store, ctx, e.person_id, 'VIEW_EVENT', 'clinical_event');
  return {
    event: shapeEvent(store, ctx, e),
    template: e.key_code ? KEY_BY_CODE.get(e.key_code) ?? null : null,
    canAmend: e.state === 'CURRENT' && evaluate(store, ctx, { op: 'AMEND', personId: e.person_id, authorId: e.author_id }).decision === 'ALLOW',
    versions: versions.map((v) => shapeEvent(store, ctx, v)),
    routeHistory: routes.map((r) => ({ id: r.id, transitions: history(store, 'route', r.id) })),
  };
}

// Tasks visible to this worker in the active service: unassigned, assigned to their role,
// or assigned to them personally. Assignment is explicit; routing never assigns silently.
export function tasksFor(store: Store, ctx: WorkContext, f: { personId?: string; openOnly?: boolean }) {
  const rows = store.all<Record<string, string | null>>(
    `SELECT t.id, t.person_id, t.description, t.due_at, t.assigned_to, t.state, t.created_at, t.outcome,
            c.display_name AS created_by, p.given_name || ' ' || p.family_name AS patient,
            (SELECT location FROM encounter e WHERE e.person_id = t.person_id AND e.service_id = t.service_id AND e.state = 'ACTIVE') AS location,
            aw.display_name AS assignee_name
       FROM task t JOIN workforce_person c ON c.id = t.created_by JOIN person p ON p.id = t.person_id
       LEFT JOIN workforce_person aw ON t.assigned_to = 'worker:' || aw.id
      WHERE t.service_id = ?
        ${f.personId ? 'AND t.person_id = ?' : ''}
        ${f.openOnly ? "AND t.state NOT IN ('CLOSED','CANCELLED')" : ''}
        AND (t.assigned_to IS NULL OR t.assigned_to = ? OR t.assigned_to = ? OR t.created_by = ?)
      ORDER BY CASE WHEN t.state IN ('COMPLETED','CLOSED','CANCELLED') THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at, t.created_at`,
    ...[ctx.serviceId, ...(f.personId ? [f.personId] : []), `role:${ctx.role.roleKey}`, `worker:${ctx.workerId}`, ctx.workerId],
  );
  return rows.map((r) => ({
    id: r.id, personId: r.person_id, patient: r.patient, location: r.location, description: r.description, dueAt: r.due_at,
    assignedTo: r.assigned_to?.startsWith('worker:') ? (r.assigned_to === `worker:${ctx.workerId}` ? 'You' : r.assignee_name) : r.assigned_to?.startsWith('role:') ? 'Your role' : 'Unassigned',
    mine: r.assigned_to === `worker:${ctx.workerId}`, state: r.state as string, createdAt: r.created_at, createdBy: r.created_by, outcome: r.outcome,
  }));
}
