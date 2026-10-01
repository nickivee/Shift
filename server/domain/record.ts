import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { evaluate, relationship, type Operation } from './authority.ts';
import { audit } from './audit.ts';
import { history } from './lifecycle.ts';
import { forPerson as transfersFor } from './transfers.ts';
import { forPerson as dischargesFor } from './discharges.ts';
import { forPerson as escalationsFor } from './escalations.ts';
import { forPerson as consultationsFor } from './consultations.ts';
import { forPerson as referralsFor } from './referrals.ts';
import { forPerson as appointmentsFor } from './appointments.ts';
import { forPerson as alertsFor, activeRaised } from './alerts.ts';
import { forPerson as communicationsFor } from './communications.ts';
import { forPerson as monitoringFor } from './monitoring.ts';
import { forPerson as restrictionsFor, current as restrictionsNow } from './restrictions.ts';
import { forPerson as dietFor, current as dietNow } from './diets.ts';
import { forPerson as equipmentFor } from './equipment.ts';
import { forPerson as locationFor } from './locations.ts';
import { forPerson as leaveFor, current as leaveNow } from './leave.ts';
import { forPerson as preferencesFor, current as preferencesNow } from './preferences.ts';
import { forPerson as capacityFor, current as capacityNow } from './capacity.ts';
import { forPerson as whanauFor, current as whanauNow } from './whanau.ts';
import { forPerson as accessFor, current as accessNow } from './access.ts';
import { forPerson as externalFor, current as externalNow } from './external.ts';
import { forPerson as codingFor } from './coding.ts';
import { forPerson as reportsFor } from './reports.ts';
import { forPerson as instrumentsFor, current as instrumentsNow } from './questionnaires.ts';
import { forPerson as functionFor, current as functionNow } from './functional.ts';
import { forPerson as usualFor, current as usualNow } from './usual.ts';
import { forPerson as acuityFor, current as acuityNow } from './acuity.ts';
import { forPerson as deteriorationFor, current as deteriorationNow } from './deterioration.ts';
import { forPerson as incidentsFor } from './incidents.ts';
import { forPerson as deathFor, current as deathNow } from './deaths.ts';
import { forPerson as problemsFor, current as problemsNow } from './problems.ts';
import { forPerson as symptomsFor, current as symptomsNow } from './symptoms.ts';
import { forPerson as interventionsFor, current as interventionsNow } from './interventions.ts';
import { forPerson as treatmentPlansFor } from './treatmentplans.ts';
import { forPerson as pathwaysFor, current as pathwaysNow } from './pathways.ts';
import { forPerson as checklistsFor, current as checklistsNow } from './checklists.ts';
import { forPerson as recommendationsFor } from './recommendations.ts';
import { forPerson as requirementsFor } from './requirements.ts';
import { forPerson as careDueFor, current as careDueNow } from './caredue.ts';
import { forPerson as recallsFor } from './recalls.ts';
import { forPerson as followupsFor } from './followups.ts';
import { forPerson as surveillanceFor } from './surveillance.ts';
import { forPerson as screeningFor } from './screening.ts';
import { forPerson as infectionsFor, current as resistantNow } from './infections.ts';
import { forPerson as isolationFor, current as isolationNow } from './isolation.ts';
import { forPerson as allergiesFor } from './allergies.ts';
import { forPerson as consentFor, current as consentNow } from './consent.ts';
import { forPerson as endOfLifeFor, current as endOfLifeNow } from './endoflife.ts';
import { forPerson as safeguardingFor, current as safeguardingNow } from './safeguarding.ts';
import { forPerson as residencyFor, current as residencyNow } from './residency.ts';
import { forPerson as complaintsFor } from './complaints.ts';
import { forPerson as devicesFor, current as devicesNow } from './devices.ts';
import { forPerson as handoversFor, current as handoverNow } from './handovers.ts';
import { forPerson as conferencesFor } from './conferences.ts';
import { forPerson as rehabFor } from './rehab.ts';
import { forPerson as diagnosticsFor, current as criticalNow } from './diagnostics.ts';
import { forPerson as proceduresFor, current as recoveringNow } from './procedures.ts';
import { forPerson as decisionsFor } from './decisions.ts';
import { PLACE as DECISIONS_IN } from '../config/decisions.ts';
import { forPerson as antimicrobialsFor } from './antimicrobials.ts';
import { forPerson as sitechecksFor, current as siteNow } from './siteverify.ts';
import { forPerson as readinessFor } from './readiness.ts';
import { forPerson as variancesFor } from './variances.ts';
import { forPerson as declinedFor, current as declinedNow } from './declined.ts';
import { forPerson as prioritiesFor } from './priorities.ts';
import { forPerson as identityFor, current as identityNow } from './identitymatch.ts';
import { forPerson as duplicatesFor, current as duplicateNow } from './duplicates.ts';
import { current as breakGlassNow, pending as breakGlassPending } from './breakglass.ts';
import { forPerson as teamFor, current as teamNow } from './assignments.ts';
import { forPerson as woundsFor } from './wounds.ts';
import { forPerson as carePlanFor } from './careplans.ts';
import { VIEW_BY_CODE, KEY_BY_CODE } from '../config/keys.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';

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
            (SELECT 1 FROM allocation a WHERE a.person_id = p.id AND a.workforce_person_id = ? AND a.service_id = ? AND (a.state = 'ACTIVE' OR (a.state = 'LEGACY' AND a.shift_date = ?))) AS allocated,
            (SELECT count(*) FROM handover_mark h WHERE h.person_id = p.id AND h.service_id = ? AND h.cleared_at IS NULL) AS handover,
            (SELECT count(*) FROM task t WHERE t.person_id = p.id AND t.service_id = ? AND t.state NOT IN ('COMPLETED','CLOSED','CANCELLED')) AS open_tasks,
            (SELECT count(*) FROM allergy g WHERE g.person_id = p.id AND g.state = 'ACTIVE' AND g.kind <> 'NO_KNOWN_ALLERGIES') AS allergies,
            (SELECT fields_json FROM clinical_event c WHERE c.person_id = p.id AND c.service_id = ? AND c.category = 'TRIAGE' AND c.state = 'CURRENT' ORDER BY c.effective_at DESC LIMIT 1) AS triage,
            (SELECT q.level || '|' || q.what FROM priority q WHERE q.person_id = p.id AND q.service_id = ? AND q.scale = 'ATS' AND q.state IN ('WAITING', 'ACTIONED')
              ORDER BY q.assigned_at DESC LIMIT 1) AS priority,
            (SELECT t.state || '|' || s.name FROM transfer t JOIN service s ON s.id = t.to_service_id
              WHERE t.person_id = p.id AND t.state IN ('REQUESTED','ACCEPTED','BED_ALLOCATED','ARRIVED') LIMIT 1) AS transfer,
            (SELECT x.urgency FROM escalation x WHERE x.person_id = p.id AND x.state IN ('RAISED','RECEIVED','ACKNOWLEDGED','RESPONDED')
              ORDER BY CASE x.urgency WHEN 'IMMEDIATE' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END LIMIT 1) AS escalation,
            (SELECT d.state || '|' || COALESCE(d.expected_date, '') FROM discharge d WHERE d.person_id = p.id AND d.service_id = ? AND d.state IN ('CONSIDERED','DECIDED') LIMIT 1) AS discharge,
            (SELECT l.state || '|' || l.return_by FROM leave_of_absence l WHERE l.person_id = p.id AND l.state IN ('AWAY','NOT_RETURNED') LIMIT 1) AS away,
            (SELECT x.hospital_where FROM residency x WHERE x.person_id = p.id AND x.state = 'IN_HOSPITAL' LIMIT 1) AS inHospital
       FROM person p
       LEFT JOIN encounter e ON e.person_id = p.id AND e.service_id = ? AND e.state = 'ACTIVE'
      WHERE e.id IS NOT NULL
         OR EXISTS (SELECT 1 FROM care_relationship r WHERE r.person_id = p.id AND r.service_id = ? AND r.ended_at IS NULL)
      ORDER BY location, p.family_name`,
    ctx.workerId, ctx.serviceId, today, ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId, ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_LIST', objectType: 'service', objectId: ctx.serviceId, decision: 'ALLOW', outcome: 'VIEWED', engines: [28, 266] });
  const list = rows.map((r) => {
    const event = r.triage ? (JSON.parse(String(r.triage)) as Record<string, string>) : null;
    const [level, what] = r.priority ? String(r.priority).split('|') : [];
    const triage = level ? { category: level, complaint: event?.complaint ?? what } : event;
    return {
      id: r.id, name: `${r.given_name} ${r.family_name}`, preferredName: r.preferred_name, nhi: r.nhi,
      age: ageOn(r.date_of_birth as string), gender: r.gender, location: r.location,
      allocated: Boolean(r.allocated), handover: Number(r.handover), openTasks: Number(r.open_tasks), hasAllergy: Number(r.allergies) > 0,
      arrivedAt: r.arrived_at, triage: triage ? { category: triage.category ?? null, complaint: triage.complaint ?? null } : null,
      escalation: r.escalation ?? null,
      discharge: r.discharge ? { state: String(r.discharge).split('|')[0], expected: String(r.discharge).split('|')[1] || null } : null,
      transfer: r.transfer ? { state: String(r.transfer).split('|')[0], to: String(r.transfer).split('|')[1] } : null,
      inHospital: r.inHospital ? String(r.inHospital) : null,
      away: r.away ? { state: String(r.away).split('|')[0], returnBy: String(r.away).split('|')[1] } : null,
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
      WHERE p.id NOT IN (SELECT person_id FROM workforce_person) AND p.merged_into IS NULL
        AND (p.given_name || ' ' || p.family_name LIKE ? OR p.family_name LIKE ? OR x.value LIKE ?)
      ORDER BY p.family_name LIMIT 25`,
    like, like, like.toUpperCase(),
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'SEARCH', purpose: 'DIRECT_CARE', decision: 'ALLOW', outcome: 'VIEWED', reason: `${rows.length} results`, engines: [7, 26] });
  return rows.map((r) => ({
    id: r.id, name: `${r.given_name} ${r.family_name}`, nhi: r.nhi, dateOfBirth: r.date_of_birth,
    relationship: relationship(store, ctx, r.id),
    pending: breakGlassPending(store, ctx, r.id),
  }));
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
    alerts: activeRaised(store, personId),
    restrictions: restrictionsNow(store, personId),
    diet: dietNow(store, personId),
    leave: leaveNow(store, personId),
    preferences: preferencesNow(store, personId),
    capacity: capacityNow(store, personId),
    consentNo: consentNow(store, personId),
    endOfLife: endOfLifeNow(store, personId),
    safeguarding: safeguardingNow(store, personId),
    inHospital: residencyNow(store, personId),
    devices: devicesNow(store, personId),
    handoverOpen: handoverNow(store, personId),
    criticalResults: criticalNow(store, personId),
    recovering: recoveringNow(store, personId),
    whanau: whanauNow(store, personId),
    access: accessNow(store, personId),
    external: externalNow(store, personId),
    instruments: instrumentsNow(store, personId),
    function: functionNow(store, personId),
    usual: usualNow(store, personId),
    acuity: ctx.role.views.includes('acuity') ? acuityNow(store, personId) : null,
    deterioration: ctx.role.views.includes('deterioration') ? deteriorationNow(store, personId) : null,
    death: ctx.role.views.includes('death') ? deathNow(store, personId) : null,
    problems: ctx.role.views.includes('problems') ? problemsNow(store, personId) : null,
    symptoms: ctx.role.views.includes('symptoms') ? symptomsNow(store, personId) : null,
    interventionsDue: ctx.role.views.includes('interventions') ? interventionsNow(store, personId) : null,
    pathwaysDue: ctx.role.views.includes('pathways') ? pathwaysNow(store, personId) : null,
    checkExceptions: ctx.role.views.includes('checklists') ? checklistsNow(store, personId) : null,
    careOverdue: ctx.role.views.includes('caredue') ? careDueNow(store, personId) : null,
    resistantOrganisms: ctx.role.views.includes('infections') ? resistantNow(store, personId) : null,
    precautions: isolationNow(store, personId),
    siteDiscrepancies: ctx.role.views.includes('sitechecks') ? siteNow(store, personId) : null,
    declinedCare: ctx.role.views.includes('declined') ? declinedNow(store, personId) : null,
    identityUnresolved: identityNow(store, personId),
    possibleDuplicate: duplicateNow(store, personId),
    breakGlass: breakGlassNow(store, ctx, personId),
    mergedInto: p.merged_into ? { id: p.merged_into, name: store.get<{ n: string }>("SELECT given_name || ' ' || family_name AS n FROM person WHERE id = ?", p.merged_into)?.n ?? null } : null,
    team: teamNow(store, personId),
  };
}

// Retrieval (?view). Brings existing authorised information into the workspace from its
// canonical source; nothing is copied and no new record is created.

interface EventRow {
  id: string; lineage_id: string; version: number; category: string; key_code: string | null; fields_json: string;
  rendered_text: string; author: string | null; author_role_label: string | null; author_id: string | null;
  recorded_at: string; effective_at: string; effective_end: string | null; state: string; urgent: number;
  amendment_reason: string | null; service_name: string | null; collection: string; downtime_id: string | null; paper_by: string | null; paper_ref: string | null;
}

const EVENT_SELECT = `
  SELECT e.id, e.lineage_id, e.version, e.category, e.key_code, e.fields_json, e.rendered_text, w.display_name AS author,
         e.author_role_label, e.author_id, e.recorded_at, e.effective_at, e.effective_end, e.state, e.urgent, e.amendment_reason,
         s.name AS service_name, e.collection, e.downtime_id, e.paper_by, e.paper_ref
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
    fromPaper: e.downtime_id ? { by: e.paper_by, ref: e.paper_ref } : null,
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
      body = { events: rows.map((r) => shapeEvent(store, ctx, r)), conferences: ['review', 'goals'].includes(view.code) ? conferencesFor(store, ctx, personId) : null,
        rehab: ['review', 'treatment'].includes(view.code) ? rehabFor(store, ctx, personId) : null,
        procedures: view.code === 'procedures' ? proceduresFor(store, ctx, personId) : null,
        decisions: DECISIONS_IN[ctx.role.roleKey] === view.code ? decisionsFor(store, ctx, personId) : null };
      break;
    }
    case 'history': {
      const rows = store.all<EventRow>(`${EVENT_SELECT} WHERE e.person_id = ? AND e.state <> 'SUPERSEDED' ORDER BY e.effective_at DESC LIMIT 300`, personId);
      body = { events: rows.map((r) => shapeEvent(store, ctx, r)) };
      break;
    }
    case 'overview':
      body = { ...overview(store, ctx, personId), decisions: DECISIONS_IN[ctx.role.roleKey] === 'overview' ? decisionsFor(store, ctx, personId) : null };
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
      body = diagnosticsFor(store, ctx, personId);
      break;
    case 'allergies':
      body = allergiesFor(store, ctx, personId);
      break;
    case 'careplan':
      body = { ...carePlanFor(store, ctx, personId), conferences: conferencesFor(store, ctx, personId), rehab: rehabFor(store, ctx, personId), decisions: DECISIONS_IN[ctx.role.roleKey] === 'careplan' ? decisionsFor(store, ctx, personId) : null };
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
      body = { events: rows.map((r) => shapeEvent(store, ctx, r)), handovers: handoversFor(store, ctx, personId) };
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
    case 'referrals':
      body = referralsFor(store, ctx, personId);
      break;
    case 'appointments':
      body = appointmentsFor(store, ctx, personId);
      break;
    case 'alerts':
      body = alertsFor(store, ctx, personId);
      break;
    case 'communications':
      body = communicationsFor(store, ctx, personId);
      break;
    case 'monitoring':
      body = monitoringFor(store, ctx, personId);
      break;
    case 'restrictions':
      body = restrictionsFor(store, ctx, personId);
      break;
    case 'diet':
      body = dietFor(store, ctx, personId);
      break;
    case 'equipment':
      body = { ...equipmentFor(store, ctx, personId), devices: devicesFor(store, ctx, personId) };
      break;
    case 'location':
      body = locationFor(store, ctx, personId);
      break;
    case 'leave':
      body = { ...leaveFor(store, ctx, personId), residency: residencyFor(store, ctx, personId) };
      break;
    case 'preferences':
      body = preferencesFor(store, ctx, personId);
      break;
    case 'capacity':
      body = { ...capacityFor(store, ctx, personId), consent: consentFor(store, ctx, personId) };
      break;
    case 'support':
      body = whanauFor(store, ctx, personId);
      break;
    case 'access':
      body = accessFor(store, ctx, personId);
      break;
    case 'external':
      body = externalFor(store, ctx, personId);
      break;
    case 'coding':
      body = codingFor(store, ctx, personId);
      break;
    case 'reported':
      body = reportsFor(store, ctx, personId);
      break;
    case 'instruments':
      body = instrumentsFor(store, ctx, personId);
      break;
    case 'function':
      body = functionFor(store, ctx, personId);
      break;
    case 'usual':
      body = usualFor(store, ctx, personId);
      break;
    case 'incidents':
      body = { ...incidentsFor(store, ctx, personId), complaints: complaintsFor(store, ctx, personId), safeguarding: safeguardingFor(store, ctx, personId) };
      break;
    case 'death':
      body = { ...deathFor(store, ctx, personId), endOfLife: endOfLifeFor(store, ctx, personId) };
      break;
    case 'problems':
      body = problemsFor(store, ctx, personId);
      break;
    case 'symptoms':
      body = symptomsFor(store, ctx, personId);
      break;
    case 'interventions':
      body = interventionsFor(store, ctx, personId);
      break;
    case 'treatmentplans':
      body = treatmentPlansFor(store, ctx, personId);
      break;
    case 'pathways':
      body = pathwaysFor(store, ctx, personId);
      break;
    case 'checklists':
      body = checklistsFor(store, ctx, personId);
      break;
    case 'recommendations':
      body = recommendationsFor(store, ctx, personId);
      break;
    case 'requirements':
      body = requirementsFor(store, ctx, personId);
      break;
    case 'caredue':
      body = careDueFor(store, ctx, personId);
      break;
    case 'recalls':
      body = recallsFor(store, ctx, personId);
      break;
    case 'followups':
      body = followupsFor(store, ctx, personId);
      break;
    case 'surveillance':
      body = surveillanceFor(store, ctx, personId);
      break;
    case 'screening':
      body = screeningFor(store, ctx, personId);
      break;
    case 'infections':
      body = { ...infectionsFor(store, ctx, personId), isolation: isolationFor(store, ctx, personId) };
      break;
    case 'antimicrobials':
      body = antimicrobialsFor(store, ctx, personId);
      break;
    case 'sitechecks':
      body = sitechecksFor(store, ctx, personId);
      break;
    case 'readiness':
      body = readinessFor(store, ctx, personId);
      break;
    case 'variances':
      body = variancesFor(store, ctx, personId);
      break;
    case 'declined':
      body = declinedFor(store, ctx, personId);
      break;
    case 'priorities':
      body = prioritiesFor(store, ctx, personId);
      break;
    case 'identity':
      body = { ...identityFor(store, ctx, personId), duplicates: duplicatesFor(store, ctx, personId) };
      break;
    case 'deterioration':
      body = deteriorationFor(store, ctx, personId);
      break;
    case 'acuity':
      body = acuityFor(store, ctx, personId);
      break;
    case 'team':
      body = teamFor(store, ctx, personId);
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
    assignedTo: r.assigned_to?.startsWith('worker:') ? (r.assigned_to === `worker:${ctx.workerId}` ? 'You' : r.assignee_name) : r.assigned_to === `role:${ctx.role.roleKey}` ? 'Your role' : r.assigned_to?.startsWith('role:') ? `Any ${ROLE_BY_KEY.get(r.assigned_to.slice(5))?.label ?? r.assigned_to.slice(5)}` : 'Unassigned',
    mine: r.assigned_to === `worker:${ctx.workerId}`, state: r.state as string, createdAt: r.created_at, createdBy: r.created_by, outcome: r.outcome,
  }));
}
