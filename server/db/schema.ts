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
  {
    version: 6,
    name: 'consultation',
    sql: `
-- Clinical consultation (Shared Lifecycle Object 240). Advice, not a transfer: the requesting
-- team stays responsible. Received, accepted, advised and advice received are separate acts.
CREATE TABLE consultation (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  from_service_id TEXT NOT NULL REFERENCES service(id),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  to_service_id TEXT NOT NULL REFERENCES service(id),
  to_role_key TEXT NOT NULL,
  question TEXT NOT NULL,
  urgency TEXT NOT NULL,                -- URGENT | ROUTINE
  state TEXT NOT NULL,                  -- REQUESTED | RECEIVED | ACCEPTED | DECLINED | ADVISED | ADVICE_RECEIVED | CLOSED | WITHDRAWN
  received_by TEXT,
  accepted_by TEXT,
  decline_reason TEXT,
  advice TEXT,
  advised_by TEXT,
  advised_at TEXT,
  advice_received_by TEXT,
  actions TEXT,
  closed_by TEXT,
  closed_at TEXT
);
`,
  },
  {
    version: 7,
    name: 'wounds',
    sql: `
-- Wound (Shared Lifecycle Object 213): identified → assessed → treatment plan → serial
-- reassessment → healed or closed. Each assessment is also a .wound entry in the record.
CREATE TABLE wound (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  site TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,                  -- IDENTIFIED | ASSESSED | PLANNED | HEALED | CLOSED
  identified_by TEXT NOT NULL,
  identified_at TEXT NOT NULL,
  description TEXT,
  plan TEXT,
  review_days INTEGER,
  plan_by TEXT,
  plan_at TEXT,
  next_review TEXT,
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);

CREATE TABLE wound_assessment (
  id TEXT PRIMARY KEY,
  wound_id TEXT NOT NULL REFERENCES wound(id),
  event_id TEXT REFERENCES clinical_event(id),
  assessed_by TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  length_mm INTEGER,
  width_mm INTEGER,
  depth_mm INTEGER,
  stage TEXT,
  bed TEXT,
  exudate TEXT,
  surrounding TEXT,
  pain INTEGER,
  trend TEXT,                           -- FIRST | IMPROVING | STATIC | DETERIORATING
  complication TEXT,
  dressing TEXT,
  note TEXT
);
`,
  },
  {
    version: 8,
    name: 'care plan lifecycle',
    sql: `
-- Care plan (Shared Lifecycle Object 216): need → goal → interventions → responsible →
-- review date → reassessment → modification (superseded, never overwritten) →
-- achieved / ceased.
ALTER TABLE care_plan_item ADD COLUMN service_id TEXT REFERENCES service(id);
ALTER TABLE care_plan_item ADD COLUMN author_id TEXT;
ALTER TABLE care_plan_item ADD COLUMN supersedes_id TEXT REFERENCES care_plan_item(id);
ALTER TABLE care_plan_item ADD COLUMN closed_by TEXT;
ALTER TABLE care_plan_item ADD COLUMN closed_at TEXT;
ALTER TABLE care_plan_item ADD COLUMN close_reason TEXT;
UPDATE care_plan_item SET service_id = (
  SELECT e.service_id FROM encounter e WHERE e.person_id = care_plan_item.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1
) WHERE service_id IS NULL;

CREATE TABLE care_plan_review (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES care_plan_item(id),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  outcome TEXT NOT NULL,                -- CONTINUE | MODIFIED | ACHIEVED | CEASED
  evaluation TEXT NOT NULL,
  next_review TEXT
);
`,
  },
  {
    version: 9,
    name: 'referral lifecycle',
    sql: `
-- Referral (Shared Lifecycle Object 203): draft → authorised → sent → received → triaged →
-- accepted, declined or redirected → scheduled → seen → responsibility accepted where
-- applicable → outcome → closed. Clinical information is referenced by event lineage,
-- never copied into the referral.
CREATE TABLE referral (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  from_service_id TEXT NOT NULL REFERENCES service(id),
  to_service_id TEXT NOT NULL REFERENCES service(id),
  parent_id TEXT REFERENCES referral(id),   -- the referral this one was redirected from
  reason TEXT NOT NULL,
  request TEXT NOT NULL,                    -- what the referrer is asking the service to do
  priority TEXT NOT NULL,                   -- priority the referrer asked for: URGENT | SEMI_URGENT | ROUTINE
  patient_aware INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  drafted_by TEXT NOT NULL,
  drafted_at TEXT NOT NULL,
  authorised_by TEXT,
  sent_at TEXT,
  received_by TEXT,
  triaged_by TEXT,
  triage_priority TEXT,
  triage_note TEXT,
  decided_by TEXT,
  decision_note TEXT,
  scheduled_for TEXT,
  scheduled_by TEXT,
  seen_by TEXT,
  seen_at TEXT,
  seen_note TEXT,
  responsibility_by TEXT,
  care_relationship_id TEXT REFERENCES care_relationship(id),
  outcome TEXT,
  outcome_by TEXT,
  outcome_at TEXT,
  closed_by TEXT,
  closed_at TEXT
);
CREATE INDEX referral_person ON referral(person_id);
CREATE INDEX referral_to ON referral(to_service_id, state);

CREATE TABLE referral_evidence (
  referral_id TEXT NOT NULL REFERENCES referral(id),
  event_lineage_id TEXT NOT NULL,
  PRIMARY KEY (referral_id, event_lineage_id)
);
`,
  },
  {
    version: 10,
    name: 'appointment lifecycle',
    sql: `
-- Appointment (Shared Lifecycle Object 208): requested (the service's waitlist) → offered →
-- booked → confirmed → arrived → commenced → completed, or cancelled, did not attend or
-- unable to complete → follow-up requirement.
CREATE TABLE appointment (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  referral_id TEXT REFERENCES referral(id),
  previous_id TEXT REFERENCES appointment(id),  -- the appointment whose follow-up created this one
  reason TEXT NOT NULL,
  priority TEXT NOT NULL,                       -- URGENT | SEMI_URGENT | ROUTINE
  mode TEXT NOT NULL,                           -- IN_PERSON | PHONE | VIDEO
  state TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  start_at TEXT,                                -- local date and time, YYYY-MM-DDTHH:MM
  duration_min INTEGER,
  place TEXT,
  clinician_id TEXT,
  offered_by TEXT,
  booked_by TEXT,
  response_note TEXT,
  confirmed_by TEXT,
  arrived_by TEXT,
  arrived_at TEXT,
  commenced_by TEXT,
  commenced_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  end_note TEXT,
  follow_up TEXT                                -- NONE | ANOTHER
);
CREATE INDEX appointment_service ON appointment(service_id, state);
CREATE INDEX appointment_person ON appointment(person_id);
`,
  },
  {
    version: 11,
    name: 'alert lifecycle',
    sql: `
-- Alert (Shared Lifecycle Object 218): trigger condition → alert generated → visible to an
-- authorised recipient → acknowledged → action where required → resolved or expired.
-- Generated alerts come from recorded facts (a laboratory's own abnormal flag, a review
-- date that has passed); SHIFT sets no clinical thresholds of its own. Raised alerts are
-- safety or communication alerts a worker records about a person.
CREATE TABLE alert (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),  -- recipient service
  capability TEXT NOT NULL,                          -- recipients: roles in the service with this capability
  rule TEXT NOT NULL,                                -- RESULT_ABNORMAL | WOUND_REVIEW_OVERDUE | CAREPLAN_REVIEW_OVERDUE | RAISED
  object_type TEXT,
  object_id TEXT,
  category TEXT,                                     -- raised alerts: SAFETY | CLINICAL | COMMUNICATION
  title TEXT NOT NULL,
  detail TEXT,
  state TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  raised_by TEXT,
  visible_at TEXT,
  visible_to TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  action_note TEXT,
  actioned_by TEXT,
  actioned_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution TEXT,
  expires_on TEXT
);
CREATE INDEX alert_service ON alert(service_id, state);
CREATE INDEX alert_person ON alert(person_id, state);
CREATE INDEX alert_object ON alert(rule, object_id);
`,
  },
  {
    version: 12,
    name: 'communication lifecycle',
    sql: `
-- Communication (Shared Lifecycle Object 224): communication required → intended recipient
-- → method → attempted → successful / unsuccessful → information conveyed → response →
-- follow-up required / completed. Every attempt is kept, including the ones that failed.
CREATE TABLE communication (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  purpose TEXT NOT NULL,                 -- what needs to be conveyed
  recipient_kind TEXT NOT NULL,          -- PATIENT | WHANAU | EXTERNAL_PROVIDER | TEAM
  recipient TEXT NOT NULL,               -- who, in words
  contact TEXT,                          -- how to reach them
  method TEXT NOT NULL,                  -- PHONE | IN_PERSON | VIDEO | TEXT | EMAIL | LETTER
  language TEXT,                         -- interpreter language, when one is needed
  sharing TEXT,                          -- patient's view on sharing: AGREED | DECLINED | UNABLE | NOT_ASKED
  due_at TEXT,                           -- local date and time, YYYY-MM-DDTHH:MM
  state TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  conveyed TEXT,
  response TEXT,
  follow_up TEXT,
  completed_by TEXT,
  completed_at TEXT,
  completion_note TEXT
);
CREATE INDEX communication_service ON communication(service_id, state);
CREATE INDEX communication_person ON communication(person_id);

CREATE TABLE communication_attempt (
  id TEXT PRIMARY KEY,
  communication_id TEXT NOT NULL REFERENCES communication(id),
  attempted_by TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  method TEXT NOT NULL,
  outcome TEXT NOT NULL,                 -- CONVEYED | NO_ANSWER | LEFT_MESSAGE | WRONG_CONTACT | NOT_AVAILABLE | DECLINED
  note TEXT
);
`,
  },
  {
    version: 13,
    name: 'monitoring plan lifecycle',
    sql: `
-- Monitoring plan (Shared Lifecycle Object 242): monitoring requirement → parameter →
-- method → frequency → threshold or target → responsible → monitoring events → result →
-- review → action → continue, change (superseded, never overwritten) or stop. Limits and
-- targets are the clinician's words; SHIFT does not set or apply thresholds itself.
CREATE TABLE monitoring_plan (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  parameter TEXT NOT NULL,              -- OBS | BGL | WEIGHT | PAIN | INTAKE
  reason TEXT NOT NULL,
  method TEXT,
  frequency_hours INTEGER NOT NULL,
  limits TEXT,                          -- clinician-set: when to act, and who to tell
  target TEXT,
  responsible TEXT NOT NULL,
  review_date TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | SUPERSEDED | CEASED
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  supersedes_id TEXT REFERENCES monitoring_plan(id),
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX monitoring_service ON monitoring_plan(service_id, state);
CREATE INDEX monitoring_person ON monitoring_plan(person_id, state);

CREATE TABLE monitoring_review (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES monitoring_plan(id),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  outcome TEXT NOT NULL,                -- CONTINUE | CHANGED | STOPPED
  finding TEXT NOT NULL,
  action TEXT
);
`,
  },
  {
    version: 14,
    name: 'clinical restriction lifecycle',
    sql: `
-- Clinical restriction / precaution (Shared Lifecycle Object 243): clinical need identified →
-- authorised restriction → parameters → effective time → communication → implementation →
-- review → modification (superseded, never overwritten) or cessation. Who may authorise each
-- kind is organisational configuration. Restraint is not recorded here (RR-RESTRAINT-001).
CREATE TABLE restriction (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,                   -- NBM | FLUIDS | WEIGHT_BEARING | LIMB | SPINAL | ACTIVITY | OTHER
  side TEXT,                            -- LEFT | RIGHT | BOTH, where the kind has one
  detail TEXT NOT NULL,                 -- the restriction itself, in the clinician's words
  instructions TEXT,                    -- what staff should do
  reason TEXT NOT NULL,
  patient_view TEXT NOT NULL,           -- AGREED | NOT_AGREED | UNABLE | NOT_YET
  effective_from TEXT NOT NULL,
  effective_until TEXT,
  review_date TEXT,
  state TEXT NOT NULL,                  -- PROPOSED | ACTIVE | DECLINED | SUPERSEDED | CEASED
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  authorised_by TEXT,
  authorised_at TEXT,
  supersedes_id TEXT REFERENCES restriction(id),
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX restriction_person ON restriction(person_id, state);
CREATE INDEX restriction_service ON restriction(service_id, state);

-- Communication: each worker who has read it. Implementation: checks that it is being followed.
CREATE TABLE restriction_ack (
  restriction_id TEXT NOT NULL REFERENCES restriction(id),
  worker_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (restriction_id, worker_id)
);
CREATE TABLE restriction_check (
  id TEXT PRIMARY KEY,
  restriction_id TEXT NOT NULL REFERENCES restriction(id),
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  followed INTEGER NOT NULL,
  note TEXT
);
CREATE TABLE restriction_review (
  id TEXT PRIMARY KEY,
  restriction_id TEXT NOT NULL REFERENCES restriction(id),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  outcome TEXT NOT NULL,                -- CONTINUE | CHANGED | STOPPED
  finding TEXT NOT NULL
);
`,
  },
  {
    version: 15,
    name: 'diet order lifecycle',
    sql: `
-- Nutrition / diet order (Shared Lifecycle Object 244): nutrition or swallowing requirement →
-- assessment → authorised diet → preparation and provision → delivery → intake → tolerance →
-- monitoring → review → modification (superseded, never overwritten) or cessation. Texture
-- and drink levels use the IDDSI framework names. SHIFT sets no nutritional targets itself.
CREATE TABLE diet_order (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  diets TEXT NOT NULL,                  -- comma-separated: STANDARD, DIABETIC, LOW_SALT, RENAL, HIGH_ENERGY, GLUTEN_FREE, VEGETARIAN, CULTURAL
  texture TEXT NOT NULL,                -- IDDSI food level: 7 | 7EC | 6 | 5 | 4 | 3
  drinks TEXT NOT NULL,                 -- IDDSI drink level: 0 | 1 | 2 | 3 | 4
  assistance TEXT NOT NULL,             -- INDEPENDENT | SET_UP | SUPERVISION | FULL
  supplements TEXT,
  preferences TEXT,                     -- likes, dislikes, cultural and religious needs, in the person's words
  assessment TEXT,                      -- the swallowing or nutrition assessment this rests on
  reason TEXT NOT NULL,
  review_date TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | SUPERSEDED | CEASED
  ordered_by TEXT NOT NULL,
  ordered_at TEXT NOT NULL,
  supersedes_id TEXT REFERENCES diet_order(id),
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX diet_person ON diet_order(person_id, state);
CREATE INDEX diet_service ON diet_order(service_id, state);

-- Each meal: provided and delivered (or withheld), how much was eaten, how it was tolerated.
CREATE TABLE meal_record (
  id TEXT PRIMARY KEY,
  diet_order_id TEXT NOT NULL REFERENCES diet_order(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  meal_date TEXT NOT NULL,
  meal TEXT NOT NULL,                   -- BREAKFAST | LUNCH | DINNER | SNACK
  outcome TEXT NOT NULL,                -- GIVEN | REFUSED | WITHHELD | AWAY
  intake TEXT,                          -- ALL | MOST | HALF | LITTLE | NONE
  tolerance TEXT,                       -- FINE | COUGHING | CHOKING | NAUSEA | OTHER
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX meal_person ON meal_record(person_id, meal_date);

CREATE TABLE diet_review (
  id TEXT PRIMARY KEY,
  diet_order_id TEXT NOT NULL REFERENCES diet_order(id),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  outcome TEXT NOT NULL,                -- CONTINUE | CHANGED | STOPPED
  finding TEXT NOT NULL
);
`,
  },
  {
    version: 16,
    name: 'clinical equipment lifecycle',
    sql: `
-- Clinical equipment (Shared Lifecycle Object 246): equipment identity → availability →
-- allocation → patient or service use → setup → safety check → use → fault → withdrawal or
-- quarantine → maintenance or repair → return to service → retirement.
CREATE TABLE equipment (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES service(id),
  asset_tag TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                   -- INFUSION_PUMP | PRESSURE_MATTRESS | HOIST | OBS_MONITOR | SUCTION | FEEDING_PUMP | OTHER
  description TEXT NOT NULL,
  service_due TEXT,                     -- next planned maintenance date
  state TEXT NOT NULL,                  -- AVAILABLE | IN_USE | QUARANTINED | IN_REPAIR | RETIRED
  added_by TEXT,
  added_at TEXT NOT NULL,
  retired_by TEXT,
  retired_at TEXT,
  retire_reason TEXT
);
CREATE INDEX equipment_service ON equipment(service_id, state);

CREATE TABLE equipment_use (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  settings TEXT,                        -- setup, in the clinician's words
  checked_note TEXT NOT NULL,           -- the check before use
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_by TEXT,
  ended_at TEXT,
  end_note TEXT
);
CREATE INDEX equipment_use_person ON equipment_use(person_id, ended_at);

CREATE TABLE equipment_event (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  kind TEXT NOT NULL,                   -- FAULT | SENT_FOR_REPAIR | RETURNED | NO_FAULT_FOUND | SERVICED
  note TEXT NOT NULL,
  person_id TEXT,                       -- the patient using it when a fault happened
  patient_affected INTEGER,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
);
`,
  },
  {
    version: 17,
    name: 'location and bed lifecycle',
    sql: `
-- Location / bed / care space (Shared Lifecycle Object 247): location requirement → placement
-- request → bed allocated → patient movement → arrival → occupied → movement → vacated.
-- Features describe the space; placement needs are matched against them and shown, never
-- enforced, because the person allocating may know more than the record.
ALTER TABLE bed ADD COLUMN features TEXT;

CREATE TABLE bed_occupancy (
  id TEXT PRIMARY KEY,
  bed_id TEXT NOT NULL REFERENCES bed(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL,
  from_at TEXT NOT NULL,
  until_at TEXT,
  reason_in TEXT,
  reason_out TEXT
);
CREATE INDEX bed_occupancy_person ON bed_occupancy(person_id, from_at);
CREATE INDEX bed_occupancy_bed ON bed_occupancy(bed_id, from_at);
INSERT INTO bed_occupancy (id, bed_id, person_id, service_id, from_at, reason_in)
  SELECT lower(hex(randomblob(16))), id, person_id, service_id, updated_at, 'Occupied when bed history began' FROM bed WHERE state = 'OCCUPIED' AND person_id IS NOT NULL;

CREATE TABLE bed_move (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  needs TEXT,                           -- comma-separated bed features the patient needs
  reason TEXT NOT NULL,
  urgency TEXT NOT NULL,                -- ROUTINE | TODAY | NOW
  state TEXT NOT NULL,                  -- REQUESTED | ALLOCATED | MOVED | CANCELLED
  from_bed_id TEXT,
  bed_id TEXT,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  allocated_by TEXT,
  allocated_at TEXT,
  allocation_note TEXT,
  moved_by TEXT,
  moved_at TEXT,
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX bed_move_service ON bed_move(service_id, state);
`,
  },
  {
    version: 18,
    name: 'leave and temporary absence lifecycle',
    sql: `
-- Leave / temporary absence (Shared Lifecycle Object 248): leave considered or requested →
-- clinical or legal authority where applicable → conditions → authorised → departure → current
-- absence → expected return → return, or failure or delay to return → reassessment.
-- Who may approve is organisational configuration. Leave for a person under a legal order is
-- recorded but not approved in SHIFT until RR-LEAVE-001 is researched.
CREATE TABLE leave_of_absence (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,                   -- OUTING | DAY | OVERNIGHT | WEEKEND | TRIAL | OTHER
  purpose TEXT NOT NULL,
  destination TEXT,
  companion TEXT,                       -- who they are going with
  contact TEXT,                         -- how to reach them while away
  conditions TEXT,                      -- medicines, supports, limits and when to come back early
  legal TEXT NOT NULL,                  -- NONE | ORDER | UNSURE
  leave_at TEXT NOT NULL,               -- planned departure
  return_by TEXT NOT NULL,              -- expected return, moved on when leave is extended
  state TEXT NOT NULL,                  -- REQUESTED | APPROVED | DECLINED | AWAY | NOT_RETURNED | RETURNED | CANCELLED
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  departed_by TEXT,
  departed_at TEXT,
  departure_note TEXT,
  returned_by TEXT,
  returned_at TEXT,
  return_note TEXT,                     -- reassessment on return
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX leave_person ON leave_of_absence(person_id, state);
CREATE INDEX leave_service ON leave_of_absence(service_id, state);

-- Anything that happens while the person is away: extended, contact made, not back on time.
CREATE TABLE leave_event (
  id TEXT PRIMARY KEY,
  leave_id TEXT NOT NULL REFERENCES leave_of_absence(id),
  kind TEXT NOT NULL,                   -- EXTENDED | CONTACT | NOT_RETURNED
  note TEXT NOT NULL,
  return_by TEXT,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
);
`,
  },
  {
    version: 19,
    name: 'patient preference lifecycle',
    sql: `
-- Patient preference (Shared Lifecycle Object 249): preference expressed → context and source →
-- current relevance → acknowledged → incorporated where possible → reviewed, changed or
-- withdrawn. A preference is kept in the person's words. It is not consent and not an advance
-- directive (RR-ADVDIR-001).
CREATE TABLE preference (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  category TEXT NOT NULL,               -- NAME | ROUTINE | PERSONAL_CARE | FOOD | CULTURAL | SPIRITUAL | COMMUNICATION | PRIVACY | TREATMENT | OTHER
  statement TEXT NOT NULL,              -- in the person's words
  source TEXT NOT NULL,                 -- PERSON | WHANAU | SUPPORT_PERSON | OBSERVED | DOCUMENT
  source_name TEXT,                     -- who said it, when not the person
  context TEXT,                         -- when or where it applies
  relevance TEXT NOT NULL,              -- ALWAYS | THIS_STAY | SOMETIMES
  review_date TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | SUPERSEDED | WITHDRAWN
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  supersedes_id TEXT REFERENCES preference(id),
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX preference_person ON preference(person_id, state);

CREATE TABLE preference_ack (
  preference_id TEXT NOT NULL REFERENCES preference(id),
  worker_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (preference_id, worker_id)
);

-- Whether it could be followed, each time it mattered.
CREATE TABLE preference_outcome (
  id TEXT PRIMARY KEY,
  preference_id TEXT NOT NULL REFERENCES preference(id),
  outcome TEXT NOT NULL,                -- MET | PARTLY | NOT_MET
  note TEXT,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
);
`,
  },
  {
    version: 20,
    name: 'decision-making capacity assessment lifecycle',
    sql: `
-- Decision-making capacity assessment (Shared Lifecycle Object 251): decision requiring
-- assessment → reason for concern → functional assessment → communication and support measures
-- → determination within the applicable framework → the decision and time it covers →
-- reassessment. Capacity is presumed and is about one decision at one time. What follows in law
-- from a finding (who then decides) is a research requirement (RR-CAP-001).
CREATE TABLE capacity_assessment (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  decision TEXT NOT NULL,               -- the specific decision, in plain words
  decision_kind TEXT NOT NULL,          -- TREATMENT | LIVING | DISCHARGE | PERSONAL_CARE | MONEY | OTHER
  concern TEXT NOT NULL,                -- why capacity for this decision is in question
  state TEXT NOT NULL,                  -- RAISED | DETERMINED | WITHDRAWN | SUPERSEDED
  raised_by TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  understand TEXT,                      -- YES | NO | UNSURE: understands the information relevant to the decision
  retain TEXT,                          -- retains it long enough to decide
  weigh TEXT,                           -- uses or weighs it
  communicate TEXT,                     -- communicates a decision by any means
  findings TEXT,                        -- what was asked and what the person said
  supports TEXT,                        -- communication and support measures used
  present TEXT,                         -- who else was there
  determination TEXT,                   -- HAS | LACKS | NOT_YET
  determination_note TEXT,
  assessed_by TEXT,
  assessed_at TEXT,
  reassess_by TEXT,
  supersedes_id TEXT REFERENCES capacity_assessment(id),
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX capacity_person ON capacity_assessment(person_id, state);
CREATE INDEX capacity_service ON capacity_assessment(service_id, state);
`,
  },
  {
    version: 21,
    name: 'whanau and support person involvement',
    sql: `
-- Whānau / family / support-person involvement (Shared Lifecycle Object 252): person identity →
-- relationship → the patient's wishes → involvement asked for or allowed → what may be shared →
-- decision-making authority where independently established → contacts → changes and limits.
-- Sharing without the person's agreement, and whether a legal authority is in effect, are
-- research requirements (RR-WHANAU-001, RR-CAP-001).
CREATE TABLE support_person (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  name TEXT NOT NULL,
  relationship TEXT NOT NULL,           -- PARTNER | CHILD | PARENT | SIBLING | GRANDCHILD | WHANAU | FRIEND | ADVOCATE | OTHER
  relationship_note TEXT,
  phone TEXT,
  first_contact INTEGER NOT NULL DEFAULT 0,
  wishes TEXT NOT NULL,                 -- ASKED | NOT_ABLE | NOT_YET: whether the person has said what they want
  share TEXT NOT NULL,                  -- ALL | GENERAL | NOTHING | UNKNOWN: what the person agrees can be shared with them
  involve TEXT,                         -- what the person wants them involved in, in their words
  limits TEXT,                          -- anything this person must not be told or do
  authority TEXT NOT NULL,              -- NONE | EPOA_CARE | EPOA_PROPERTY | WELFARE_GUARDIAN | OTHER
  authority_ref TEXT,                   -- the document seen
  authority_seen_by TEXT,
  authority_seen_at TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | ENDED
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX support_person_person ON support_person(person_id, state);

-- Every contact with them: who, how, what was talked about and what was shared.
CREATE TABLE support_contact (
  id TEXT PRIMARY KEY,
  support_person_id TEXT NOT NULL REFERENCES support_person(id),
  kind TEXT NOT NULL,                   -- WE_CALLED | THEY_CALLED | VISIT | MEETING | MESSAGE
  summary TEXT NOT NULL,
  shared TEXT NOT NULL,                 -- HEALTH | NONE: whether health information was shared
  by_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX support_contact_person ON support_contact(support_person_id, at);
`,
  },
  {
    version: 22,
    name: 'interpreter and communication accessibility lifecycle',
    sql: `
-- Interpreter / communication accessibility requirement (Shared Lifecycle Object 253): need
-- identified → requirement recorded → service arrangement → interpreter or support booked →
-- provided → outcome → continuing requirement reviewed. Code of Rights Right 5 (LAW-NZ-005).
CREATE TABLE comm_need (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  kind TEXT NOT NULL,                   -- INTERPRETER | NZSL | HEARING | VISION | SPEECH | UNDERSTANDING | READING | OTHER
  language TEXT,                        -- for a spoken-language interpreter
  detail TEXT NOT NULL,                 -- what helps, in plain words
  when_needed TEXT NOT NULL,            -- ALWAYS | IMPORTANT | SOMETIMES
  review_date TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | ENDED
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX comm_need_person ON comm_need(person_id, state);

CREATE TABLE interpreter_booking (
  id TEXT PRIMARY KEY,
  need_id TEXT NOT NULL REFERENCES comm_need(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  purpose TEXT NOT NULL,
  mode TEXT NOT NULL,                   -- IN_PERSON | PHONE | VIDEO
  needed_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- REQUESTED | BOOKED | PROVIDED | NOT_PROVIDED | CANCELLED
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  provider TEXT,                        -- interpreting service
  reference TEXT,                       -- booking reference
  interpreter TEXT,                     -- interpreter's name, when known
  booked_by TEXT,
  booked_at TEXT,
  outcome TEXT,                         -- what happened, whether it was understood
  family_interpreted INTEGER NOT NULL DEFAULT 0,
  closed_by TEXT,
  closed_at TEXT
);
CREATE INDEX interpreter_booking_service ON interpreter_booking(service_id, state);
CREATE INDEX interpreter_booking_person ON interpreter_booking(person_id, needed_at);
`,
  },
  {
    version: 23,
    name: 'external and imported clinical information lifecycle',
    sql: `
-- External / imported clinical information (Shared Lifecycle Object 254): external information
-- received → patient matching → source identified → integrity/provenance retained → authorised
-- availability → clinical review → incorporated or referenced → amendment/update from source.
-- The content is never edited after receipt; its SHA-256 is kept to show it is unchanged.
CREATE TABLE external_info (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES service(id),   -- the service it was sent to
  person_id TEXT REFERENCES person(id),              -- set only once matched
  source_org TEXT NOT NULL,                          -- who sent it
  source_author TEXT,                                -- who wrote it at the source
  source_kind TEXT NOT NULL,                         -- DISCHARGE_SUMMARY | GP_LETTER | SPECIALIST_LETTER | RESULT | MEDICINES | AMBULANCE | CARE_PLAN | OTHER
  channel TEXT NOT NULL,                             -- ELECTRONIC | EMAIL | FAX | POST | HAND
  written_at TEXT,                                   -- date written at the source
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  stated_name TEXT NOT NULL,                         -- identity as the sender gave it
  stated_nhi TEXT,
  stated_dob TEXT,
  state TEXT NOT NULL,                               -- RECEIVED | MATCHED | INCORPORATED | REFERENCED | NOT_OURS | SUPERSEDED
  received_by TEXT NOT NULL,
  received_at TEXT NOT NULL,
  matched_by TEXT,
  matched_at TEXT,
  match_checks TEXT,                                 -- which identifiers agreed, e.g. NHI,DOB,NAME
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_summary TEXT,                               -- what matters in it, in the reviewer's words
  outcome_note TEXT,                                 -- what was done with it
  not_ours_by TEXT,
  not_ours_at TEXT,
  not_ours_reason TEXT,
  supersedes TEXT REFERENCES external_info(id),      -- the earlier version this updates
  superseded_by TEXT REFERENCES external_info(id)
);
CREATE INDEX external_info_person ON external_info(person_id, received_at);
CREATE INDEX external_info_service ON external_info(service_id, state);
`,
  },
  {
    version: 24,
    name: 'clinical coding lifecycle',
    sql: `
-- Clinical coding / classification (Shared Lifecycle Object 255): source clinical information →
-- coding requirement → code assignment → validation → finalised coding → amendment where
-- appropriate. Codes are checked for form only until the official code tables are sourced
-- (RR-CODE-001).
CREATE TABLE coding_case (
  id TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL UNIQUE REFERENCES encounter(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),   -- the service whose episode is coded
  organisation_id TEXT NOT NULL REFERENCES organisation(id),
  state TEXT NOT NULL,                  -- REQUIRED | IN_PROGRESS | FINALISED
  required_at TEXT NOT NULL,
  required_reason TEXT NOT NULL,
  coder_id TEXT,                        -- who is coding it
  started_at TEXT,
  finalised_by TEXT,
  finalised_at TEXT,
  amendments INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX coding_case_org ON coding_case(organisation_id, state);
CREATE INDEX coding_case_person ON coding_case(person_id);

CREATE TABLE coding_entry (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES coding_case(id),
  system TEXT NOT NULL,                 -- ICD10AM | ACHI | SNOMEDCT
  code TEXT NOT NULL,
  term TEXT NOT NULL,
  role TEXT NOT NULL,                   -- PRINCIPAL | ADDITIONAL | PROCEDURE
  source_event_id TEXT REFERENCES clinical_event(id),
  source_note TEXT,                     -- where in the record it comes from, when not one event
  state TEXT NOT NULL,                  -- ACTIVE | REMOVED
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_by TEXT,
  removed_at TEXT,
  removed_reason TEXT
);
CREATE INDEX coding_entry_case ON coding_entry(case_id, state);

CREATE TABLE coding_query (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES coding_case(id),
  service_id TEXT NOT NULL REFERENCES service(id),   -- the clinical service asked
  question TEXT NOT NULL,
  state TEXT NOT NULL,                  -- OPEN | ANSWERED | WITHDRAWN
  asked_by TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  answer TEXT,
  answered_by TEXT,
  answered_at TEXT
);
CREATE INDEX coding_query_service ON coding_query(service_id, state);
`,
  },
  {
    version: 25,
    name: 'patient-reported information lifecycle',
    sql: `
-- Patient-reported information (Shared Lifecycle Object 256): patient report → source/time/
-- context → structured or narrative information → clinical review where applicable →
-- incorporated into assessment/decision where appropriate → updated/corrected by source.
-- What the person said is kept in their words. A later update or correction from them replaces
-- it as current and the earlier version is kept (HIPC 2020 rule 7, LAW-NZ-002).
CREATE TABLE patient_report (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,             -- the same report across updates and corrections
  version INTEGER NOT NULL,
  supersedes TEXT REFERENCES patient_report(id),
  change_kind TEXT,                     -- UPDATE (things changed) | CORRECTION (it was wrong)
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  source TEXT NOT NULL,                 -- PATIENT | WHANAU | FORM
  source_name TEXT,                     -- who, when not the person themselves
  how TEXT NOT NULL,                    -- IN_PERSON | PHONE | VIDEO | WRITTEN | INTERPRETER
  topic TEXT NOT NULL,                  -- SYMPTOM | PAIN | SLEEP | MOOD | EATING | TOILETING | MOBILITY | MEDICINES | GOALS | WORRIES | OTHER
  words TEXT NOT NULL,                  -- in their own words
  rating INTEGER,                       -- 0-10, where the topic has one
  about_when TEXT,                      -- the time it is about, e.g. "last night"
  reported_at TEXT NOT NULL,            -- when they said it
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  needs_review INTEGER NOT NULL,
  state TEXT NOT NULL,                  -- RECORDED | REVIEWED | SUPERSEDED
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_outcome TEXT,                  -- INCORPORATED | NOTED
  review_note TEXT
);
CREATE INDEX patient_report_person ON patient_report(person_id, state);
CREATE INDEX patient_report_service ON patient_report(service_id, needs_review, state);
`,
  },
  {
    version: 26,
    name: 'questionnaire and assessment instrument lifecycle',
    sql: `
-- Questionnaire / assessment instrument (Shared Lifecycle Object 257): instrument required or
-- offered → version identified → administered → responses → score/result → interpretation →
-- clinical action where applicable → repeat assessment. Instruments are defined in
-- server/config/instruments.ts; each use keeps the code and version that produced its score.
CREATE TABLE instrument_use (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  instrument_code TEXT NOT NULL,
  instrument_version TEXT NOT NULL,
  state TEXT NOT NULL,                  -- REQUESTED | COMPLETED | INTERPRETED | DECLINED | CANCELLED
  reason TEXT NOT NULL,                 -- why it is being used
  due_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  repeat_of TEXT REFERENCES instrument_use(id),
  mode TEXT,                            -- STAFF_ASKED | SELF_COMPLETED | INTERPRETER | OBSERVED
  administered_by TEXT,
  administered_at TEXT,
  responses_json TEXT,                  -- item id → chosen option index
  score INTEGER,
  band TEXT,
  flags_json TEXT,                      -- safety flags raised by the responses
  interpreted_by TEXT,
  interpreted_at TEXT,
  interpretation TEXT,
  action TEXT,                          -- what was done because of it
  next_id TEXT REFERENCES instrument_use(id),
  closed_reason TEXT                    -- declined or cancelled, and why
);
CREATE INDEX instrument_use_person ON instrument_use(person_id, instrument_code, state);
CREATE INDEX instrument_use_service ON instrument_use(service_id, state, due_at);
`,
  },
  {
    version: 27,
    name: 'functional status lifecycle',
    sql: `
-- Functional status (Shared Lifecycle Object 261): baseline → current assessment → assistance
-- requirement → intervention → reassessment → changed/current state. An assessment records the
-- level of help for each everyday activity (server/config/function.ts). The newest BASELINE
-- (their usual function) and the newest CURRENT one are in force; earlier ones are SUPERSEDED.
CREATE TABLE function_assessment (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,                   -- BASELINE | CURRENT
  state TEXT NOT NULL,                  -- CURRENT | SUPERSEDED | ENTERED_IN_ERROR
  source TEXT,                          -- for a baseline: who it came from
  source_name TEXT,
  entries_json TEXT NOT NULL,           -- activity → { level, aid, note }
  summary TEXT,
  assessed_by TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  review_due TEXT,                      -- when to reassess (CURRENT only)
  supersedes TEXT REFERENCES function_assessment(id),
  error_reason TEXT
);
CREATE INDEX function_assessment_person ON function_assessment(person_id, kind, state);
-- What is being done to keep or improve an activity, and how it went.
CREATE TABLE function_intervention (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  activity TEXT NOT NULL,
  what TEXT NOT NULL,
  state TEXT NOT NULL,                  -- PLANNED | IN_PLACE | STOPPED
  planned_by TEXT NOT NULL,
  planned_at TEXT NOT NULL,
  started_by TEXT,
  started_at TEXT,
  stopped_by TEXT,
  stopped_at TEXT,
  outcome TEXT
);
CREATE INDEX function_intervention_person ON function_intervention(person_id, state);
`,
  },
  {
    version: 28,
    name: 'baseline and usual state lifecycle',
    sql: `
-- Baseline / usual state (Shared Lifecycle Object 262): usual state → current difference →
-- action → outcome. Areas are defined in server/config/usual.ts. One CURRENT usual per area;
-- a new usual SUPERSEDES the old one and keeps it.
CREATE TABLE usual_state (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  domain TEXT NOT NULL,
  statement TEXT,                       -- in words
  low REAL,                             -- usual range, for measurements
  high REAL,
  source TEXT NOT NULL,                 -- PERSON | WHANAU | PRIOR_RECORD | STAFF
  source_name TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- CURRENT | SUPERSEDED | ENTERED_IN_ERROR
  supersedes TEXT REFERENCES usual_state(id),
  error_reason TEXT
);
CREATE INDEX usual_state_person ON usual_state(person_id, domain, state);
-- Something different from usual: noticed → acted on → closed with how it ended.
CREATE TABLE usual_difference (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  domain TEXT NOT NULL,
  usual_id TEXT REFERENCES usual_state(id),
  usual_text TEXT,                      -- the usual as it stood when the difference was noticed
  now_text TEXT NOT NULL,
  noticed_by TEXT NOT NULL,
  noticed_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- NOTICED | ACTING | CLOSED
  action TEXT,
  acted_by TEXT,
  acted_at TEXT,
  outcome TEXT,                         -- BACK_TO_USUAL | NEW_USUAL | ELSEWHERE
  outcome_note TEXT,
  closed_by TEXT,
  closed_at TEXT,
  new_usual_id TEXT REFERENCES usual_state(id)
);
CREATE INDEX usual_difference_person ON usual_difference(person_id, state);
`,
  },
  {
    version: 29,
    name: 'named clinician and team assignment lifecycle',
    sql: `
-- Named clinician / team assignment (Shared Lifecycle Object 265): assignment required →
-- proposed → confirmed → active → changed/covered → ended. Kinds are defined in
-- server/config/assignments.ts. A cover is its own assignment (cover_for) with an end time; a
-- handover is a new one that replaces the old when it becomes active.
CREATE TABLE assignment (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,
  assignee_id TEXT REFERENCES workforce_person(id),   -- a SHIFT worker
  external_name TEXT,                   -- or someone outside SHIFT, e.g. a GP
  external_org TEXT,
  team_name TEXT,                       -- or a team
  state TEXT NOT NULL,                  -- PROPOSED | CONFIRMED | ACTIVE | ENDED | DECLINED
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  reason TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,                         -- planned end, for a cover
  confirmed_by TEXT,
  confirmed_at TEXT,
  confirm_note TEXT,
  activated_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  end_reason TEXT,
  replaces TEXT REFERENCES assignment(id),
  cover_for TEXT REFERENCES assignment(id),
  declined_by TEXT,
  declined_at TEXT,
  decline_reason TEXT
);
CREATE INDEX assignment_person ON assignment(person_id, kind, state);
CREATE INDEX assignment_assignee ON assignment(assignee_id, state);
`,
  },
  {
    version: 30,
    name: 'patient allocation lifecycle',
    sql: `
-- Patient allocation (Shared Lifecycle Object 266): patient requires care → staffing/team
-- context → proposed allocation → senior/authorised review → confirmed allocation → active
-- assignment → change/reallocation → handover/end. A plan covers one service and one shift;
-- its allocation rows are the patients each staff member has. Rows written before plans
-- existed are LEGACY and count for their date only.
CREATE TABLE allocation_plan (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES service(id),
  shift_date TEXT NOT NULL,
  period TEXT NOT NULL,                 -- AM | PM | NIGHT (server/config/allocation.ts)
  state TEXT NOT NULL,                  -- DRAFT | SUBMITTED | CONFIRMED | ACTIVE | ENDED | CANCELLED
  staff_json TEXT NOT NULL DEFAULT '[]', -- [{ id, onRoster, reason }]
  drafted_by TEXT NOT NULL REFERENCES workforce_person(id),
  drafted_at TEXT NOT NULL,
  submitted_by TEXT,
  submitted_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  started_by TEXT,
  started_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  end_note TEXT
);
CREATE INDEX allocation_plan_service ON allocation_plan(service_id, state);
ALTER TABLE allocation ADD COLUMN plan_id TEXT REFERENCES allocation_plan(id);
ALTER TABLE allocation ADD COLUMN state TEXT NOT NULL DEFAULT 'LEGACY'; -- PROPOSED | ACTIVE | ENDED | LEGACY
ALTER TABLE allocation ADD COLUMN ended_at TEXT;
ALTER TABLE allocation ADD COLUMN end_reason TEXT;
ALTER TABLE allocation ADD COLUMN reallocated_from TEXT REFERENCES allocation(id);
ALTER TABLE allocation ADD COLUMN move_reason TEXT;
CREATE INDEX allocation_plan_lines ON allocation(plan_id, state);
CREATE INDEX allocation_worker ON allocation(workforce_person_id, state);
`,
  },
  {
    version: 31,
    name: 'clinical status and acuity lifecycle',
    sql: `
-- Clinical status / acuity (Shared Lifecycle Object 267): clinical evidence → acuity
-- assessment → current status → escalation/resource implications → reassessment → changed
-- status. A clinician's judgement with its basis and a snapshot of the evidence SHIFT held;
-- levels are in server/config/acuity.ts. No score is calculated (RR-EWS-001, RR-ACU-001).
CREATE TABLE acuity_assessment (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  level TEXT NOT NULL,                  -- STABLE | WATCH | UNWELL | CRITICAL
  basis TEXT NOT NULL,                  -- what the clinician based it on, in their words
  evidence_json TEXT,                   -- what SHIFT held at the time
  change TEXT NOT NULL,                 -- FIRST | WORSE | BETTER | SAME
  review_due TEXT NOT NULL,
  state TEXT NOT NULL,                  -- CURRENT | SUPERSEDED | ENTERED_IN_ERROR
  assessed_by TEXT NOT NULL REFERENCES workforce_person(id),
  assessed_at TEXT NOT NULL,
  supersedes TEXT REFERENCES acuity_assessment(id),
  error_reason TEXT
);
CREATE INDEX acuity_person ON acuity_assessment(person_id, state);
`,
  },
  {
    version: 32,
    name: 'deterioration event lifecycle',
    sql: `
-- Deterioration event (Shared Lifecycle Object 268): change detected → evidence → concern/trigger
-- → escalation → clinical response → intervention → reassessment → outcome → further
-- escalation/closure. The steps are kept in order; escalations and reassessments are linked
-- records of their own (escalation, acuity_assessment).
CREATE TABLE deterioration_event (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  change_text TEXT NOT NULL,
  evidence_json TEXT,                   -- what SHIFT held when it was noticed
  state TEXT NOT NULL,                  -- DETECTED | ESCALATED | RESPONDING | REASSESSED | CLOSED
  detected_by TEXT NOT NULL REFERENCES workforce_person(id),
  detected_at TEXT NOT NULL,
  outcome TEXT,                         -- IMPROVED | STABLE_PLAN | HIGHER_CARE | DIED | OTHER
  outcome_note TEXT,
  closed_by TEXT,
  closed_at TEXT
);
CREATE INDEX deterioration_person ON deterioration_event(person_id, state);
CREATE INDEX deterioration_service ON deterioration_event(service_id, state);
CREATE TABLE deterioration_step (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES deterioration_event(id),
  kind TEXT NOT NULL,                   -- DETECTED | ESCALATED | RESPONSE | INTERVENTION | REASSESSMENT | OUTCOME
  body TEXT NOT NULL,
  link_id TEXT,                         -- the escalation or acuity assessment
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX deterioration_step_event ON deterioration_step(event_id, at);
`,
  },
  {
    version: 33,
    name: 'incident lifecycle',
    sql: `
-- Incident / adverse clinical event (Shared Lifecycle Object 269): event/concern → immediate
-- clinical response → incident notification where required → safety review → investigation
-- linkage → findings → actions → closure. Categories, harm levels and notification choices are
-- in server/config/incidents.ts; the national rating and notification rules are RR-INC-001.
CREATE TABLE incident (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  category TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  place TEXT,
  what TEXT NOT NULL,
  immediate TEXT NOT NULL,              -- the immediate clinical response
  reported_harm TEXT NOT NULL,          -- as the reporter saw it
  harm TEXT,                            -- as confirmed at review
  state TEXT NOT NULL,                  -- REPORTED | REVIEWED | INVESTIGATING | ACTIONS | CLOSED
  reported_by TEXT NOT NULL REFERENCES workforce_person(id),
  reported_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  notify TEXT,                          -- REQUIRED | NOT_REQUIRED | UNSURE
  notify_note TEXT,
  notified_at TEXT,
  disclosure TEXT,                      -- DONE | PLANNED | NOT_POSSIBLE | NOT_NEEDED
  disclosure_note TEXT,
  investigation_lead TEXT,
  investigation_ref TEXT,
  findings TEXT,
  closed_by TEXT,
  closed_at TEXT,
  close_note TEXT
);
CREATE INDEX incident_person ON incident(person_id, state);
CREATE INDEX incident_service ON incident(service_id, state);
CREATE TABLE incident_step (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incident(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX incident_step_incident ON incident_step(incident_id, at);
CREATE TABLE incident_action (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incident(id),
  what TEXT NOT NULL,
  owner TEXT NOT NULL,
  due TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT,
  done_note TEXT
);
CREATE INDEX incident_action_incident ON incident_action(incident_id);
`,
  },
  {
    version: 34,
    name: 'death event lifecycle',
    sql: `
-- Death event (Shared Lifecycle Object 270): death occurs/identified → verification →
-- certification references → notifications → clinical episode closure/transition →
-- mortuary/coronial/donation pathways where applicable. Choices are in server/config/deaths.ts;
-- who may verify and certify, and coroner reporting, are RR-DTH-001 and RR-DTH-002.
CREATE TABLE death_event (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  died_at TEXT NOT NULL,                -- time of death, or when they were found
  expected TEXT NOT NULL,               -- EXPECTED | UNEXPECTED | UNSURE
  place TEXT,
  circumstances TEXT NOT NULL,
  state TEXT NOT NULL,                  -- IDENTIFIED | VERIFIED | CLOSED | ENTERED_IN_ERROR
  identified_by TEXT NOT NULL REFERENCES workforce_person(id),
  identified_at TEXT NOT NULL,
  verified_by TEXT,
  verified_at TEXT,
  verify_note TEXT,
  cert_kind TEXT,                       -- CERTIFICATE | CORONER (a reference only)
  cert_by TEXT,
  cert_ref TEXT,
  cert_note TEXT,
  donation TEXT,                        -- NOT_APPLICABLE | DISCUSSED | REFERRED
  donation_note TEXT,
  wishes TEXT,
  released_to TEXT,                     -- FUNERAL_DIRECTOR | MORTUARY | CORONER | WHANAU
  released_name TEXT,
  released_at TEXT,
  release_note TEXT,
  released_by TEXT,
  closed_by TEXT,
  closed_at TEXT,
  close_note TEXT,
  error_reason TEXT
);
CREATE INDEX death_event_person ON death_event(person_id, state);
CREATE INDEX death_event_service ON death_event(service_id, state);
CREATE TABLE death_notification (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES death_event(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX death_notification_event ON death_notification(event_id);
CREATE TABLE death_step (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES death_event(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX death_step_event ON death_step(event_id, at);
`,
  },
  {
    version: 35,
    name: 'clinical problem lifecycle',
    sql: `
-- Clinical problem / concern (Shared Lifecycle Object 273): concern identified → evidence →
-- provisional problem → assessment → active problem → treatment/management linkage →
-- monitoring → improving/stable/worsening → resolved/inactive → recurrence.
CREATE TABLE clinical_problem (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL,                  -- CONCERN | PROVISIONAL | ACTIVE | RESOLVED | INACTIVE | RULED_OUT | ENTERED_IN_ERROR
  trend TEXT,                           -- IMPROVING | STABLE | WORSENING
  onset TEXT,
  assessment TEXT,
  management TEXT,
  monitoring TEXT,
  review_due TEXT,
  last_review_at TEXT,
  recurrences INTEGER NOT NULL DEFAULT 0,
  raised_by TEXT NOT NULL REFERENCES workforce_person(id),
  raised_at TEXT NOT NULL,
  assessed_by TEXT,
  assessed_at TEXT,
  source_event_id TEXT,                 -- the .problem entry it came from, if any
  closed_by TEXT,
  closed_at TEXT,
  close_note TEXT
);
CREATE INDEX clinical_problem_person ON clinical_problem(person_id, state);
CREATE TABLE problem_step (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES clinical_problem(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX problem_step_problem ON problem_step(problem_id, at);
`,
  },
  {
    version: 36,
    name: 'symptom lifecycle',
    sql: `
-- Symptom (Shared Lifecycle Object 274): symptom → onset → location/context → severity →
-- pattern → associated features → assessment → intervention → reassessment → outcome.
CREATE TABLE symptom (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,                   -- server/config/symptoms.ts KINDS
  name TEXT,                            -- when kind is OTHER
  onset TEXT,
  site TEXT,
  context TEXT,                         -- what brings it on
  pattern TEXT,
  associated TEXT,
  state TEXT NOT NULL,                  -- RECORDED | ASSESSED | INTERVENTION | REASSESSED | CLOSED | ENTERED_IN_ERROR
  assessment TEXT,
  reassess_due TEXT,
  outcome TEXT,                         -- RESOLVED | CONTROLLED | PROBLEM | OTHER
  outcome_note TEXT,
  problem_id TEXT,                      -- the clinical problem it became, if any
  recorded_by TEXT NOT NULL REFERENCES workforce_person(id),
  recorded_at TEXT NOT NULL,
  assessed_by TEXT,
  assessed_at TEXT,
  closed_by TEXT,
  closed_at TEXT
);
CREATE INDEX symptom_person ON symptom(person_id, state);
CREATE TABLE symptom_score (
  id TEXT PRIMARY KEY,
  symptom_id TEXT NOT NULL REFERENCES symptom(id),
  score INTEGER NOT NULL,               -- 0 to 10
  rated_by TEXT NOT NULL,               -- SELF | OBSERVED
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX symptom_score_symptom ON symptom_score(symptom_id, at);
CREATE TABLE symptom_step (
  id TEXT PRIMARY KEY,
  symptom_id TEXT NOT NULL REFERENCES symptom(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX symptom_step_symptom ON symptom_step(symptom_id, at);
`,
  },
  {
    version: 37,
    name: 'intervention lifecycle',
    sql: `
-- Intervention (Shared Lifecycle Object 276): intervention considered → planned → authorised
-- where required → delivered/performed → response → reassessment → continued/modified/ceased.
CREATE TABLE intervention (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  category TEXT NOT NULL,               -- server/config/interventions.ts
  what TEXT NOT NULL,
  purpose TEXT,
  problem_id TEXT,                      -- what it is for: a clinical problem (273) ...
  symptom_id TEXT,                      -- ... or a symptom (274)
  frequency TEXT NOT NULL,              -- ONCE | HOURS | DAILY | AS_NEEDED
  every_hours INTEGER,
  state TEXT NOT NULL,                  -- CONSIDERED | AWAITING_AUTHORISATION | ACTIVE | DECLINED | CEASED | ENTERED_IN_ERROR
  start_at TEXT NOT NULL,
  next_due TEXT,
  review_due TEXT,
  last_done_at TEXT,
  planned_by TEXT NOT NULL REFERENCES workforce_person(id),
  planned_at TEXT NOT NULL,
  authorised_by TEXT,
  authorised_at TEXT,
  auth_note TEXT,
  ceased_by TEXT,
  ceased_at TEXT,
  cease_note TEXT
);
CREATE INDEX intervention_person ON intervention(person_id, state);
CREATE TABLE intervention_delivery (
  id TEXT PRIMARY KEY,
  intervention_id TEXT NOT NULL REFERENCES intervention(id),
  done INTEGER NOT NULL,                -- 1 done, 0 not done (with the reason in note)
  note TEXT,
  response TEXT,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX intervention_delivery_intervention ON intervention_delivery(intervention_id, at);
CREATE TABLE intervention_step (
  id TEXT PRIMARY KEY,
  intervention_id TEXT NOT NULL REFERENCES intervention(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX intervention_step_intervention ON intervention_step(intervention_id, at);
`,
  },
  {
    version: 38,
    name: 'treatment plan lifecycle',
    sql: `
-- Treatment Plan (Shared Lifecycle Object 277): treatment need → options → agreed/authorised plan →
-- components → responsible services → implementation → monitoring → review → modification →
-- completion/cessation.
CREATE TABLE treatment_plan (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  need TEXT,
  problem_id TEXT,                      -- the clinical problem (273) it treats, when there is one
  goal TEXT NOT NULL,
  state TEXT NOT NULL,                  -- DRAFT | AWAITING_AGREEMENT | AGREED | ACTIVE | COMPLETED | STOPPED | ENTERED_IN_ERROR
  chosen_option_id TEXT,                -- the agreed option
  proposed_option_id TEXT,              -- an option waiting for agreement
  version INTEGER NOT NULL DEFAULT 1,
  agreed_with TEXT,                     -- PATIENT | WHANAU | EPOA | UNABLE (server/config/treatmentplans.ts)
  agreement_note TEXT,
  authorised_by TEXT,
  authorised_at TEXT,
  started_at TEXT,
  review_due TEXT,
  created_by TEXT NOT NULL REFERENCES workforce_person(id),
  created_at TEXT NOT NULL,
  ended_by TEXT,
  ended_at TEXT,
  end_note TEXT
);
CREATE INDEX treatment_plan_person ON treatment_plan(person_id, state);
CREATE TABLE treatment_option (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES treatment_plan(id),
  what TEXT NOT NULL,
  benefits TEXT,
  risks TEXT,
  added_by TEXT NOT NULL REFERENCES workforce_person(id),
  added_at TEXT NOT NULL
);
CREATE INDEX treatment_option_plan ON treatment_option(plan_id);
CREATE TABLE treatment_component (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES treatment_plan(id),
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES service(id),   -- the responsible service
  intervention_id TEXT,                 -- an intervention (276) this component is
  state TEXT NOT NULL,                  -- PLANNED | UNDER_WAY | DONE | STOPPED
  note TEXT,
  added_by TEXT NOT NULL REFERENCES workforce_person(id),
  added_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);
CREATE INDEX treatment_component_plan ON treatment_component(plan_id);
CREATE TABLE treatment_progress (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES treatment_plan(id),
  progress TEXT NOT NULL,               -- ON_TRACK | SLOWER | NOT_WORKING
  note TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX treatment_progress_plan ON treatment_progress(plan_id, at);
CREATE TABLE treatment_step (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES treatment_plan(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX treatment_step_plan ON treatment_step(plan_id, at);
`,
  },
  {
    version: 39,
    name: 'clinical pathway lifecycle',
    sql: `
-- Clinical Pathway / Protocol Instance (Shared Lifecycle Object 278): patient meets
-- trigger/eligibility → pathway initiated → applicable steps → completed/skipped/not
-- applicable/deferred states → deviations → escalation → completion/exit.
CREATE TABLE pathway_instance (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  pathway_id TEXT NOT NULL,             -- server/config/pathways.ts
  state TEXT NOT NULL,                  -- SUGGESTED | ACTIVE | COMPLETED | EXITED | DECLINED | ENTERED_IN_ERROR
  trigger_text TEXT,
  trigger_event_id TEXT,                -- the entry that suggested it
  eligibility_json TEXT,                -- the answer to each eligibility question
  suggested_by TEXT,
  suggested_at TEXT,
  started_by TEXT,
  started_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  exit_reason TEXT,
  end_note TEXT
);
CREATE INDEX pathway_instance_person ON pathway_instance(person_id, state);
CREATE TABLE pathway_step (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES pathway_instance(id),
  step_key TEXT NOT NULL,
  label TEXT NOT NULL,
  seq INTEGER NOT NULL,
  optional INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- PENDING | DONE | SKIPPED | NOT_APPLICABLE | DEFERRED
  note TEXT,
  by_id TEXT,
  at TEXT
);
CREATE INDEX pathway_step_instance ON pathway_step(instance_id, seq);
CREATE TABLE pathway_deviation (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES pathway_instance(id),
  step_id TEXT,
  kind TEXT NOT NULL,                   -- ELIGIBILITY | SKIPPED | DEFERRED | LATE | OVERDUE
  note TEXT NOT NULL,
  escalation_id TEXT,                   -- the escalation (225) it was raised as
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX pathway_deviation_instance ON pathway_deviation(instance_id, at);
CREATE TABLE pathway_log (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES pathway_instance(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX pathway_log_instance ON pathway_log(instance_id, at);
`,
  },
  {
    version: 40,
    name: 'checklist lifecycle',
    sql: `
-- Checklist: checklist required → individual check items due → check performed →
-- evidence/response → exception → resolution/escalation → checklist completion.
CREATE TABLE checklist (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  template_id TEXT NOT NULL,            -- server/config/checklists.ts
  state TEXT NOT NULL,                  -- REQUIRED | IN_PROGRESS | COMPLETED | CANCELLED | ENTERED_IN_ERROR
  due_at TEXT NOT NULL,
  reason TEXT,
  required_by TEXT NOT NULL REFERENCES workforce_person(id),
  required_at TEXT NOT NULL,
  ended_by TEXT,
  ended_at TEXT,
  end_note TEXT
);
CREATE INDEX checklist_person ON checklist(person_id, state);
CREATE TABLE checklist_item (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES checklist(id),
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  seq INTEGER NOT NULL,
  evidence_label TEXT,                  -- what to record as evidence, when the item asks for it
  state TEXT NOT NULL,                  -- DUE | DONE | NOT_APPLICABLE | EXCEPTION | RESOLVED | ESCALATED
  evidence TEXT,
  note TEXT,
  by_id TEXT,
  at TEXT,
  resolution TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  escalation_id TEXT                    -- the escalation (225) an exception was raised as
);
CREATE INDEX checklist_item_checklist ON checklist_item(checklist_id, seq);
CREATE TABLE checklist_log (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES checklist(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX checklist_log_checklist ON checklist_log(checklist_id, at);
`,
  },
  {
    version: 41,
    name: 'recommendation lifecycle',
    sql: `
-- Recommendation: assessment → recommendation → recipient → communicated →
-- accepted/declined/modified → implementation requirement → implemented/not implemented → review.
CREATE TABLE recommendation (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  state TEXT NOT NULL,                  -- RECOMMENDED | COMMUNICATED | ACCEPTED | MODIFIED | DECLINED | IMPLEMENTED | NOT_IMPLEMENTED | REVIEWED | WITHDRAWN | ENTERED_IN_ERROR
  basis TEXT NOT NULL,                  -- what the assessment found
  what TEXT NOT NULL,
  from_service_id TEXT NOT NULL REFERENCES service(id),
  from_role_key TEXT NOT NULL,
  to_service_id TEXT NOT NULL REFERENCES service(id),
  to_role_key TEXT NOT NULL,
  implement_by TEXT,
  made_by TEXT NOT NULL REFERENCES workforce_person(id),
  made_at TEXT NOT NULL,
  channel TEXT,                         -- SHIFT | VERBAL | PHONE | MEETING
  communicated_at TEXT,
  responded_by TEXT,
  responded_at TEXT,
  response TEXT,
  modified_what TEXT,
  requirement TEXT,                     -- what needs doing to put it in place
  implemented_by TEXT,
  implemented_at TEXT,
  not_done_reason TEXT,
  implementation_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX recommendation_person ON recommendation(person_id, state);
CREATE INDEX recommendation_to ON recommendation(to_service_id, state);
CREATE TABLE recommendation_log (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES recommendation(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX recommendation_log_rec ON recommendation_log(recommendation_id, at);
`,
  },
  {
    version: 42,
    name: 'requirement lifecycle',
    sql: `
-- Requirement: generated → pending → assigned → actioned OR deferred OR cancelled → outcome → closed.
CREATE TABLE requirement (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  state TEXT NOT NULL,                  -- PENDING | ASSIGNED | ACTIONED | DEFERRED | CANCELLED | CLOSED | ENTERED_IN_ERROR
  what TEXT NOT NULL,
  detail TEXT,
  priority TEXT NOT NULL,               -- URGENT | TODAY | ROUTINE
  due_by TEXT,
  source TEXT NOT NULL,                 -- RECOMMENDATION | MANUAL
  source_id TEXT,
  source_label TEXT NOT NULL,
  generated_by TEXT NOT NULL REFERENCES workforce_person(id),
  generated_at TEXT NOT NULL,
  assigned_to TEXT,
  assigned_by TEXT,
  assigned_at TEXT,
  accepted_at TEXT,
  actioned_by TEXT,
  actioned_at TEXT,
  action_note TEXT,
  deferred_until TEXT,
  defer_reason TEXT,
  ended_note TEXT,
  outcome TEXT,                         -- MET | PARTLY_MET | NOT_MET | NO_LONGER_NEEDED
  outcome_note TEXT,
  closed_by TEXT,
  closed_at TEXT
);
CREATE INDEX requirement_person ON requirement(person_id, state);
CREATE INDEX requirement_service ON requirement(service_id, state);
CREATE INDEX requirement_source ON requirement(source, source_id);
CREATE TABLE requirement_log (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirement(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX requirement_log_req ON requirement_log(requirement_id, at);
`,
  },
  {
    version: 43,
    name: 'care due lifecycle',
    sql: `
-- Care due: requirement established → due date/time → upcoming → due → overdue → completed/ceased/rescheduled.
-- Upcoming, due and overdue follow from the clock; each time it falls due is an occurrence.
CREATE TABLE due_item (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  detail TEXT,
  every_hours INTEGER,                  -- NULL means once
  state TEXT NOT NULL,                  -- ACTIVE | COMPLETED | CEASED | ENTERED_IN_ERROR
  set_by TEXT NOT NULL REFERENCES workforce_person(id),
  set_at TEXT NOT NULL,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX due_item_person ON due_item(person_id, state);
CREATE INDEX due_item_service ON due_item(service_id, state);
CREATE TABLE due_occurrence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES due_item(id),
  due_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- SCHEDULED | COMPLETED | RESCHEDULED | CEASED | ENTERED_IN_ERROR
  done_by TEXT,
  done_at TEXT,
  note TEXT,
  reason TEXT
);
CREATE INDEX due_occurrence_item ON due_occurrence(item_id, state);
CREATE TABLE due_log (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES due_item(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX due_log_item ON due_log(item_id, at);
`,
  },
  {
    version: 44,
    name: 'recall lifecycle',
    sql: `
-- Recall: recall requirement → due date → eligibility → invitation → booking → attendance →
-- outcome → next recall OR completion/exit.
CREATE TABLE recall (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  detail TEXT,
  every_days INTEGER,                   -- NULL means once
  due_date TEXT NOT NULL,
  state TEXT NOT NULL,                  -- SCHEDULED | INVITED | BOOKED | DID_NOT_ATTEND | DONE | EXITED | ENTERED_IN_ERROR
  previous_id TEXT,
  next_id TEXT,
  set_by TEXT NOT NULL REFERENCES workforce_person(id),
  set_at TEXT NOT NULL,
  checked_by TEXT,
  checked_at TEXT,
  eligibility_note TEXT,
  invited_by TEXT,
  invited_at TEXT,
  channel TEXT,
  invite_note TEXT,
  booked_by TEXT,
  booked_at TEXT,
  booked_for TEXT,
  booked_where TEXT,
  dna_at TEXT,
  dna_note TEXT,
  done_by TEXT,
  done_at TEXT,
  outcome TEXT,
  exit_reason TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX recall_person ON recall(person_id, state);
CREATE INDEX recall_service ON recall(service_id, state, due_date);
CREATE TABLE recall_log (
  id TEXT PRIMARY KEY,
  recall_id TEXT NOT NULL REFERENCES recall(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX recall_log_recall ON recall_log(recall_id, at);
`,
  },
  {
    version: 45,
    name: 'follow-up requirement lifecycle',
    sql: `
-- Follow-up: required → responsibility → referral/appointment/task linkage → scheduled →
-- completed → outcome → further follow-up/closure.
CREATE TABLE followup (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  what TEXT NOT NULL,
  reason TEXT,
  due_by TEXT NOT NULL,
  state TEXT NOT NULL,                  -- REQUIRED | DECLINED | ACCEPTED | ARRANGED | SCHEDULED | COMPLETED | CLOSED | CANCELLED | ENTERED_IN_ERROR
  previous_id TEXT,
  further_id TEXT,
  from_service_id TEXT NOT NULL REFERENCES service(id),
  from_role_key TEXT NOT NULL,
  made_by TEXT NOT NULL REFERENCES workforce_person(id),
  made_at TEXT NOT NULL,
  resp_kind TEXT NOT NULL,              -- INTERNAL | EXTERNAL
  to_service_id TEXT,
  to_role_key TEXT,
  external_name TEXT,
  accepted_by TEXT,
  accepted_at TEXT,
  told TEXT,
  accept_note TEXT,
  link_kind TEXT,
  link_ref TEXT,
  arranged_by TEXT,
  arranged_at TEXT,
  scheduled_for TEXT,
  scheduled_where TEXT,
  completed_by TEXT,
  completed_at TEXT,
  completed_note TEXT,
  outcome TEXT,
  outcome_note TEXT,
  closed_by TEXT,
  closed_at TEXT,
  ended_note TEXT
);
CREATE INDEX followup_person ON followup(person_id, state);
CREATE INDEX followup_from ON followup(from_service_id, state);
CREATE INDEX followup_to ON followup(to_service_id, state);
CREATE TABLE followup_log (
  id TEXT PRIMARY KEY,
  followup_id TEXT NOT NULL REFERENCES followup(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX followup_log_f ON followup_log(followup_id, at);
`,
  },
  {
    version: 46,
    name: 'surveillance plan lifecycle',
    sql: `
-- Surveillance plan: need → interval/trigger → required check → due → performed → result →
-- review → continue/change/stop. One open check at a time.
CREATE TABLE surveillance_plan (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,
  need TEXT NOT NULL,
  investigation TEXT NOT NULL,
  every_days INTEGER,                   -- null: only when triggered
  trigger_text TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | CEASED | ENTERED_IN_ERROR
  set_by TEXT NOT NULL REFERENCES workforce_person(id),
  set_at TEXT NOT NULL,
  cease_reason TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX surveillance_plan_person ON surveillance_plan(person_id, state);
CREATE INDEX surveillance_plan_service ON surveillance_plan(service_id, state);
CREATE TABLE surveillance_check (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES surveillance_plan(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  due_date TEXT NOT NULL,
  why TEXT,
  state TEXT NOT NULL,                  -- DUE | PERFORMED | RESULTED | NOT_DONE | REVIEWED | CANCELLED | ENTERED_IN_ERROR
  created_by TEXT NOT NULL REFERENCES workforce_person(id),
  created_at TEXT NOT NULL,
  performed_by TEXT,
  performed_at TEXT,
  performed_note TEXT,
  result_by TEXT,
  result_at TEXT,
  result TEXT,
  finding TEXT,
  not_done_reason TEXT,
  not_done_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  decision TEXT,
  review_note TEXT
);
CREATE INDEX surveillance_check_plan ON surveillance_check(plan_id, state);
CREATE TABLE surveillance_log (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES surveillance_plan(id),
  check_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX surveillance_log_plan ON surveillance_log(plan_id, at);
`,
  },
  {
    version: 47,
    name: 'screening episode lifecycle',
    sql: `
-- Screening episode: eligibility → offer → decision → screen → result → review → told →
-- recall OR further tests/referral OR exit.
CREATE TABLE screening (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  test TEXT NOT NULL,
  eligibility TEXT NOT NULL,
  due_date TEXT NOT NULL,
  state TEXT NOT NULL,                  -- ELIGIBLE | OFFERED | ACCEPTED | DECLINED | SCREENED | RESULTED | REVIEWED | COMMUNICATED | CLOSED | EXITED | ENTERED_IN_ERROR
  previous_id TEXT,
  next_id TEXT,
  set_by TEXT NOT NULL REFERENCES workforce_person(id),
  set_at TEXT NOT NULL,
  offered_by TEXT,
  offered_at TEXT,
  channel TEXT,
  offer_note TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  screened_by TEXT,
  screened_at TEXT,
  screen_note TEXT,
  result_by TEXT,
  result_at TEXT,
  result TEXT,
  finding TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  told_by TEXT,
  told_at TEXT,
  told_channel TEXT,
  told_note TEXT,
  outcome TEXT,
  outcome_note TEXT,
  closed_by TEXT,
  closed_at TEXT,
  exit_reason TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX screening_person ON screening(person_id, state);
CREATE INDEX screening_service ON screening(service_id, state, due_date);
CREATE TABLE screening_log (
  id TEXT PRIMARY KEY,
  screening_id TEXT NOT NULL REFERENCES screening(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX screening_log_s ON screening_log(screening_id, at);
`,
  },
  {
    version: 48,
    name: 'infection episode lifecycle',
    sql: `
-- Infection: suspected → evidence → source → organism → sensitivities/resistance → treatment →
-- response → source control → complications → resolved/ongoing/recurrence.
CREATE TABLE infection (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  site TEXT NOT NULL,
  site_detail TEXT,
  suspicion TEXT NOT NULL,
  state TEXT NOT NULL,                  -- SUSPECTED | CONFIRMED | NOT_INFECTION | ONGOING | RESOLVED | RECURRED | ENTERED_IN_ERROR
  previous_id TEXT,
  recurrence_id TEXT,
  raised_by TEXT NOT NULL REFERENCES workforce_person(id),
  raised_at TEXT NOT NULL,
  source TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  confirm_note TEXT,
  ended_by TEXT,
  ended_at TEXT,
  outcome_note TEXT
);
CREATE INDEX infection_person ON infection(person_id, state);
CREATE INDEX infection_service ON infection(service_id, state);
CREATE TABLE infection_entry (
  id TEXT PRIMARY KEY,
  infection_id TEXT NOT NULL REFERENCES infection(id),
  kind TEXT NOT NULL,                   -- EVIDENCE | ORGANISM | SUSCEPTIBILITY | TREATMENT | RESPONSE | SOURCE_CONTROL | COMPLICATION, and state steps
  what TEXT NOT NULL,
  value TEXT,
  ref_id TEXT,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX infection_entry_i ON infection_entry(infection_id, at);
`,
  },
  {
    version: 49,
    name: 'antimicrobial course lifecycle',
    sql: `
-- Antimicrobial course: indication → decision → agent/order reference → duration → lab results →
-- review → change → completed/stopped → outcome. SHIFT references the order; it does not prescribe.
CREATE TABLE antimicrobial_course (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  infection_id TEXT REFERENCES infection(id),
  indication TEXT NOT NULL,
  intent TEXT NOT NULL,                 -- EMPIRICAL | TARGETED | PROPHYLAXIS
  agent TEXT NOT NULL,
  route TEXT NOT NULL,
  dose TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  start_date TEXT NOT NULL,
  planned_days INTEGER NOT NULL,
  end_date TEXT NOT NULL,
  review_by TEXT NOT NULL,
  micro TEXT,
  micro_note TEXT,
  state TEXT NOT NULL,                  -- ACTIVE | CHANGED | COMPLETED | STOPPED | ENTERED_IN_ERROR
  previous_id TEXT,
  next_id TEXT,
  change_type TEXT,
  decided_by TEXT NOT NULL REFERENCES workforce_person(id),
  decided_at TEXT NOT NULL,
  decision_note TEXT,
  stop_reason TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT,
  outcome TEXT,
  outcome_note TEXT,
  outcome_by TEXT,
  outcome_at TEXT
);
CREATE INDEX antimicrobial_person ON antimicrobial_course(person_id, state);
CREATE INDEX antimicrobial_service ON antimicrobial_course(service_id, state);
CREATE TABLE antimicrobial_log (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES antimicrobial_course(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX antimicrobial_log_c ON antimicrobial_log(course_id, at);
`,
  },
  {
    version: 50,
    name: 'procedure site and side verification',
    sql: `
-- Procedure site / laterality verification: procedure planned → intended site/side → source evidence →
-- patient/team verification → discrepancy → resolution → verified → procedure linkage.
CREATE TABLE site_verification (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  procedure TEXT NOT NULL,
  planned_for TEXT NOT NULL,
  site TEXT NOT NULL,
  side TEXT NOT NULL,
  detail TEXT,
  state TEXT NOT NULL,                  -- PLANNED | DISCREPANCY | VERIFIED | DONE | CANCELLED | ENTERED_IN_ERROR
  planned_by TEXT NOT NULL REFERENCES workforce_person(id),
  planned_at TEXT NOT NULL,
  verified_by TEXT,
  verified_at TEXT,
  done_by TEXT,
  done_at TEXT,
  done_ref TEXT,
  done_mismatch INTEGER NOT NULL DEFAULT 0,
  done_note TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX site_verification_person ON site_verification(person_id, state);
CREATE INDEX site_verification_service ON site_verification(service_id, state);
CREATE TABLE site_check (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES site_verification(id),
  kind TEXT NOT NULL,
  source TEXT,
  outcome TEXT,
  stated TEXT,
  note TEXT,
  superseded INTEGER NOT NULL DEFAULT 0,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX site_check_v ON site_check(verification_id, at);
`,
  },
  {
    version: 51,
    name: 'clinical readiness',
    sql: `
-- Clinical readiness: assessment required → prerequisites → completed/outstanding/not applicable →
-- authorised assessment → ready/not ready/conditional → reassessment.
CREATE TABLE readiness (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  kind TEXT NOT NULL,
  purpose TEXT NOT NULL,
  needed_by TEXT,
  state TEXT NOT NULL,                  -- ASSESSING | READY | CONDITIONAL | NOT_READY | CLOSED | ENTERED_IN_ERROR
  raised_by TEXT NOT NULL REFERENCES workforce_person(id),
  raised_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  conditions TEXT,
  reassess_by TEXT,
  end_reason TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX readiness_person ON readiness(person_id, state);
CREATE INDEX readiness_service ON readiness(service_id, state);
CREATE TABLE readiness_item (
  id TEXT PRIMARY KEY,
  readiness_id TEXT NOT NULL REFERENCES readiness(id),
  label TEXT NOT NULL,
  essential INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,                 -- OUTSTANDING | COMPLETED | NOT_APPLICABLE
  note TEXT,
  done_by TEXT,
  done_at TEXT,
  position INTEGER NOT NULL,
  added_by TEXT NOT NULL REFERENCES workforce_person(id),
  added_at TEXT NOT NULL
);
CREATE INDEX readiness_item_r ON readiness_item(readiness_id, position);
CREATE TABLE readiness_log (
  id TEXT PRIMARY KEY,
  readiness_id TEXT NOT NULL REFERENCES readiness(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX readiness_log_r ON readiness_log(readiness_id, at);
`,
  },
  {
    version: 52,
    name: 'clinical exceptions and variances',
    sql: `
-- Clinical exception / variance: expected state or action → variance → reason → clinical context →
-- authorised decision → alternative action → monitoring and follow-up.
CREATE TABLE variance (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  category TEXT NOT NULL,
  expected TEXT NOT NULL,
  what_happened TEXT NOT NULL,
  reason TEXT NOT NULL,
  context TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- RECORDED | MONITORING | CLOSED | ENTERED_IN_ERROR
  recorded_by TEXT NOT NULL REFERENCES workforce_person(id),
  recorded_at TEXT NOT NULL,
  decision TEXT,
  action TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  follow_up_by TEXT,
  watch TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX variance_person ON variance(person_id, state);
CREATE INDEX variance_service ON variance(service_id, state);
CREATE TABLE variance_log (
  id TEXT PRIMARY KEY,
  variance_id TEXT NOT NULL REFERENCES variance(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX variance_log_v ON variance_log(variance_id, at);
`,
  },
  {
    version: 53,
    name: 'declined care',
    sql: `
-- Refusal / declined care: care offered → information and decision → declined → reason → clinical
-- implications → alternative plan → escalation → re-offer.
CREATE TABLE declined_care (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  category TEXT NOT NULL,
  offered TEXT NOT NULL,
  information TEXT NOT NULL,
  decided_by TEXT NOT NULL,             -- PERSON | REPRESENTATIVE
  representative TEXT,
  capacity_concern INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  implications TEXT NOT NULL,
  risk TEXT NOT NULL,                   -- LOW | MODERATE | HIGH
  plan TEXT,
  reoffer_by TEXT,
  offered_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- DECLINED | ESCALATED | ACCEPTED | CLOSED | ENTERED_IN_ERROR
  recorded_by TEXT NOT NULL REFERENCES workforce_person(id),
  recorded_at TEXT NOT NULL,
  escalated_to TEXT,
  escalated_at TEXT,
  response TEXT,
  responded_by TEXT,
  responded_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX declined_person ON declined_care(person_id, state);
CREATE INDEX declined_service ON declined_care(service_id, state);
CREATE TABLE declined_log (
  id TEXT PRIMARY KEY,
  declined_id TEXT NOT NULL REFERENCES declined_care(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX declined_log_d ON declined_log(declined_id, at);
`,
  },
  {
    version: 54,
    name: 'clinical priority',
    sql: `
-- Clinical priority / triage: request or presentation → triage evidence → priority assigned →
-- timeframe → reassessment → changed priority → service action.
CREATE TABLE priority (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  scale TEXT NOT NULL,                  -- ATS | WARD | ARC | PHYSIO
  source TEXT NOT NULL,
  what TEXT NOT NULL,
  evidence TEXT NOT NULL,
  level TEXT NOT NULL,
  level_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- WAITING | ACTIONED | CANCELLED | ENTERED_IN_ERROR
  assigned_by TEXT NOT NULL REFERENCES workforce_person(id),
  assigned_at TEXT NOT NULL,
  acted_by TEXT,
  acted_at TEXT,
  action_note TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_note TEXT
);
CREATE INDEX priority_person ON priority(person_id, state);
CREATE INDEX priority_service ON priority(service_id, state, due_at);
CREATE TABLE priority_log (
  id TEXT PRIMARY KEY,
  priority_id TEXT NOT NULL REFERENCES priority(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX priority_log_p ON priority_log(priority_id, at);
`,
  },
  {
    version: 55,
    name: 'identity matching',
    sql: `
-- Identity matching: incoming identity information → candidate match → matching evidence →
-- confirmed match OR unresolved identity → merge/link correction where authorised → provenance.
ALTER TABLE person ADD COLUMN merged_into TEXT;
CREATE TABLE identity_match (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),  -- the record this arrival is now on
  service_id TEXT NOT NULL REFERENCES service(id),
  source TEXT NOT NULL,                 -- where the details came from at arrival
  id_source TEXT,                       -- where the identifying details came from later
  stated_given TEXT,
  stated_family TEXT,
  stated_nhi TEXT,
  stated_dob TEXT,
  stated_gender TEXT,
  description TEXT,
  evidence TEXT,                        -- JSON: identifiers that agreed and differed
  not_them TEXT,
  temporary INTEGER NOT NULL DEFAULT 0,
  linked_to TEXT REFERENCES person(id),
  state TEXT NOT NULL,                  -- CONFIRMED | NEW | UNRESOLVED | RESOLVED
  registered_by TEXT NOT NULL REFERENCES workforce_person(id),
  registered_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  resolved_note TEXT,
  corrected_by TEXT,
  corrected_at TEXT,
  corrected_note TEXT,
  manifest TEXT                         -- JSON: rows moved by a merge, so it can be undone
);
CREATE INDEX identity_match_person ON identity_match(person_id, state);
CREATE INDEX identity_match_service ON identity_match(service_id, state, registered_at);
CREATE TABLE identity_match_log (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES identity_match(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX identity_match_log_m ON identity_match_log(match_id, at);
`,
  },
  {
    version: 56,
    name: 'duplicate records',
    sql: `
-- Duplicate record resolution: possible duplicate → review → duplicate or not → authorised
-- reconciliation → one canonical record → retained provenance → downstream correction.
CREATE TABLE duplicate_case (
  id TEXT PRIMARY KEY,
  person_a TEXT NOT NULL REFERENCES person(id),
  person_b TEXT NOT NULL REFERENCES person(id),
  kept_id TEXT REFERENCES person(id),
  merged_id TEXT REFERENCES person(id),
  detected_how TEXT NOT NULL,           -- SHIFT | FLAGGED
  detected_by TEXT,
  detected_at TEXT NOT NULL,
  reason TEXT,
  evidence TEXT,
  state TEXT NOT NULL,                  -- POSSIBLE | NOT_DUPLICATE | RECONCILED
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  manifest TEXT,                        -- JSON: rows and identifiers moved, and follow-up tasks
  undone_by TEXT,
  undone_at TEXT,
  undone_note TEXT
);
CREATE INDEX duplicate_case_a ON duplicate_case(person_a, state);
CREATE INDEX duplicate_case_b ON duplicate_case(person_b, state);
CREATE TABLE duplicate_log (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES duplicate_case(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT,                           -- null when SHIFT itself spotted the pair
  at TEXT NOT NULL
);
CREATE INDEX duplicate_log_c ON duplicate_log(case_id, at);
`,
  },
  {
    version: 57,
    name: 'break-glass access',
    sql: `
-- Break-glass / exceptional access: no ordinary authority → clinical need → pathway → reason →
-- agreement or approval → time-limited access → activity audit → review.
ALTER TABLE exceptional_access ADD COLUMN kind TEXT NOT NULL DEFAULT 'EMERGENCY';   -- EMERGENCY | PRESENT | APPROVAL
ALTER TABLE exceptional_access ADD COLUMN consent TEXT;                             -- AGREED | CANNOT (PRESENT only)
ALTER TABLE exceptional_access ADD COLUMN service_id TEXT REFERENCES service(id);
ALTER TABLE exceptional_access ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE';     -- REQUESTED | ACTIVE | DECLINED | WITHDRAWN | ENDED | REVIEWED
ALTER TABLE exceptional_access ADD COLUMN approver_id TEXT REFERENCES workforce_person(id);
ALTER TABLE exceptional_access ADD COLUMN decided_at TEXT;
ALTER TABLE exceptional_access ADD COLUMN decided_note TEXT;
ALTER TABLE exceptional_access ADD COLUMN ended_at TEXT;
ALTER TABLE exceptional_access ADD COLUMN ended_by TEXT REFERENCES workforce_person(id);
ALTER TABLE exceptional_access ADD COLUMN ended_note TEXT;
ALTER TABLE exceptional_access ADD COLUMN review_by TEXT REFERENCES workforce_person(id);
ALTER TABLE exceptional_access ADD COLUMN review_note TEXT;
UPDATE exceptional_access SET service_id = (SELECT service_id FROM work_context WHERE work_context.id = exceptional_access.work_context_id);
UPDATE exceptional_access SET state = 'ENDED', ended_at = expires_at WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
CREATE INDEX exceptional_access_state ON exceptional_access(service_id, state);
CREATE TABLE exceptional_access_log (
  id TEXT PRIMARY KEY,
  access_id TEXT NOT NULL REFERENCES exceptional_access(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX exceptional_access_log_a ON exceptional_access_log(access_id, at);
`,
  },
  {
    version: 58,
    name: 'delegation',
    sql: `
-- Delegation: eligible activity → delegator → delegate → scope → timeframe → acceptance →
-- performance → supervision/review where required → completion/end.
CREATE TABLE delegation (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  activity TEXT NOT NULL,
  instructions TEXT NOT NULL,
  report_if TEXT NOT NULL,
  delegator_id TEXT NOT NULL REFERENCES workforce_person(id),
  delegate_id TEXT NOT NULL REFERENCES workforce_person(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- OFFERED | ACCEPTED | DECLINED | WITHDRAWN | TO_REVIEW | COMPLETED | EXPIRED
  competence_confirmed INTEGER NOT NULL,
  review_required INTEGER NOT NULL,
  responded_at TEXT,
  response_note TEXT,
  concern_at TEXT,
  done_at TEXT,
  reviewed_at TEXT,
  review_outcome TEXT,
  review_note TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX delegation_delegate ON delegation(delegate_id, state);
CREATE INDEX delegation_delegator ON delegation(delegator_id, state);
CREATE TABLE delegation_log (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL REFERENCES delegation(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX delegation_log_d ON delegation_log(delegation_id, at);
`,
  },
  {
    version: 59,
    name: 'rule engine',
    sql: `
-- Rule engine: each generated alert keeps the rule version and the facts that fired it, and a
-- clinical decision alert keeps the decision recorded against it.
ALTER TABLE alert ADD COLUMN rule_version INTEGER;
ALTER TABLE alert ADD COLUMN evidence TEXT;             -- JSON: the facts that fired the rule
ALTER TABLE alert ADD COLUMN outcome TEXT;              -- the decision, for clinical decision alerts
`,
  },
  {
    version: 60,
    name: 'work queue engine',
    sql: `
-- Work queue engine: requirement → responsible recipient → due threshold → escalation condition →
-- next authorised recipient → acknowledgement → action → resolution.
ALTER TABLE task ADD COLUMN due_by TEXT;                 -- the due time as a moment, when the words name one
CREATE TABLE work_escalation (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  level INTEGER NOT NULL,               -- step on the service's ladder
  to_role TEXT NOT NULL,
  reason TEXT NOT NULL,                 -- NOT_ACCEPTED | NOT_DONE | NOT_ACKNOWLEDGED
  due_by TEXT,
  escalated_at TEXT NOT NULL,
  state TEXT NOT NULL,                  -- OPEN | ACKNOWLEDGED | RESOLVED | SUPERSEDED
  acknowledged_by TEXT REFERENCES workforce_person(id),
  acknowledged_at TEXT,
  action TEXT,                          -- TAKEN | EXTENDED | NOTED
  action_note TEXT,
  action_by TEXT REFERENCES workforce_person(id),
  action_at TEXT,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX work_escalation_task ON work_escalation(task_id, state);
CREATE INDEX work_escalation_role ON work_escalation(service_id, to_role, state);
CREATE TABLE work_escalation_log (
  id TEXT PRIMARY KEY,
  escalation_id TEXT NOT NULL REFERENCES work_escalation(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT,                           -- null when SHIFT escalated it
  at TEXT NOT NULL
);
CREATE INDEX work_escalation_log_e ON work_escalation_log(escalation_id, at);
`,
  },
  {
    version: 61,
    name: 'architecture check',
    sql: `
-- HISTORY CHANGED → preserve both old and new states with provenance: one row per changed field.
CREATE TABLE object_revision (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  field TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  actor_id TEXT REFERENCES workforce_person(id),
  work_context_id TEXT,
  at TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX object_revision_o ON object_revision(object_type, object_id, at);
CREATE TRIGGER object_revision_no_update BEFORE UPDATE ON object_revision BEGIN SELECT RAISE(ABORT, 'Revisions are append-only'); END;
CREATE TRIGGER object_revision_no_delete BEFORE DELETE ON object_revision BEGIN SELECT RAISE(ABORT, 'Revisions are append-only'); END;

-- SAME FACT → do not re-enter it. The bed is the canonical place; a stay shows it, never a typed copy of it.
CREATE TRIGGER bed_occupancy_in AFTER INSERT ON bed_occupancy WHEN NEW.until_at IS NULL BEGIN
  UPDATE encounter SET location = (SELECT label FROM bed WHERE id = NEW.bed_id)
   WHERE person_id = NEW.person_id AND service_id = NEW.service_id AND state = 'ACTIVE';
END;
CREATE TRIGGER bed_occupancy_out AFTER UPDATE OF until_at ON bed_occupancy WHEN OLD.until_at IS NULL AND NEW.until_at IS NOT NULL BEGIN
  UPDATE encounter SET location = NULL
   WHERE person_id = NEW.person_id AND service_id = NEW.service_id AND state = 'ACTIVE'
     AND location = (SELECT label FROM bed WHERE id = NEW.bed_id);
END;
UPDATE encounter SET location = (
  SELECT b.label FROM bed_occupancy o JOIN bed b ON b.id = o.bed_id
   WHERE o.person_id = encounter.person_id AND o.service_id = encounter.service_id AND o.until_at IS NULL ORDER BY o.from_at DESC LIMIT 1)
 WHERE state = 'ACTIVE' AND EXISTS (
  SELECT 1 FROM bed_occupancy o WHERE o.person_id = encounter.person_id AND o.service_id = encounter.service_id AND o.until_at IS NULL);
`,
  },
  {
    version: 62,
    name: 'downtime continuity',
    sql: `
-- Downtime continuity: downtime declared → affected functions → approved continuity process →
-- temporary clinical recording → system restoration → reconciliation → provenance → closure.
CREATE TABLE downtime (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES service(id),
  functions TEXT NOT NULL,              -- comma list: ALL | MEDICINES | RESULTS | OBSERVATIONS | TASKS
  reason TEXT NOT NULL,
  started_at TEXT NOT NULL,             -- when it went down, which can be before it was declared
  state TEXT NOT NULL,                  -- DECLARED | RESTORED | CLOSED | CANCELLED
  declared_by TEXT NOT NULL REFERENCES workforce_person(id),
  declared_at TEXT NOT NULL,
  restored_by TEXT REFERENCES workforce_person(id),
  restored_at TEXT,
  restore_note TEXT,
  closed_by TEXT REFERENCES workforce_person(id),
  closed_at TEXT,
  close_note TEXT
);
CREATE INDEX downtime_service ON downtime(service_id, state);
CREATE TABLE downtime_check (
  id TEXT PRIMARY KEY,
  downtime_id TEXT NOT NULL REFERENCES downtime(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  state TEXT NOT NULL,                  -- TO_CHECK | CHECKED
  outcome TEXT,                         -- ENTERED | NOTHING
  note TEXT,
  checked_by TEXT REFERENCES workforce_person(id),
  checked_at TEXT
);
CREATE INDEX downtime_check_d ON downtime_check(downtime_id, state);
CREATE TABLE downtime_log (
  id TEXT PRIMARY KEY,
  downtime_id TEXT NOT NULL REFERENCES downtime(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  by_id TEXT REFERENCES workforce_person(id),
  at TEXT NOT NULL
);
CREATE INDEX downtime_log_d ON downtime_log(downtime_id, at);
-- Provenance of an entry made afterwards from a paper record.
ALTER TABLE clinical_event ADD COLUMN downtime_id TEXT REFERENCES downtime(id);
ALTER TABLE clinical_event ADD COLUMN paper_by TEXT;
ALTER TABLE clinical_event ADD COLUMN paper_ref TEXT;
`,
  },
];
