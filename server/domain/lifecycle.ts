import type { Store } from '../db/database.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Shared lifecycle machine (Package 5 §4 and the Transitions document). Each governed
// object moves only along its declared chain, and every move is recorded as evidence.
// Sent, received, reviewed and actioned are distinct states; none implies the next.
export const LIFECYCLES: Record<string, { table: string; initial: string; next: Record<string, string[]> }> = {
  route: {
    table: 'route',
    initial: 'SENT',
    next: {
      SENT: ['DELIVERED'],
      DELIVERED: ['RECEIVED'],
      RECEIVED: ['REVIEWED'],
      REVIEWED: ['ACCEPTED', 'ACTIONED'],
      ACCEPTED: ['ACTIONED'],
    },
  },
  task: {
    table: 'task',
    initial: 'CREATED',
    next: {
      CREATED: ['ASSIGNED', 'ACCEPTED', 'CANCELLED'],
      ASSIGNED: ['ACCEPTED', 'REASSIGNED', 'CANCELLED'],
      REASSIGNED: ['ASSIGNED'],
      ACCEPTED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
      COMPLETED: ['CLOSED'],
    },
  },
  transfer: {
    table: 'transfer',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
      ACCEPTED: ['BED_ALLOCATED', 'CANCELLED'],
      BED_ALLOCATED: ['ARRIVED', 'BED_ALLOCATED', 'CANCELLED'],
      ARRIVED: ['RESPONSIBILITY_ACCEPTED'],
    },
  },
  discharge: {
    table: 'discharge',
    initial: 'CONSIDERED',
    next: {
      CONSIDERED: ['DECIDED', 'CANCELLED'],
      DECIDED: ['DISCHARGED', 'CONSIDERED', 'CANCELLED'],
    },
  },
  escalation: {
    table: 'escalation',
    initial: 'RAISED',
    next: {
      RAISED: ['RECEIVED', 'ESCALATED', 'RESOLVED'],
      RECEIVED: ['ACKNOWLEDGED', 'ESCALATED', 'RESOLVED'],
      ACKNOWLEDGED: ['RESPONDED', 'ESCALATED', 'RESOLVED'],
      RESPONDED: ['RESOLVED', 'ESCALATED'],
    },
  },
  consultation: {
    table: 'consultation',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['RECEIVED', 'WITHDRAWN'],
      RECEIVED: ['ACCEPTED', 'DECLINED', 'WITHDRAWN'],
      ACCEPTED: ['ADVISED', 'WITHDRAWN'],
      ADVISED: ['ADVICE_RECEIVED'],
      ADVICE_RECEIVED: ['CLOSED'],
    },
  },
  wound: {
    table: 'wound',
    initial: 'IDENTIFIED',
    next: {
      IDENTIFIED: ['ASSESSED', 'CLOSED'],
      ASSESSED: ['PLANNED', 'HEALED', 'CLOSED'],
      PLANNED: ['PLANNED', 'HEALED', 'CLOSED'],
    },
  },
  careplan: {
    table: 'care_plan_item',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ACHIEVED', 'CEASED', 'SUPERSEDED'] },
  },
  referral: {
    table: 'referral',
    initial: 'DRAFT',
    next: {
      DRAFT: ['AUTHORISED', 'CANCELLED'],
      AUTHORISED: ['SENT', 'CANCELLED'],
      SENT: ['RECEIVED', 'CANCELLED'],
      RECEIVED: ['TRIAGED', 'CANCELLED'],
      TRIAGED: ['ACCEPTED', 'DECLINED', 'REDIRECTED', 'CANCELLED'],
      ACCEPTED: ['SCHEDULED', 'SEEN', 'CANCELLED'],
      SCHEDULED: ['SCHEDULED', 'SEEN', 'CANCELLED'],
      SEEN: ['RESPONSIBILITY_ACCEPTED', 'OUTCOME_RECORDED'],
      RESPONSIBILITY_ACCEPTED: ['OUTCOME_RECORDED'],
      OUTCOME_RECORDED: ['CLOSED'],
    },
  },
  appointment: {
    table: 'appointment',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['OFFERED', 'BOOKED', 'CANCELLED'],
      OFFERED: ['BOOKED', 'REQUESTED', 'CANCELLED'],
      BOOKED: ['CONFIRMED', 'ARRIVED', 'BOOKED', 'CANCELLED', 'DID_NOT_ATTEND'],
      CONFIRMED: ['ARRIVED', 'BOOKED', 'CANCELLED', 'DID_NOT_ATTEND'],
      ARRIVED: ['COMMENCED', 'UNABLE_TO_COMPLETE'],
      COMMENCED: ['COMPLETED', 'UNABLE_TO_COMPLETE'],
    },
  },
  alert: {
    table: 'alert',
    initial: 'GENERATED',
    next: {
      GENERATED: ['VISIBLE', 'EXPIRED', 'RESOLVED'],
      VISIBLE: ['ACKNOWLEDGED', 'EXPIRED', 'RESOLVED'],
      ACKNOWLEDGED: ['ACTIONED', 'RESOLVED', 'EXPIRED'],
      ACTIONED: ['ACTIONED', 'RESOLVED', 'EXPIRED'],
    },
  },
  communication: {
    table: 'communication',
    initial: 'REQUIRED',
    next: {
      REQUIRED: ['ATTEMPTED', 'CONVEYED', 'CANCELLED'],
      ATTEMPTED: ['ATTEMPTED', 'CONVEYED', 'CANCELLED'],
      CONVEYED: ['FOLLOW_UP', 'COMPLETED'],
      FOLLOW_UP: ['COMPLETED'],
    },
  },
  bedmove: {
    table: 'bed_move',
    initial: 'REQUESTED',
    next: { REQUESTED: ['ALLOCATED', 'CANCELLED'], ALLOCATED: ['MOVED', 'REQUESTED', 'CANCELLED'] },
  },
  equipment: {
    table: 'equipment',
    initial: 'AVAILABLE',
    next: {
      NEW: ['AVAILABLE', 'QUARANTINED', 'RETIRED'],
      AVAILABLE: ['IN_USE', 'ON_LOAN', 'QUARANTINED', 'IN_REPAIR', 'RETIRED'],
      IN_USE: ['AVAILABLE', 'QUARANTINED'],
      ON_LOAN: ['CLEANING', 'QUARANTINED', 'RETIRED'],
      CLEANING: ['AVAILABLE', 'QUARANTINED'],
      QUARANTINED: ['IN_REPAIR', 'AVAILABLE', 'RETIRED'],
      IN_REPAIR: ['AVAILABLE', 'RETIRED'],
    },
  },
  diet: {
    table: 'diet_order',
    initial: 'ACTIVE',
    next: { ACTIVE: ['SUPERSEDED', 'CEASED'] },
  },
  instrument: {
    table: 'instrument_use',
    initial: 'REQUESTED',
    next: { REQUESTED: ['COMPLETED', 'DECLINED', 'CANCELLED'], COMPLETED: ['INTERPRETED'] },
  },
  function: {
    table: 'function_assessment',
    initial: 'CURRENT',
    next: { CURRENT: ['SUPERSEDED', 'ENTERED_IN_ERROR'] },
  },
  functionplan: {
    table: 'function_intervention',
    initial: 'PLANNED',
    next: { PLANNED: ['IN_PLACE', 'STOPPED'], IN_PLACE: ['STOPPED'] },
  },
  usual: {
    table: 'usual_state',
    initial: 'CURRENT',
    next: { CURRENT: ['SUPERSEDED', 'ENTERED_IN_ERROR'] },
  },
  difference: {
    table: 'usual_difference',
    initial: 'NOTICED',
    next: { NOTICED: ['ACTING', 'CLOSED'], ACTING: ['CLOSED'] },
  },
  assignment: {
    table: 'assignment',
    initial: 'PROPOSED',
    next: { PROPOSED: ['CONFIRMED', 'DECLINED'], CONFIRMED: ['ACTIVE', 'ENDED'], ACTIVE: ['ENDED'] },
  },
  allocplan: {
    table: 'allocation_plan',
    initial: 'DRAFT',
    next: { DRAFT: ['SUBMITTED', 'CANCELLED'], SUBMITTED: ['CONFIRMED', 'DRAFT'], CONFIRMED: ['ACTIVE', 'CANCELLED'], ACTIVE: ['ENDED'] },
  },
  acuity: {
    table: 'acuity_assessment',
    initial: 'CURRENT',
    next: { CURRENT: ['SUPERSEDED', 'ENTERED_IN_ERROR'] },
  },
  deterioration: {
    table: 'deterioration_event',
    initial: 'DETECTED',
    next: {
      // CLOSED from any state only when the person dies (death record closure); the view closes from REASSESSED.
      DETECTED: ['ESCALATED', 'REASSESSED', 'CLOSED'], ESCALATED: ['RESPONDING', 'REASSESSED', 'CLOSED'], RESPONDING: ['ESCALATED', 'REASSESSED', 'CLOSED'],
      REASSESSED: ['ESCALATED', 'RESPONDING', 'CLOSED'],
    },
  },
  incident: {
    table: 'incident',
    initial: 'REPORTED',
    next: { REPORTED: ['REVIEWED'], REVIEWED: ['INVESTIGATING', 'ACTIONS'], INVESTIGATING: ['ACTIONS'], ACTIONS: ['CLOSED'], CLOSED: ['ACTIONS'] },
  },
  death: {
    table: 'death_event',
    initial: 'IDENTIFIED',
    next: { IDENTIFIED: ['VERIFIED', 'ENTERED_IN_ERROR'], VERIFIED: ['CLOSED', 'ENTERED_IN_ERROR'] },
  },
  major_incident: {
    table: 'major_incident',
    initial: 'STANDBY',
    next: { STANDBY: ['ACTIVE', 'STOOD_DOWN'], ACTIVE: ['STOOD_DOWN'], STOOD_DOWN: ['CLOSED'] },
  },
  coronial: {
    table: 'coronial_case',
    initial: 'HELD',
    next: { HELD: ['FINDINGS'], FINDINGS: ['CLOSED'] },
  },
  coronial_request: {
    table: 'coronial_request',
    initial: 'RECEIVED',
    next: { RECEIVED: ['ADVICE', 'DECIDED'], ADVICE: ['DECIDED'], DECIDED: ['SENT'] },
  },
  problem: {
    table: 'clinical_problem',
    initial: 'CONCERN',
    next: {
      CONCERN: ['PROVISIONAL', 'ACTIVE', 'RULED_OUT', 'RESOLVED', 'ENTERED_IN_ERROR'], PROVISIONAL: ['ACTIVE', 'RULED_OUT', 'RESOLVED', 'ENTERED_IN_ERROR'],
      ACTIVE: ['RESOLVED', 'INACTIVE', 'ENTERED_IN_ERROR'], RESOLVED: ['ACTIVE', 'ENTERED_IN_ERROR'], INACTIVE: ['ACTIVE', 'ENTERED_IN_ERROR'],
      RULED_OUT: ['ENTERED_IN_ERROR'],
    },
  },
  symptom: {
    table: 'symptom',
    initial: 'RECORDED',
    next: {
      RECORDED: ['ASSESSED', 'INTERVENTION', 'REASSESSED', 'CLOSED', 'ENTERED_IN_ERROR'], ASSESSED: ['INTERVENTION', 'REASSESSED', 'CLOSED', 'ENTERED_IN_ERROR'],
      INTERVENTION: ['REASSESSED', 'CLOSED', 'ENTERED_IN_ERROR'], REASSESSED: ['INTERVENTION', 'CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  intervention: {
    table: 'intervention',
    initial: 'ACTIVE',
    next: {
      CONSIDERED: ['AWAITING_AUTHORISATION', 'ACTIVE', 'CEASED', 'ENTERED_IN_ERROR'], AWAITING_AUTHORISATION: ['ACTIVE', 'DECLINED', 'CEASED', 'ENTERED_IN_ERROR'],
      ACTIVE: ['AWAITING_AUTHORISATION', 'CEASED', 'ENTERED_IN_ERROR'],
    },
  },
  treatment_plan: {
    table: 'treatment_plan',
    initial: 'DRAFT',
    next: {
      DRAFT: ['AWAITING_AGREEMENT', 'AGREED', 'STOPPED', 'ENTERED_IN_ERROR'], AWAITING_AGREEMENT: ['DRAFT', 'AGREED', 'ACTIVE', 'STOPPED', 'ENTERED_IN_ERROR'],
      AGREED: ['ACTIVE', 'STOPPED', 'ENTERED_IN_ERROR'], ACTIVE: ['AWAITING_AGREEMENT', 'COMPLETED', 'STOPPED', 'ENTERED_IN_ERROR'],
    },
  },
  pathway: {
    table: 'pathway_instance',
    initial: 'SUGGESTED',
    next: {
      SUGGESTED: ['ACTIVE', 'DECLINED', 'ENTERED_IN_ERROR'], ACTIVE: ['COMPLETED', 'EXITED', 'ENTERED_IN_ERROR'],
    },
  },
  checklist: {
    table: 'checklist',
    initial: 'REQUIRED',
    next: {
      REQUIRED: ['IN_PROGRESS', 'CANCELLED', 'ENTERED_IN_ERROR'], IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'ENTERED_IN_ERROR'],
    },
  },
  recommendation: {
    table: 'recommendation',
    initial: 'RECOMMENDED',
    next: {
      RECOMMENDED: ['COMMUNICATED', 'WITHDRAWN', 'ENTERED_IN_ERROR'], COMMUNICATED: ['ACCEPTED', 'MODIFIED', 'DECLINED', 'WITHDRAWN', 'ENTERED_IN_ERROR'],
      ACCEPTED: ['IMPLEMENTED', 'NOT_IMPLEMENTED', 'ENTERED_IN_ERROR'], MODIFIED: ['IMPLEMENTED', 'NOT_IMPLEMENTED', 'ENTERED_IN_ERROR'],
      DECLINED: ['REVIEWED', 'ENTERED_IN_ERROR'], IMPLEMENTED: ['REVIEWED', 'ENTERED_IN_ERROR'], NOT_IMPLEMENTED: ['REVIEWED', 'ENTERED_IN_ERROR'],
    },
  },
  requirement: {
    table: 'requirement',
    initial: 'PENDING',
    next: {
      PENDING: ['ASSIGNED', 'DEFERRED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      ASSIGNED: ['ASSIGNED', 'PENDING', 'ACTIONED', 'DEFERRED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      DEFERRED: ['PENDING', 'ASSIGNED', 'CANCELLED', 'CLOSED', 'ENTERED_IN_ERROR'],
      ACTIONED: ['CLOSED', 'ENTERED_IN_ERROR'], CANCELLED: ['CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  due_item: {
    table: 'due_item',
    initial: 'ACTIVE',
    next: { ACTIVE: ['COMPLETED', 'CEASED', 'ENTERED_IN_ERROR'] },
  },
  due_occurrence: {
    table: 'due_occurrence',
    initial: 'SCHEDULED',
    next: { SCHEDULED: ['COMPLETED', 'RESCHEDULED', 'CEASED', 'ENTERED_IN_ERROR'] },
  },
  recall: {
    table: 'recall',
    initial: 'SCHEDULED',
    next: {
      SCHEDULED: ['INVITED', 'EXITED', 'ENTERED_IN_ERROR'], INVITED: ['BOOKED', 'EXITED', 'ENTERED_IN_ERROR'],
      BOOKED: ['DONE', 'DID_NOT_ATTEND', 'EXITED', 'ENTERED_IN_ERROR'], DID_NOT_ATTEND: ['INVITED', 'EXITED', 'ENTERED_IN_ERROR'],
    },
  },
  followup: {
    table: 'followup',
    initial: 'REQUIRED',
    next: {
      REQUIRED: ['ACCEPTED', 'DECLINED', 'CANCELLED', 'ENTERED_IN_ERROR'], DECLINED: ['CANCELLED', 'ENTERED_IN_ERROR'],
      ACCEPTED: ['ARRANGED', 'CANCELLED', 'ENTERED_IN_ERROR'], ARRANGED: ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      SCHEDULED: ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'ENTERED_IN_ERROR'], COMPLETED: ['CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  survplan: {
    table: 'surveillance_plan',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ACTIVE', 'CEASED', 'ENTERED_IN_ERROR'] },
  },
  survcheck: {
    table: 'surveillance_check',
    initial: 'DUE',
    next: {
      DUE: ['PERFORMED', 'NOT_DONE', 'CANCELLED', 'ENTERED_IN_ERROR'], PERFORMED: ['RESULTED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      RESULTED: ['REVIEWED', 'ENTERED_IN_ERROR'], NOT_DONE: ['REVIEWED', 'CANCELLED', 'ENTERED_IN_ERROR'],
    },
  },
  screening: {
    table: 'screening',
    initial: 'ELIGIBLE',
    next: {
      ELIGIBLE: ['OFFERED', 'EXITED', 'ENTERED_IN_ERROR'], OFFERED: ['OFFERED', 'ACCEPTED', 'DECLINED', 'EXITED', 'ENTERED_IN_ERROR'],
      ACCEPTED: ['SCREENED', 'DECLINED', 'EXITED', 'ENTERED_IN_ERROR'], SCREENED: ['RESULTED', 'ENTERED_IN_ERROR'], RESULTED: ['REVIEWED', 'ENTERED_IN_ERROR'],
      REVIEWED: ['COMMUNICATED', 'ENTERED_IN_ERROR'], COMMUNICATED: ['CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  infection: {
    table: 'infection',
    initial: 'SUSPECTED',
    next: {
      SUSPECTED: ['CONFIRMED', 'NOT_INFECTION', 'ENTERED_IN_ERROR'], CONFIRMED: ['ONGOING', 'RESOLVED', 'ENTERED_IN_ERROR'],
      ONGOING: ['RESOLVED', 'ENTERED_IN_ERROR'], RESOLVED: ['RECURRED'],
    },
  },
  antimicrobial: {
    table: 'antimicrobial_course',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ACTIVE', 'CHANGED', 'COMPLETED', 'STOPPED', 'ENTERED_IN_ERROR'] },
  },
  sitecheck: {
    table: 'site_verification',
    initial: 'PLANNED',
    next: {
      PLANNED: ['DISCREPANCY', 'VERIFIED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      DISCREPANCY: ['PLANNED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      VERIFIED: ['DONE', 'DISCREPANCY', 'CANCELLED', 'ENTERED_IN_ERROR'],
    },
  },
  readiness: {
    table: 'readiness',
    initial: 'ASSESSING',
    next: {
      ASSESSING: ['READY', 'CONDITIONAL', 'NOT_READY', 'CLOSED', 'ENTERED_IN_ERROR'],
      READY: ['ASSESSING', 'CLOSED', 'ENTERED_IN_ERROR'],
      CONDITIONAL: ['ASSESSING', 'CLOSED', 'ENTERED_IN_ERROR'],
      NOT_READY: ['ASSESSING', 'CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  variance: {
    table: 'variance',
    initial: 'RECORDED',
    next: {
      RECORDED: ['MONITORING', 'CLOSED', 'ENTERED_IN_ERROR'],
      MONITORING: ['CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  declined: {
    table: 'declined_care',
    initial: 'DECLINED',
    next: {
      DECLINED: ['ESCALATED', 'ACCEPTED', 'CLOSED', 'ENTERED_IN_ERROR'],
      ESCALATED: ['DECLINED', 'ACCEPTED', 'CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  priority: {
    table: 'priority',
    initial: 'WAITING',
    next: { WAITING: ['ACTIONED', 'CANCELLED', 'ENTERED_IN_ERROR'] },
  },
  identity_match: {
    table: 'identity_match',
    initial: 'UNRESOLVED',
    next: { CONFIRMED: ['UNRESOLVED'], UNRESOLVED: ['RESOLVED'], RESOLVED: ['UNRESOLVED'] },
  },
  duplicate_case: {
    table: 'duplicate_case',
    initial: 'POSSIBLE',
    next: { POSSIBLE: ['NOT_DUPLICATE', 'RECONCILED'], NOT_DUPLICATE: ['POSSIBLE'], RECONCILED: ['POSSIBLE'] },
  },
  exceptional_access: {
    table: 'exceptional_access',
    initial: 'REQUESTED',
    next: { REQUESTED: ['ACTIVE', 'DECLINED', 'WITHDRAWN'], ACTIVE: ['ENDED'], ENDED: ['REVIEWED'] },
  },
  delegation: {
    table: 'delegation',
    initial: 'OFFERED',
    next: { OFFERED: ['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'], ACCEPTED: ['TO_REVIEW', 'COMPLETED', 'WITHDRAWN', 'EXPIRED'], TO_REVIEW: ['COMPLETED', 'ACCEPTED'] },
  },
  work_escalation: {
    table: 'work_escalation',
    initial: 'OPEN',
    next: { OPEN: ['ACKNOWLEDGED', 'RESOLVED', 'SUPERSEDED'], ACKNOWLEDGED: ['RESOLVED'] },
  },
  // Places, stays and allocations: the state changes that used to be made directly.
  bed: {
    table: 'bed',
    initial: 'AVAILABLE',
    next: { AVAILABLE: ['RESERVED', 'OCCUPIED', 'CLEANING'], RESERVED: ['AVAILABLE', 'OCCUPIED'], OCCUPIED: ['CLEANING'], CLEANING: ['AVAILABLE'] },
  },
  encounter: {
    table: 'encounter',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ENDED'] },
  },
  allocation: {
    table: 'allocation',
    initial: 'PROPOSED',
    next: { PROPOSED: ['ACTIVE', 'ENDED'], ACTIVE: ['ENDED'], LEGACY: ['ENDED'] },
  },
  clinical_event: {
    table: 'clinical_event',
    initial: 'CURRENT',
    next: { CURRENT: ['SUPERSEDED', 'ENTERED_IN_ERROR'] },
  },
  // Workforce and shared knowledge.
  leave_request: {
    table: 'leave_request',
    initial: 'REQUESTED',
    next: { REQUESTED: ['APPROVED', 'DECLINED', 'CANCELLED'] },
  },
  open_shift: {
    table: 'open_shift',
    initial: 'OPEN',
    next: { OPEN: ['FILLED', 'WITHDRAWN'] },
  },
  shift_offer: {
    table: 'shift_offer',
    initial: 'OFFERED',
    next: { OFFERED: ['WITHDRAWN', 'REASSIGNED', 'DECLINED'] },
  },
  roster_shift: {
    table: 'roster_shift',
    initial: 'PLANNED',
    next: { PLANNED: ['CANCELLED', 'REASSIGNED', 'ABSENT'] },
  },
  knowledge_question: {
    table: 'knowledge_question',
    initial: 'OPEN',
    next: { OPEN: ['CLOSED', 'WITHDRAWN'] },
  },
  downtime: {
    table: 'downtime',
    initial: 'DECLARED',
    next: { DECLARED: ['RESTORED', 'CANCELLED'], RESTORED: ['CLOSED'] },
  },
  allergy: {
    table: 'allergy',
    initial: 'ACTIVE',
    next: { ACTIVE: ['INACTIVE', 'ENTERED_IN_ERROR'], INACTIVE: ['ACTIVE'] },
  },
  precaution: {
    table: 'precaution',
    initial: 'REQUIRED',
    next: { REQUIRED: ['IN_PLACE', 'CEASED'], IN_PLACE: ['CEASED'] },
  },
  outbreak: {
    table: 'outbreak',
    initial: 'DECLARED',
    next: { DECLARED: ['CLOSED'] },
  },
  outbreak_person: {
    table: 'outbreak_person',
    initial: 'CASE',
    next: { CASE: ['RECOVERED'], WATCHING: ['CLEARED', 'BECAME_CASE'] },
  },
  consent: {
    table: 'consent',
    initial: 'CONSENTED',
    next: { CONSENTED: ['DONE', 'WITHDRAWN'], REFUSED: ['RECONSIDERED'], WITHDRAWN: ['RECONSIDERED'] },
  },
  eol_plan: {
    table: 'eol_plan',
    initial: 'PALLIATIVE',
    next: { PALLIATIVE: ['LAST_DAYS', 'ENDED'], LAST_DAYS: ['PALLIATIVE', 'ENDED'] },
  },
  safeguard: {
    table: 'safeguard',
    initial: 'RAISED',
    next: { RAISED: ['WORKING', 'CLOSED'], WORKING: ['CLOSED'] },
  },
  residency: {
    table: 'residency',
    initial: 'OFFERED',
    next: { OFFERED: ['ACCEPTED', 'LIVING_HERE', 'DECLINED'], ACCEPTED: ['LIVING_HERE', 'DECLINED'], LIVING_HERE: ['IN_HOSPITAL', 'ENDED'], IN_HOSPITAL: ['LIVING_HERE', 'ENDED'] },
  },
  complaint: {
    table: 'complaint',
    initial: 'RECEIVED',
    next: { RECEIVED: ['LOOKING', 'CLOSED'], LOOKING: ['RESPONDED', 'CLOSED'], RESPONDED: ['LOOKING', 'CLOSED'] },
  },
  device: {
    table: 'device',
    initial: 'IN_PLACE',
    next: { NEEDS_CHECK: ['IN_PLACE', 'REMOVED'], IN_PLACE: ['REMOVED'] },
  },
  person_handover: {
    table: 'person_handover',
    initial: 'GIVEN',
    next: { GIVEN: ['QUESTION', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'], QUESTION: ['GIVEN', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'] },
  },
  case_conference: {
    table: 'case_conference',
    initial: 'PLANNED',
    next: { PLANNED: ['HELD', 'CANCELLED'], HELD: ['CLOSED'] },
  },
  rehab_episode: {
    table: 'rehab_episode',
    initial: 'STARTED',
    next: { STARTED: ['NOT_READY', 'ACTIVE', 'CLOSED'], NOT_READY: ['ACTIVE', 'CLOSED'], ACTIVE: ['ENDING', 'CLOSED'], ENDING: ['ACTIVE', 'CLOSED'] },
  },
  test_order: {
    table: 'test_order',
    initial: 'ORDERED',
    next: { ORDERED: ['COLLECTED', 'RESULTED', 'CANCELLED'], COLLECTED: ['SENT', 'RESULTED', 'CANCELLED'], SENT: ['RESULTED'] },
  },
  clinical_procedure: {
    table: 'clinical_procedure',
    initial: 'PROPOSED',
    next: { PROPOSED: ['PLANNED', 'CANCELLED'], PLANNED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['RECOVERY'], RECOVERY: ['FINISHED'] },
  },
  clinical_decision: {
    table: 'clinical_decision',
    initial: 'OPEN',
    next: { OPEN: ['DECIDED', 'CLOSED'], DECIDED: ['OPEN', 'CLOSED'] },
  },
  withdrawal_episode: {
    table: 'withdrawal_episode',
    initial: 'ASSESSING',
    next: { ASSESSING: ['MANAGED', 'SETTLED', 'HANDED_ON'], MANAGED: ['SETTLED', 'HANDED_ON'] },
  },
  ed_observation: {
    table: 'ed_observation',
    initial: 'OBSERVING',
    next: { OBSERVING: ['ENDED'] },
  },
  danger_check: {
    table: 'danger_check',
    initial: 'CLEAR',
    next: { DANGER: ['MADE_SAFE'] },
  },
  toxic_exposure: {
    table: 'toxic_exposure',
    initial: 'ASSESSING',
    next: { ASSESSING: ['MONITORING', 'CLEARED', 'ADMITTED'], MONITORING: ['CLEARED', 'ADMITTED'] },
  },
  trauma_case: {
    table: 'trauma_case',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ADMITTED', 'COMPLETE'], ADMITTED: ['COMPLETE'] },
  },
  feed_plan: {
    table: 'feed_plan',
    initial: 'ACTIVE',
    next: { ACTIVE: ['STOPPED'] },
  },
  report: {
    table: 'patient_report',
    initial: 'RECORDED',
    next: { RECORDED: ['REVIEWED', 'SUPERSEDED'], REVIEWED: ['SUPERSEDED'] },
  },
  medication: {
    table: 'medication',
    initial: 'ACTIVE',
    next: { ORDERED: ['VERIFIED', 'ACTIVE', 'CEASED'], VERIFIED: ['ACTIVE', 'CEASED'], ACTIVE: ['HELD', 'CEASED'], HELD: ['ACTIVE', 'CEASED'] },
  },
  visit: {
    table: 'visit',
    initial: 'PLANNED',
    next: { PLANNED: ['DONE', 'NOT_DONE', 'CANCELLED'] },
  },
  pregnancy: {
    table: 'pregnancy',
    initial: 'ANTENATAL',
    next: { ANTENATAL: ['LABOUR', 'CLOSED', 'ENTERED_IN_ERROR'], LABOUR: ['BIRTHED', 'ENTERED_IN_ERROR'], BIRTHED: ['POSTNATAL', 'ENTERED_IN_ERROR'], POSTNATAL: ['CLOSED', 'ENTERED_IN_ERROR'] },
  },
  oxygen_therapy: {
    table: 'oxygen_therapy',
    initial: 'ON',
    next: { ON: ['WEANING', 'STOPPED'], WEANING: ['ON', 'STOPPED'] },
  },
  privacy_review: {
    table: 'privacy_review',
    initial: 'OPEN',
    next: { OPEN: ['FINDING'], FINDING: ['CLOSED'] },
  },
  records_hold: {
    table: 'records_hold',
    initial: 'ACTIVE',
    next: { ACTIVE: ['RELEASED'] },
  },
  records_review: {
    table: 'records_review',
    initial: 'DUE',
    next: { DUE: ['DECIDED'], DECIDED: ['DONE'] },
  },
  privacy_request: {
    table: 'privacy_request',
    initial: 'RECEIVED',
    next: { RECEIVED: ['CHECKED', 'WITHDRAWN'], CHECKED: ['DECIDED', 'WITHDRAWN'], DECIDED: ['CLOSED'] },
  },
  coding: {
    table: 'coding_case',
    initial: 'REQUIRED',
    next: { REQUIRED: ['IN_PROGRESS'], IN_PROGRESS: ['FINALISED'], FINALISED: ['IN_PROGRESS'] },
  },
  codingquery: {
    table: 'coding_query',
    initial: 'OPEN',
    next: { OPEN: ['ANSWERED', 'WITHDRAWN'] },
  },
  external: {
    table: 'external_info',
    initial: 'RECEIVED',
    next: { RECEIVED: ['MATCHED', 'NOT_OURS'], MATCHED: ['INCORPORATED', 'REFERENCED', 'SUPERSEDED'], INCORPORATED: ['SUPERSEDED'], REFERENCED: ['SUPERSEDED'] },
  },
  commneed: {
    table: 'comm_need',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ENDED'] },
  },
  interpreter: {
    table: 'interpreter_booking',
    initial: 'REQUESTED',
    next: { REQUESTED: ['BOOKED', 'CANCELLED'], BOOKED: ['PROVIDED', 'NOT_PROVIDED', 'CANCELLED'] },
  },
  supportperson: {
    table: 'support_person',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ENDED'] },
  },
  capacity: {
    table: 'capacity_assessment',
    initial: 'RAISED',
    next: { RAISED: ['DETERMINED', 'WITHDRAWN'], DETERMINED: ['SUPERSEDED'] },
  },
  preference: {
    table: 'preference',
    initial: 'ACTIVE',
    next: { ACTIVE: ['SUPERSEDED', 'WITHDRAWN'] },
  },
  leave: {
    table: 'leave_of_absence',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['APPROVED', 'DECLINED', 'CANCELLED'],
      APPROVED: ['AWAY', 'CANCELLED'],
      AWAY: ['RETURNED', 'NOT_RETURNED'],
      NOT_RETURNED: ['RETURNED'],
    },
  },
  restriction: {
    table: 'restriction',
    initial: 'PROPOSED',
    next: { PROPOSED: ['ACTIVE', 'DECLINED'], ACTIVE: ['SUPERSEDED', 'CEASED'] },
  },
  monitoring: {
    table: 'monitoring_plan',
    initial: 'ACTIVE',
    next: { ACTIVE: ['SUPERSEDED', 'CEASED'] },
  },
  result: {
    table: 'result',
    initial: 'AVAILABLE',
    next: { AVAILABLE: ['REVIEWED', 'CORRECTED'], REVIEWED: ['ACTIONED', 'CORRECTED'], ACTIONED: ['CORRECTED'] },
  },
};

export interface TransitionActor {
  actorId: string | null;
  workContextId: string | null;
  transactionId?: string | null;
}

export function recordInitial(store: Store, type: string, objectId: string, state: string, a: TransitionActor, reason?: string): void {
  store.insert('state_transition', {
    id: newId(), object_type: type, object_id: objectId, from_state: null, to_state: state,
    actor_id: a.actorId, work_context_id: a.workContextId, at: now(), reason: reason ?? null, transaction_id: a.transactionId ?? null,
  });
}

export function transition(store: Store, type: string, objectId: string, to: string, a: TransitionActor, reason?: string): string {
  const lc = LIFECYCLES[type];
  if (!lc) throw new Error(`Unknown lifecycle ${type}`);
  return store.tx(() => {
    const row = store.get<{ state: string }>(`SELECT state FROM ${lc.table} WHERE id = ?`, objectId);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That item no longer exists.');
    const allowed = lc.next[row.state] ?? [];
    if (!allowed.includes(to)) {
      throw new HttpError(409, 'INVALID_TRANSITION', `This ${type} is ${row.state.toLowerCase().replace('_', ' ')} and cannot move to ${to.toLowerCase().replace('_', ' ')}.`);
    }
    store.run(`UPDATE ${lc.table} SET state = ? WHERE id = ?`, to, objectId);
    store.insert('state_transition', {
      id: newId(), object_type: type, object_id: objectId, from_state: row.state, to_state: to,
      actor_id: a.actorId, work_context_id: a.workContextId, at: now(), reason: reason ?? null, transaction_id: a.transactionId ?? null,
    });
    return row.state;
  });
}

export function history(store: Store, type: string, objectId: string) {
  return store.all<{ from_state: string | null; to_state: string; at: string; actor: string | null; reason: string | null }>(
    `SELECT t.from_state, t.to_state, t.at, w.display_name AS actor, t.reason
       FROM state_transition t LEFT JOIN workforce_person w ON w.id = t.actor_id
      WHERE t.object_type = ? AND t.object_id = ? ORDER BY t.at, t.rowid`,
    type, objectId,
  );
}

// Move every row matching `where` that may make this move, each through a valid transition.
export function transitionAll(store: Store, type: string, where: string, params: unknown[], to: string, a: TransitionActor, reason?: string): string[] {
  const lc = LIFECYCLES[type];
  if (!lc) throw new Error(`Unknown lifecycle ${type}`);
  const from = Object.entries(lc.next).filter(([, n]) => n.includes(to)).map(([f]) => f);
  if (!from.length) return [];
  const rows = store.all<{ id: string }>(
    `SELECT id FROM ${lc.table} WHERE (${where}) AND state IN (${from.map(() => '?').join(', ')})`, ...params, ...from,
  );
  for (const r of rows) transition(store, type, r.id, to, a, reason);
  return rows.map((r) => r.id);
}

// A change to what an object says (not its state): keep each old and new value with who, when and why.
export function revise(
  store: Store, type: string, objectId: string, before: Record<string, unknown>, after: Record<string, unknown>,
  labels: Record<string, string | [string, Record<string, string>]>, a: TransitionActor, why: string,
): string {
  const at = now();
  const shown = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : String(v));
  const changed: string[] = [];
  for (const [field, l] of Object.entries(labels)) {
    const [label, codes] = typeof l === 'string' ? [l, null] : l;
    const say = (v: unknown) => shown(codes && v !== null && v !== undefined ? codes[String(v)] ?? v : v);
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (String(from ?? '') === String(to ?? '')) continue;
    store.insert('object_revision', {
      id: newId(), object_type: type, object_id: objectId, field, from_value: from === null ? null : String(from), to_value: to === null ? null : String(to),
      actor_id: a.actorId, work_context_id: a.workContextId, at, reason: why,
    });
    changed.push(`${label}: ${say(from)} → ${say(to)}`);
  }
  return changed.join('; ');
}

