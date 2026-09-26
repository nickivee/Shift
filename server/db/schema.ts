// Canonical persistence model (Package 10 §4). Every authoritative object has a stable
// internal ID, lifecycle state, attribution, provenance and history. Screens, tabs and
// destination references never receive their own copy of a clinical fact.

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'foundation',
    sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Identity and context (Package 3) ------------------------------------------------

CREATE TABLE person (
  id TEXT PRIMARY KEY,
  family_name TEXT NOT NULL,
  given_name TEXT NOT NULL,
  preferred_name TEXT,
  date_of_birth TEXT,
  gender TEXT,
  ethnicity TEXT,
  iwi TEXT,
  data_source TEXT NOT NULL,           -- SYNTHETIC | AUTHORITATIVE | LOCAL
  created_at TEXT NOT NULL
);

-- Authoritative external identifiers stay distinct from SHIFT internal IDs (HIPC rule 13).
CREATE TABLE external_identifier (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  system TEXT NOT NULL,                 -- NHI | LOCAL_MRN
  value TEXT NOT NULL,
  verification TEXT NOT NULL,           -- SYNTHETIC | VERIFIED | UNVERIFIED | DISPUTED
  created_at TEXT NOT NULL,
  UNIQUE (system, value)
);

CREATE TABLE organisation (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_source TEXT NOT NULL
);

CREATE TABLE facility (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation(id),
  name TEXT NOT NULL
);

CREATE TABLE service (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation(id),
  facility_id TEXT REFERENCES facility(id),
  name TEXT NOT NULL,
  sector TEXT NOT NULL,
  subject_label TEXT NOT NULL DEFAULT 'Patient'   -- Patient | Resident | Client
);

CREATE TABLE team (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES service(id),
  name TEXT NOT NULL
);

CREATE TABLE workforce_person (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  display_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL                  -- ACTIVE | SUSPENDED | ENDED
);

-- Professional authority is effective-dated and separate from profession/job title
-- (REQ-PROF-001..003).
CREATE TABLE professional_authority (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL REFERENCES workforce_person(id),
  profession TEXT NOT NULL,
  regulator TEXT,
  registration_number TEXT,
  scope TEXT,
  conditions TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  status TEXT NOT NULL,                 -- CURRENT | EXPIRED | SUSPENDED | CONDITIONAL
  data_source TEXT NOT NULL
);

CREATE TABLE employment (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL REFERENCES workforce_person(id),
  organisation_id TEXT NOT NULL REFERENCES organisation(id),
  employment_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT
);

CREATE TABLE position (
  id TEXT PRIMARY KEY,
  employment_id TEXT NOT NULL REFERENCES employment(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  title TEXT NOT NULL,
  role_key TEXT NOT NULL,               -- links to workstation configuration + rule pack
  start_date TEXT NOT NULL,
  end_date TEXT
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  workforce_person_id TEXT NOT NULL REFERENCES workforce_person(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);

-- Active WORK context: time-bounded, never permanent permission (WF-002).
CREATE TABLE work_context (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  workforce_person_id TEXT NOT NULL REFERENCES workforce_person(id),
  position_id TEXT NOT NULL REFERENCES position(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  established_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE encounter (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  location TEXT,
  kind TEXT NOT NULL,                   -- RESIDENTIAL | INPATIENT | OUTPATIENT | COMMUNITY
  started_at TEXT NOT NULL,
  ended_at TEXT,
  state TEXT NOT NULL                   -- ACTIVE | ENDED
);

-- Care relationships other than the current encounter (e.g. GP enrolment, visiting service).
CREATE TABLE care_relationship (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,                   -- ENROLLED | SHARED_CARE | VISITING
  started_at TEXT NOT NULL,
  ended_at TEXT
);

-- Allocation contributes context; it is not unrestricted authority.
CREATE TABLE allocation (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL REFERENCES workforce_person(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  shift_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);

-- Exceptional (non-allocated, out-of-service) access is its own governed pathway.
CREATE TABLE exceptional_access (
  id TEXT PRIMARY KEY,
  work_context_id TEXT NOT NULL REFERENCES work_context(id),
  workforce_person_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id),
  reason TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reviewed_at TEXT,
  review_outcome TEXT
);

-- Canonical clinical objects (Package 4) -----------------------------------------------

-- One genuine clinical event is recorded once. Amendments create a new version that
-- supersedes the prior version; the original is never rewritten.
CREATE TABLE clinical_event (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,             -- stable identity across versions
  version INTEGER NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id),
  encounter_id TEXT REFERENCES encounter(id),
  category TEXT NOT NULL,
  key_code TEXT,                        -- .key used, e.g. .obs
  key_version INTEGER,
  fields_json TEXT NOT NULL,            -- only fields the worker actually entered
  rendered_text TEXT NOT NULL,
  author_id TEXT,                       -- workforce_person
  author_position_id TEXT,
  author_role_label TEXT,
  service_id TEXT REFERENCES service(id),
  recorded_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  effective_end TEXT,                   -- set when the worker records a From/To period
  state TEXT NOT NULL,                  -- CURRENT | SUPERSEDED | ENTERED_IN_ERROR
  supersedes_id TEXT REFERENCES clinical_event(id),
  amendment_reason TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  collection TEXT NOT NULL,             -- DIRECT | INDIRECT (HIPC rule 2/3A provenance)
  data_source TEXT NOT NULL,            -- SHIFT | SYNTHETIC
  transaction_id TEXT
);
CREATE INDEX clinical_event_person ON clinical_event(person_id, category, effective_at);
CREATE INDEX clinical_event_lineage ON clinical_event(lineage_id, version);

CREATE TABLE allergy (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  kind TEXT NOT NULL,                   -- ALLERGY | INTOLERANCE | NO_KNOWN_ALLERGIES
  substance TEXT,
  reaction TEXT,
  severity TEXT,
  certainty TEXT,                       -- CONFIRMED | SUSPECTED | REFUTED | UNCERTAIN
  state TEXT NOT NULL,                  -- ACTIVE | INACTIVE | ENTERED_IN_ERROR
  source TEXT NOT NULL,
  recorded_by TEXT,
  recorded_at TEXT NOT NULL,
  data_source TEXT NOT NULL
);

CREATE TABLE medication (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  medicine TEXT NOT NULL,
  dose TEXT,
  route TEXT,
  frequency TEXT,
  indication TEXT,
  state TEXT NOT NULL,                  -- ORDERED | VERIFIED | ACTIVE | HELD | CEASED
  prescriber TEXT,
  started_at TEXT,
  ceased_at TEXT,
  source TEXT NOT NULL,
  data_source TEXT NOT NULL
);

CREATE TABLE result (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  test TEXT NOT NULL,
  value TEXT NOT NULL,
  units TEXT,
  reference_range TEXT,
  flag TEXT,
  state TEXT NOT NULL,                  -- AVAILABLE | REVIEWED | ACTIONED | CORRECTED
  performed_at TEXT NOT NULL,
  released_at TEXT,
  source TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  data_source TEXT NOT NULL
);

CREATE TABLE care_plan_item (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  need TEXT NOT NULL,
  goal TEXT,
  intervention TEXT NOT NULL,
  responsible TEXT,
  review_date TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | ACHIEVED | CEASED | SUPERSEDED
  created_at TEXT NOT NULL,
  data_source TEXT NOT NULL
);

-- Coordination objects ------------------------------------------------------------------

-- Destination registry (Package 3 §16). Aliases such as +rn are not the destination identity.
CREATE TABLE destination (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation(id),
  alias TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- SERVICE | ROLE_IN_SERVICE
  service_id TEXT NOT NULL REFERENCES service(id),
  role_key TEXT,
  requires_acceptance INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (organisation_id, alias)
);

-- A route is a governed reference to the canonical source; it never copies it.
CREATE TABLE route (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL REFERENCES clinical_event(id),
  source_lineage_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id),
  destination_id TEXT NOT NULL REFERENCES destination(id),
  purpose TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_position_id TEXT NOT NULL,
  state TEXT NOT NULL,
  requires_acceptance INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  transaction_id TEXT
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  source_event_id TEXT REFERENCES clinical_event(id),
  description TEXT NOT NULL,
  due_at TEXT,
  service_id TEXT NOT NULL REFERENCES service(id),
  assigned_to TEXT,
  state TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  outcome TEXT,
  transaction_id TEXT
);

-- Explicit handover marks reference the canonical event (not a copy).
CREATE TABLE handover_mark (
  id TEXT PRIMARY KEY,
  event_lineage_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  cleared_by TEXT,
  cleared_at TEXT
);

CREATE TABLE handover_receipt (
  id TEXT PRIMARY KEY,
  mark_id TEXT NOT NULL REFERENCES handover_mark(id),
  workforce_person_id TEXT NOT NULL,
  state TEXT NOT NULL,                  -- RECEIVED | REVIEWED
  at TEXT NOT NULL,
  UNIQUE (mark_id, workforce_person_id, state)
);

-- Every lifecycle transition of every governed object (Package 5 §8 evidence contract).
CREATE TABLE state_transition (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_id TEXT,
  work_context_id TEXT,
  at TEXT NOT NULL,
  reason TEXT,
  transaction_id TEXT
);
CREATE INDEX state_transition_object ON state_transition(object_type, object_id, at);

-- Enter-once transaction boundary with idempotency (Package 10 §5).
CREATE TABLE command_transaction (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command TEXT NOT NULL,
  engines TEXT NOT NULL,
  created_at TEXT NOT NULL,
  result_json TEXT NOT NULL,
  UNIQUE (actor_id, idempotency_key)
);

-- Worker configuration --------------------------------------------------------------------

-- Presentation and placement only. Validated against the authorised capability set.
CREATE TABLE home_layout (
  workforce_person_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workforce_person_id, service_id, role_key)
);

-- Personal Note: temporary personal working memory inside WORK. Not clinical documentation.
-- Retention/deletion basis is OPEN, so dismissal hides rather than destroys.
CREATE TABLE personal_note (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dismissed_at TEXT
);

-- Doctors' shared professional knowledge -------------------------------------------------
-- Participants are anonymous to each other; the system keeps the author for audit and
-- governance. SHIFT supplies no answers. Nothing here is a referral, a transfer of
-- responsibility or part of any patient record.
CREATE TABLE knowledge_question (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,              -- visible to audit only, never to participants
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- OPEN | CLOSED | WITHDRAWN
  closed_at TEXT
);

CREATE TABLE knowledge_reply (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES knowledge_question(id),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL                   -- VISIBLE | WITHDRAWN
);

-- PERSONAL: the employee's own employment information --------------------------------------

CREATE TABLE roster_shift (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL,
  position_id TEXT NOT NULL REFERENCES position(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  state TEXT NOT NULL,                  -- PLANNED | CANCELLED
  data_source TEXT NOT NULL
);

-- Actual attendance is separate from the planned roster (roster is not attendance).
CREATE TABLE actual_shift (
  id TEXT PRIMARY KEY,
  roster_shift_id TEXT REFERENCES roster_shift(id),
  workforce_person_id TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  variance TEXT,
  data_source TEXT NOT NULL
);

CREATE TABLE availability (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL,
  available_date TEXT NOT NULL,
  period TEXT NOT NULL,                 -- AM | PM | NIGHT | ALL_DAY
  preference TEXT NOT NULL,             -- AVAILABLE | PREFERRED | UNAVAILABLE
  private_note TEXT,
  recorded_at TEXT NOT NULL,
  withdrawn_at TEXT
);

CREATE TABLE open_shift (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES service(id),
  role_key TEXT NOT NULL,
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  state TEXT NOT NULL,                  -- OPEN | FILLED | WITHDRAWN
  created_at TEXT NOT NULL,
  data_source TEXT NOT NULL
);

-- Expressing interest never changes the roster. Only a governed roster change does.
CREATE TABLE open_shift_interest (
  id TEXT PRIMARY KEY,
  open_shift_id TEXT NOT NULL REFERENCES open_shift(id),
  workforce_person_id TEXT NOT NULL,
  state TEXT NOT NULL,                  -- INTERESTED | WITHDRAWN | OFFERED | ACCEPTED | DECLINED
  at TEXT NOT NULL
);

CREATE TABLE payslip (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL,
  employment_id TEXT NOT NULL REFERENCES employment(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  gross_cents INTEGER NOT NULL,
  deductions_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  data_source TEXT NOT NULL
);

CREATE TABLE leave_balance (
  workforce_person_id TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  hours REAL NOT NULL,
  as_at TEXT NOT NULL,
  data_source TEXT NOT NULL,
  PRIMARY KEY (workforce_person_id, leave_type)
);

CREATE TABLE leave_request (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  private_reason TEXT,
  state TEXT NOT NULL,                  -- REQUESTED | APPROVED | DECLINED | CANCELLED
  requested_at TEXT NOT NULL
);

CREATE TABLE credential (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  issuer TEXT,
  reference TEXT,
  valid_from TEXT,
  valid_to TEXT,
  evidence_note TEXT,
  data_source TEXT NOT NULL
);

CREATE TABLE training_record (
  id TEXT PRIMARY KEY,
  workforce_person_id TEXT NOT NULL,
  course TEXT NOT NULL,
  provider TEXT,
  completed_at TEXT,
  expires_at TEXT,
  state TEXT NOT NULL,                  -- COMPLETED | ENROLLED | DUE
  data_source TEXT NOT NULL
);

-- Audit and provenance (Package 10 §12). Append-only, hash-chained; view-only access too.
CREATE TABLE audit_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor_id TEXT,
  session_id TEXT,
  work_context_id TEXT,
  space TEXT NOT NULL,                  -- AUTH | PERSONAL | WORK | SYSTEM
  subject_person_id TEXT,
  operation TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  purpose TEXT,
  decision TEXT,                        -- ALLOW | BLOCK | HOLD | UNRESOLVED
  outcome TEXT NOT NULL,                -- COMMITTED | VIEWED | BLOCKED | HELD | FAILED
  reason TEXT,
  rule_refs TEXT,
  engines TEXT,
  transaction_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
CREATE TRIGGER clinical_event_no_delete BEFORE DELETE ON clinical_event
BEGIN SELECT RAISE(ABORT, 'clinical_event history cannot be deleted'); END;
CREATE TRIGGER state_transition_no_update BEFORE UPDATE ON state_transition
BEGIN SELECT RAISE(ABORT, 'state_transition is append-only'); END;
CREATE TRIGGER state_transition_no_delete BEFORE DELETE ON state_transition
BEGIN SELECT RAISE(ABORT, 'state_transition is append-only'); END;
`,
  },
  {
    version: 2,
    name: 'rostering',
    sql: `
-- A worker offering their own rostered shift to eligible colleagues. The offer and any
-- colleague's willingness to take it never change the roster; a rostering decision does.
CREATE TABLE shift_offer (
  id TEXT PRIMARY KEY,
  roster_shift_id TEXT NOT NULL REFERENCES roster_shift(id),
  offered_by TEXT NOT NULL,
  state TEXT NOT NULL,                  -- OFFERED | WITHDRAWN | REASSIGNED | DECLINED
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE shift_offer_take (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES shift_offer(id),
  workforce_person_id TEXT NOT NULL,
  state TEXT NOT NULL,                  -- INTERESTED | WITHDRAWN | ACCEPTED | DECLINED
  at TEXT NOT NULL
);

-- The only record that changes a roster: who decided, what, for whom and when.
CREATE TABLE roster_decision (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- OPEN_SHIFT | EXCHANGE | LEAVE
  object_id TEXT NOT NULL,
  outcome TEXT NOT NULL,                -- ASSIGNED | REASSIGNED | DECLINED | APPROVED
  subject_worker_id TEXT,
  roster_shift_id TEXT,
  decided_by TEXT NOT NULL,
  work_context_id TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);

CREATE TRIGGER roster_decision_no_update BEFORE UPDATE ON roster_decision
BEGIN SELECT RAISE(ABORT, 'roster_decision is append-only'); END;
CREATE TRIGGER roster_decision_no_delete BEFORE DELETE ON roster_decision
BEGIN SELECT RAISE(ABORT, 'roster_decision is append-only'); END;
`,
  },
  {
    version: 3,
    name: 'transfers',
    sql: `
-- Beds are physical capacity. A bed's state never implies who is responsible for a person.
CREATE TABLE bed (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES service(id),
  label TEXT NOT NULL,
  state TEXT NOT NULL,                  -- AVAILABLE | RESERVED | OCCUPIED | CLEANING
  person_id TEXT REFERENCES person(id),
  updated_at TEXT NOT NULL,
  UNIQUE (service_id, label)
);

-- Transfer of care / admission (Shared Lifecycle Objects 220 and 221). Acceptance, bed,
-- arrival and responsibility are separate recorded steps; none implies the next.
CREATE TABLE transfer (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  kind TEXT NOT NULL,                   -- ADMISSION | TRANSFER
  from_service_id TEXT NOT NULL REFERENCES service(id),
  from_encounter_id TEXT REFERENCES encounter(id),
  to_service_id TEXT NOT NULL REFERENCES service(id),
  reason TEXT NOT NULL,
  priority TEXT NOT NULL,               -- ROUTINE | URGENT
  state TEXT NOT NULL,                  -- REQUESTED | ACCEPTED | DECLINED | CANCELLED | BED_ALLOCATED | ARRIVED | RESPONSIBILITY_ACCEPTED
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  accepted_by TEXT,
  bed_id TEXT REFERENCES bed(id),
  to_encounter_id TEXT REFERENCES encounter(id),
  responsible_by TEXT,
  note TEXT
);
`,
  },
  {
    version: 4,
    name: 'discharge',
    sql: `
-- Discharge (Shared Lifecycle Object 222). Considering, deciding and discharging are
-- separate acts; each outstanding requirement is recorded by the person who met it.
CREATE TABLE discharge (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  encounter_id TEXT NOT NULL REFERENCES encounter(id),
  destination TEXT NOT NULL,
  expected_date TEXT,
  state TEXT NOT NULL,                  -- CONSIDERED | DECIDED | DISCHARGED | CANCELLED
  considered_by TEXT NOT NULL,
  considered_at TEXT NOT NULL,
  decided_by TEXT,
  discharged_by TEXT,
  discharged_at TEXT,
  note TEXT
);

CREATE TABLE discharge_requirement (
  id TEXT PRIMARY KEY,
  discharge_id TEXT NOT NULL REFERENCES discharge(id),
  code TEXT NOT NULL,                   -- readiness | medicines | summary | whanau | followup | destination
  status TEXT NOT NULL,                 -- DONE | NOT_APPLICABLE
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (discharge_id, code)
);
`,
  },
  {
    version: 5,
    name: 'escalation',
    sql: `
-- Escalation (Shared Lifecycle Object 225). Raised by the person who is worried, addressed
-- to a role in the service responsible for the person. Received, acknowledged and responded
-- are separate acts; the raiser's reassessment resolves it or escalates further.
CREATE TABLE escalation (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),     -- service responsible for the person
  recipient_role_key TEXT NOT NULL,
  urgency TEXT NOT NULL,                -- IMMEDIATE | URGENT | ROUTINE
  concern TEXT NOT NULL,
  trigger_text TEXT NOT NULL,           -- what changed, in the raiser's words
  state TEXT NOT NULL,                  -- RAISED | RECEIVED | ACKNOWLEDGED | RESPONDED | RESOLVED | ESCALATED
  raised_by TEXT NOT NULL,
  raised_service_id TEXT NOT NULL REFERENCES service(id),
  raised_at TEXT NOT NULL,
  parent_id TEXT REFERENCES escalation(id),
  level INTEGER NOT NULL DEFAULT 1,
  received_by TEXT,
  acknowledged_by TEXT,
  response TEXT,
  responded_by TEXT,
  reassessment TEXT,
  reassessed_by TEXT,
  closed_at TEXT
);
`,
  },
];
