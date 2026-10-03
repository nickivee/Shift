// Workstation configurations derived from the NZ Workstation Matrix 2026 rows. The matrix
// defines capabilities, not pages; only capabilities SHIFT has implemented are listed, and
// each row keeps its matrix evidence status. This is ORGANISATIONAL CONFIGURATION.

export type Capability =
  | 'record.view'
  | 'event.create'
  | 'event.amend'
  | 'route.send'
  | 'route.receive'
  | 'task.manage'
  | 'handover.use'
  | 'result.review'
  | 'knowledge.use'
  | 'roster.decide'
  | 'transfer.request'
  | 'transfer.accept'
  | 'transfer.arrive'
  | 'bed.manage'
  | 'discharge.plan'
  | 'discharge.decide'
  | 'discharge.complete'
  | 'escalation.raise'
  | 'escalation.respond'
  | 'consult.request'
  | 'consult.respond'
  | 'wound.identify'
  | 'wound.manage'
  | 'careplan.manage'
  | 'referral.request'
  | 'referral.authorise'
  | 'referral.triage'
  | 'appointment.manage'
  | 'alert.raise'
  | 'communication.manage'
  | 'monitoring.plan'
  | 'monitoring.record'
  | 'restriction.manage'
  | 'restriction.check'
  | 'diet.order'
  | 'meal.record'
  | 'equipment.use'
  | 'equipment.manage'
  | 'bed.request'
  | 'leave.manage'
  | 'leave.approve'
  | 'preference.record'
  | 'capacity.concern'
  | 'capacity.assess'
  | 'whanau.manage'
  | 'rules.manage'
  | 'rules.approve'
  | 'access.manage'
  | 'external.manage'
  | 'coding.assign'
  | 'coding.answer'
  | 'report.record'
  | 'report.review'
  | 'instrument.use'
  | 'function.assess'
  | 'usual.record'
  | 'usual.act'
  | 'assignment.propose'
  | 'assignment.confirm'
  | 'allocation.plan'
  | 'allocation.confirm'
  | 'acuity.assess'
  | 'deterioration.record'
  | 'deterioration.manage'
  | 'incident.report'
  | 'incident.review'
  | 'death.record'
  | 'death.manage'
  | 'problem.record'
  | 'problem.manage'
  | 'symptom.record'
  | 'symptom.manage'
  | 'intervention.record'
  | 'intervention.plan'
  | 'intervention.authorise'
  | 'treatmentplan.record'
  | 'treatmentplan.plan'
  | 'treatmentplan.authorise'
  | 'pathway.record'
  | 'pathway.manage'
  | 'checklist.record'
  | 'checklist.manage'
  | 'recommendation.make'
  | 'recommendation.respond'
  | 'recommendation.record'
  | 'requirement.record'
  | 'requirement.manage'
  | 'due.record'
  | 'due.manage'
  | 'recall.manage'
  | 'followup.manage'
  | 'surveillance.record'
  | 'surveillance.review'
  | 'screening.record'
  | 'screening.review'
  | 'infection.record'
  | 'infection.confirm'
  | 'antimicrobial.record'
  | 'antimicrobial.decide'
  | 'sitecheck.record'
  | 'sitecheck.resolve'
  | 'readiness.record'
  | 'readiness.assess'
  | 'variance.record'
  | 'variance.decide'
  | 'declined.record'
  | 'declined.respond'
  | 'priority.assign'
  | 'priority.downgrade'
  | 'identity.register'
  | 'identity.correct'
  | 'duplicate.flag'
  | 'duplicate.resolve'
  | 'access.approve'
  | 'delegation.give'
  | 'delegation.take'
  | 'decision.respond'
  | 'downtime.manage'
  | 'record.reconcile'
  | 'precaution.manage'
  | 'outbreak.manage'
  | 'allergy.record'
  | 'allergy.report'
  | 'consent.record'
  | 'palliative.manage'
  | 'palliative.comfort'
  | 'safeguarding.raise'
  | 'safeguarding.manage'
  | 'residency.manage'
  | 'complaint.record'
  | 'complaint.manage'
  | 'device.record'
  | 'device.report'
  | 'conference.manage'
  | 'conference.view'
  | 'rehab.manage'
  | 'rehab.view'
  | 'test.order'
  | 'test.collect'
  | 'result.receive'
  | 'result.relay'
  | 'procedure.manage'
  | 'procedure.recover'
  | 'decision.manage'
  | 'decision.view'
  | 'poison.manage'
  | 'poison.record'
  | 'trauma.manage'
  | 'trauma.record'
  | 'trauma.tertiary'
  | 'trauma.view'
  | 'feed.plan'
  | 'feed.give'
  | 'feed.view'
  | 'equipment.lend'
  | 'staffing.report'
  | 'coroner.decide'
  | 'major.manage'
  | 'withdrawal.manage'
  | 'withdrawal.record'
  | 'danger.record'
  | 'observation.manage'
  | 'observation.view'
  | 'privacy.manage'
  | 'oxygen.prescribe'
  | 'oxygen.record'
  | 'medicine.prescribe'
  | 'medicine.give'
  | 'cd.register'
  | 'visit.plan'
  | 'visit.record'
  | 'pregnancy.record'
  | 'afterhours.record'
  | 'education.record';

export interface HomeCard {
  id: string;
  label: string;
  required: boolean;   // organisation-required: may be moved, never hidden
}

export interface WorkstationTab {
  id: string;          // matches a retrieve view code, or 'list' for the patient list
  label: string;       // label as it appears in the matrix row
}

export interface RoleConfig {
  roleKey: string;
  label: string;
  matrixRow: string;
  evidenceStatus: string;
  profession: string | null;          // authority that must be CURRENT to act clinically
  capabilities: Capability[];
  keys: string[];
  views: string[];
  tabs: WorkstationTab[];
  homeCards: HomeCard[];
  ownViews?: string[];                // the department's own record screens, shown by default; the rest are added by the worker
  ownCards?: string[];                // the department's own functions
  homeFour?: string[];                // the four functions on Home until the worker chooses their own
  board?: boolean;                    // list shows triage category and time in department
  escalatesTo?: string[];             // role keys, in the responsible service, this role escalates to
  consultsTo?: string[];              // role keys, in this organisation, this role can ask for advice
  refersTo?: string[];                // service ids, in this organisation, this role can refer to
}

const CARD = {
  workstation: { id: 'workstation', label: 'Workstation', required: true },
  tasks: { id: 'tasks', label: 'Tasks', required: true },
  search: { id: 'search', label: 'Search', required: false },
  handover: { id: 'handover', label: 'Handover', required: true },
  received: { id: 'received', label: 'Received', required: true },
  knowledge: { id: 'knowledge', label: 'Shared knowledge', required: false },
  vacancies: { id: 'vacancies', label: 'Staffing and vacancies', required: true },
  swaps: { id: 'swaps', label: 'Swaps', required: true },
  leave: { id: 'leave', label: 'Leave', required: true },
  transfers: { id: 'transfers', label: 'Transfers', required: true },
  flow: { id: 'flow', label: 'Flow board', required: true },
  discharges: { id: 'discharges', label: 'Discharges', required: true },
  escalations: { id: 'escalations', label: 'Escalations', required: true },
  consults: { id: 'consults', label: 'Consultations', required: true },
  wounds: { id: 'wounds', label: 'Wound reviews', required: true },
  careplans: { id: 'careplans', label: 'Care plan reviews', required: true },
  referrals: { id: 'referrals', label: 'Referrals', required: true },
  appointments: { id: 'appointments', label: 'Appointments', required: true },
  alerts: { id: 'alerts', label: 'Alerts', required: true },
  communications: { id: 'communications', label: 'Communications', required: true },
  monitoring: { id: 'monitoring', label: 'Monitoring due', required: true },
  restrictions: { id: 'restrictions', label: 'Restrictions', required: true },
  meals: { id: 'meals', label: 'Diets and meals', required: true },
  equipment: { id: 'equipment', label: 'Equipment', required: true },
  moves: { id: 'moves', label: 'Bed moves', required: true },
  absences: { id: 'absences', label: 'Leave and outings', required: true },
  preferences: { id: 'preferences', label: 'Preferences', required: true },
  capacity: { id: 'capacity', label: 'Capacity assessments', required: true },
  whanau: { id: 'whanau', label: 'Whānau and support', required: true },
  interpreters: { id: 'interpreters', label: 'Interpreters', required: true },
  external: { id: 'external', label: 'From other providers', required: true },
  coding: { id: 'coding', label: 'Clinical coding', required: true },
  privacy: { id: 'privacy', label: 'Privacy requests', required: true },
  cdbook: { id: 'cdbook', label: 'Controlled drug book', required: true },
  rules: { id: 'rules', label: 'Rules and settings', required: true },
  codingqueries: { id: 'codingqueries', label: 'Coding questions', required: true },
  reports: { id: 'reports', label: 'In their own words', required: true },
  instruments: { id: 'instruments', label: 'Questionnaires', required: true },
  function: { id: 'function', label: 'Function', required: true },
  usual: { id: 'usual', label: 'Different from usual', required: true },
  team: { id: 'team', label: 'Care team', required: true },
  incidents: { id: 'incidents', label: 'Incidents and complaints', required: true },
  deterioration: { id: 'deterioration', label: 'Deterioration', required: true },
  acuity: { id: 'acuity', label: 'Clinical status', required: true },
  allocation: { id: 'allocation', label: 'Patient allocation', required: true },
  deaths: { id: 'deaths', label: 'Deaths', required: true },
  problems: { id: 'problems', label: 'Problem list', required: true },
  symptoms: { id: 'symptoms', label: 'Symptoms', required: true },
  interventions: { id: 'interventions', label: 'Interventions', required: true },
  treatmentplans: { id: 'treatmentplans', label: 'Treatment plans', required: true },
  pathways: { id: 'pathways', label: 'Pathways', required: true },
  checklists: { id: 'checklists', label: 'Checklists', required: true },
  recommendations: { id: 'recommendations', label: 'Recommendations', required: true },
  requirements: { id: 'requirements', label: 'Requirements', required: true },
  caredue: { id: 'caredue', label: 'Care due', required: true },
  recalls: { id: 'recalls', label: 'Recalls', required: true },
  followups: { id: 'followups', label: 'Follow-ups', required: true },
  visits: { id: 'visits', label: 'Visits', required: true },
  afterhours: { id: 'afterhours', label: 'After-hours', required: true },
  education: { id: 'education', label: 'Education', required: true },
  surveillance: { id: 'surveillance', label: 'Surveillance', required: true },
  screening: { id: 'screening', label: 'Screening', required: true },
  infections: { id: 'infections', label: 'Infections', required: true },
  antimicrobials: { id: 'antimicrobials', label: 'Antimicrobials', required: true },
  sitechecks: { id: 'sitechecks', label: 'Site checks', required: true },
  readiness: { id: 'readiness', label: 'Readiness', required: true },
  variances: { id: 'variances', label: 'Variances', required: true },
  declined: { id: 'declined', label: 'Declined care', required: true },
  priorities: { id: 'priorities', label: 'Priorities', required: true },
  arrivals: { id: 'arrivals', label: 'Arrivals', required: true },
  duplicates: { id: 'duplicates', label: 'Duplicate records', required: true },
  breakglass: { id: 'breakglass', label: 'Break-glass access', required: true },
  delegation: { id: 'delegation', label: 'Delegation', required: true },
  downtime: { id: 'downtime', label: 'Downtime', required: true },
} satisfies Record<string, HomeCard>;

export const ROLES: RoleConfig[] = [
  {
    roleKey: 'arc-rn',
    label: 'Registered Nurse',
    matrixRow: 'Aged residential care - RN',
    evidenceStatus: 'Ngā Paerewa/community specifications; disability funding boundaries may sit outside health',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'escalation.raise', 'escalation.respond', 'wound.identify', 'wound.manage', 'careplan.manage', 'alert.raise', 'communication.manage', 'monitoring.plan', 'monitoring.record', 'restriction.check', 'restriction.manage', 'diet.order', 'meal.record', 'equipment.use', 'equipment.manage', 'leave.manage', 'leave.approve', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'deterioration.record', 'incident.report', 'incident.review', 'deterioration.manage', 'usual.act', 'acuity.assess', 'assignment.propose', 'allocation.plan', 'allocation.confirm', 'assignment.confirm', 'report.review', 'instrument.use', 'function.assess', 'death.record', 'death.manage', 'problem.record', 'problem.manage', 'symptom.record', 'symptom.manage', 'intervention.record', 'intervention.plan', 'treatmentplan.record', 'treatmentplan.plan', 'pathway.record', 'pathway.manage', 'checklist.record', 'checklist.manage', 'recommendation.record', 'recommendation.make', 'recommendation.respond', 'requirement.record', 'requirement.manage', 'due.record', 'due.manage', 'recall.manage', 'followup.manage', 'surveillance.record', 'surveillance.review', 'screening.record', 'screening.review', 'infection.record', 'infection.confirm', 'antimicrobial.record', 'antimicrobial.decide', 'sitecheck.record', 'sitecheck.resolve', 'readiness.record', 'readiness.assess', 'variance.record', 'variance.decide', 'declined.record', 'declined.respond', 'priority.assign', 'priority.downgrade', 'identity.register', 'identity.correct', 'duplicate.flag', 'duplicate.resolve', 'access.approve', 'delegation.give', 'decision.respond', 'downtime.manage', 'record.reconcile', 'precaution.manage', 'outbreak.manage', 'allergy.record', 'consent.record', 'palliative.manage', 'safeguarding.manage', 'residency.manage', 'complaint.manage', 'device.record', 'conference.manage', 'result.receive', 'result.relay', 'feed.plan', 'feed.give', 'staffing.report', 'coroner.decide', 'medicine.give', 'cd.register'],
    keys: ['.obs', '.bgl', '.weight', '.pain', '.wound', '.skin', '.fall', '.intake', '.cares', '.behaviour', '.change', '.family', '.assess', '.review', '.progress', '.task'],
    views: ['overview', 'history', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'nutrition', 'cares', 'behaviour', 'changes', 'family', 'assess', 'review', 'progress', 'notes', 'meds', 'results', 'allergies', 'careplan', 'tasks', 'handover', 'routes', 'escalations', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'absence', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team', 'acuity', 'deterioration', 'incidents', 'death', 'problems', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'checklists', 'recommendations', 'requirements', 'caredue', 'recalls', 'followups', 'surveillance', 'screening', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'priorities', 'identity'],
    tabs: [
      { id: 'list', label: 'Resident List' },
      { id: 'overview', label: 'Resident Overview' },
      { id: 'assess', label: 'Assessment' },
      { id: 'careplan', label: 'Care Plan' },
      { id: 'obs', label: 'Observations' },
      { id: 'meds', label: 'Medicines' },
      { id: 'wounds', label: 'Wounds' },
      { id: 'falls', label: 'Falls' },
      { id: 'nutrition', label: 'Nutrition' },
      { id: 'behaviour', label: 'Behaviour' },
      { id: 'family', label: 'Family' },
      { id: 'review', label: 'Review' },
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.escalations, CARD.wounds, CARD.careplans, CARD.alerts, CARD.communications, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.absences, CARD.preferences, CARD.whanau, CARD.interpreters, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team, CARD.acuity, CARD.deterioration, CARD.incidents, CARD.allocation, CARD.deaths, CARD.problems, CARD.symptoms, CARD.interventions, CARD.treatmentplans, CARD.pathways, CARD.checklists, CARD.recommendations, CARD.requirements, CARD.caredue, CARD.recalls, CARD.followups, CARD.surveillance, CARD.screening, CARD.infections, CARD.antimicrobials, CARD.sitechecks, CARD.readiness, CARD.variances, CARD.declined, CARD.priorities, CARD.arrivals, CARD.duplicates, CARD.breakglass, CARD.delegation, CARD.downtime, CARD.cdbook],
    ownViews: ['overview', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'nutrition', 'cares', 'behaviour', 'changes', 'assess', 'careplan', 'progress', 'notes', 'meds', 'results', 'allergies', 'tasks', 'handover', 'family', 'alerts', 'escalations', 'monitoring', 'diet', 'absence', 'preferences', 'capacity', 'support', 'infections', 'instruments', 'incidents', 'death', 'declined', 'equipment'],
    homeFour: ['workstation', 'tasks', 'handover', 'escalations'],
    ownCards: ['workstation', 'tasks', 'search', 'handover', 'received', 'escalations', 'wounds', 'careplans', 'alerts', 'communications', 'monitoring', 'meals', 'absences', 'preferences', 'whanau', 'instruments', 'deterioration', 'incidents', 'allocation', 'deaths', 'infections', 'declined', 'arrivals', 'duplicates', 'breakglass', 'delegation', 'downtime', 'cdbook'],
  },
  {
    roleKey: 'arc-caregiver',
    label: 'Caregiver / Kaiāwhina',
    matrixRow: 'Aged residential care - caregiver/kaiāwhina',
    evidenceStatus: 'Ngā Paerewa/community specifications; disability funding boundaries may sit outside health',
    profession: null,
    capabilities: ['record.view', 'event.create', 'route.send', 'task.manage', 'handover.use', 'escalation.raise', 'wound.identify', 'alert.raise', 'monitoring.record', 'restriction.check', 'meal.record', 'equipment.use', 'preference.record', 'report.record', 'usual.record', 'deterioration.record', 'incident.report', 'death.record', 'problem.record', 'symptom.record', 'intervention.record', 'treatmentplan.record', 'pathway.record', 'checklist.record', 'recommendation.record', 'requirement.record', 'due.record', 'surveillance.record', 'delegation.take', 'allergy.report', 'palliative.comfort', 'safeguarding.raise', 'complaint.record', 'device.report', 'conference.view', 'feed.view'],
    keys: ['.obs', '.weight', '.cares', '.intake', '.skin', '.behaviour', '.change', '.pain', '.fall', '.progress'],
    views: ['overview', 'careplan', 'cares', 'nutrition', 'intake', 'skin', 'behaviour', 'tasks', 'changes', 'notes', 'obs', 'allergies', 'handover', 'escalations', 'wounds', 'alerts', 'monitoring', 'restrictions', 'diet', 'equipment', 'absence', 'preferences', 'support', 'access', 'reported', 'function', 'usual', 'team', 'acuity', 'deterioration', 'incidents', 'death', 'problems', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'checklists', 'recommendations', 'requirements', 'caredue', 'recalls', 'followups', 'surveillance', 'screening', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'priorities'],
    tabs: [
      { id: 'list', label: 'Allocation' },
      { id: 'careplan', label: 'Care Plan' },
      { id: 'cares', label: 'Daily Care' },
      { id: 'nutrition', label: 'Nutrition/Fluids' },
      { id: 'skin', label: 'Skin' },
      { id: 'behaviour', label: 'Behaviour' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'changes', label: 'Changes/Escalation' },
      { id: 'notes', label: 'Notes' },
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.escalations, CARD.alerts, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.preferences, CARD.requirements, CARD.caredue, CARD.delegation, CARD.downtime],
    ownViews: ['overview', 'careplan', 'cares', 'nutrition', 'intake', 'skin', 'behaviour', 'changes', 'obs', 'notes', 'tasks', 'allergies', 'handover', 'escalations', 'alerts', 'diet', 'preferences', 'absence', 'usual', 'death', 'incidents', 'equipment'],
    homeFour: ['workstation', 'tasks', 'handover', 'caredue'],
    ownCards: ['workstation', 'tasks', 'search', 'handover', 'escalations', 'alerts', 'meals', 'preferences', 'caredue', 'delegation'],
    escalatesTo: ['arc-rn'],
  },
  {
    roleKey: 'genmed-rn',
    label: 'Registered Nurse',
    matrixRow: 'General Medicine - RN',
    evidenceStatus: 'Workflow-derived; specialty verification required',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'transfer.arrive', 'bed.manage', 'discharge.plan', 'discharge.complete', 'escalation.raise', 'wound.identify', 'wound.manage', 'careplan.manage', 'referral.request', 'alert.raise', 'communication.manage', 'monitoring.plan', 'monitoring.record', 'restriction.check', 'restriction.manage', 'diet.order', 'meal.record', 'equipment.use', 'equipment.manage', 'bed.request', 'leave.manage', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'deterioration.record', 'incident.report', 'incident.review', 'deterioration.manage', 'usual.act', 'acuity.assess', 'assignment.propose', 'allocation.plan', 'allocation.confirm', 'report.review', 'instrument.use', 'function.assess', 'death.record', 'death.manage', 'problem.record', 'problem.manage', 'symptom.record', 'symptom.manage', 'intervention.record', 'intervention.plan', 'treatmentplan.record', 'treatmentplan.plan', 'pathway.record', 'pathway.manage', 'checklist.record', 'checklist.manage', 'recommendation.record', 'recommendation.make', 'recommendation.respond', 'requirement.record', 'requirement.manage', 'due.record', 'due.manage', 'recall.manage', 'followup.manage', 'surveillance.record', 'screening.record', 'infection.record', 'antimicrobial.record', 'sitecheck.record', 'readiness.record', 'variance.record', 'declined.record', 'priority.assign', 'duplicate.flag', 'delegation.take', 'decision.respond', 'downtime.manage', 'record.reconcile', 'precaution.manage', 'outbreak.manage', 'allergy.record', 'consent.record', 'palliative.manage', 'safeguarding.manage', 'complaint.manage', 'device.record', 'conference.manage', 'rehab.view', 'test.collect', 'result.receive', 'procedure.recover', 'decision.view', 'trauma.view', 'feed.plan', 'feed.give', 'withdrawal.record', 'oxygen.record', 'medicine.give', 'cd.register'],
    keys: ['.obs', '.bgl', '.weight', '.pain', '.wound', '.skin', '.fall', '.intake', '.assess', '.change', '.family', '.progress', '.task'],
    views: ['overview', 'history', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'assess', 'changes', 'family', 'progress', 'notes', 'meds', 'results', 'allergies', 'careplan', 'tasks', 'handover', 'routes', 'transfers', 'discharge', 'escalations', 'referrals', 'appointments', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'location', 'absence', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team', 'acuity', 'deterioration', 'incidents', 'death', 'problems', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'checklists', 'recommendations', 'requirements', 'caredue', 'recalls', 'followups', 'surveillance', 'screening', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'priorities', 'identity', 'procedures'],
    tabs: [
      { id: 'list', label: 'Allocation' },
      { id: 'overview', label: 'Overview' },
      { id: 'assess', label: 'Assessment' },
      { id: 'careplan', label: 'Care Plan' },
      { id: 'obs', label: 'Observations' },
      { id: 'meds', label: 'Medicines' },
      { id: 'intake', label: 'Intake/Output' },
      { id: 'skin', label: 'Skin/Wounds' },
      { id: 'results', label: 'Results' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'notes', label: 'Notes' },
      { id: 'handover', label: 'Handover' },
      { id: 'discharge', label: 'Discharge' },
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.transfers, CARD.discharges, CARD.escalations, CARD.wounds, CARD.careplans, CARD.referrals, CARD.alerts, CARD.communications, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.moves, CARD.absences, CARD.preferences, CARD.whanau, CARD.interpreters, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team, CARD.acuity, CARD.deterioration, CARD.incidents, CARD.allocation, CARD.deaths, CARD.problems, CARD.symptoms, CARD.interventions, CARD.treatmentplans, CARD.pathways, CARD.checklists, CARD.recommendations, CARD.requirements, CARD.caredue, CARD.recalls, CARD.followups, CARD.surveillance, CARD.screening, CARD.infections, CARD.antimicrobials, CARD.sitechecks, CARD.readiness, CARD.variances, CARD.declined, CARD.priorities, CARD.delegation, CARD.downtime, CARD.cdbook],
    ownViews: ['overview', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'assess', 'changes', 'family', 'progress', 'notes', 'meds', 'results', 'allergies', 'careplan', 'tasks', 'handover', 'escalations', 'alerts', 'monitoring', 'diet', 'location', 'transfers', 'discharge', 'deterioration', 'caredue', 'checklists', 'infections', 'incidents', 'capacity', 'death', 'equipment', 'procedures'],
    homeFour: ['workstation', 'tasks', 'handover', 'escalations'],
    ownCards: ['workstation', 'tasks', 'search', 'handover', 'received', 'transfers', 'discharges', 'escalations', 'wounds', 'careplans', 'alerts', 'monitoring', 'meals', 'moves', 'deterioration', 'incidents', 'allocation', 'caredue', 'checklists', 'infections', 'delegation', 'downtime', 'cdbook'],
    escalatesTo: ['genmed-physician'],
    refersTo: ['svc-physio'],
  },
  {
    roleKey: 'genmed-physician',
    label: 'Physician',
    matrixRow: 'General Medicine - physician',
    evidenceStatus: 'Workflow-derived; specialty verification required',
    profession: 'Medical Practitioner',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'result.review', 'knowledge.use', 'transfer.request', 'transfer.accept', 'discharge.plan', 'discharge.decide', 'escalation.raise', 'escalation.respond', 'consult.request', 'consult.respond', 'referral.request', 'referral.authorise', 'referral.triage', 'appointment.manage', 'alert.raise', 'communication.manage', 'monitoring.plan', 'restriction.check', 'restriction.manage', 'diet.order', 'equipment.use', 'bed.request', 'leave.manage', 'leave.approve', 'preference.record', 'capacity.concern', 'capacity.assess', 'whanau.manage', 'access.manage', 'external.manage', 'coding.answer', 'report.record', 'usual.record', 'deterioration.record', 'incident.report', 'incident.review', 'deterioration.manage', 'usual.act', 'acuity.assess', 'assignment.propose', 'assignment.confirm', 'report.review', 'instrument.use', 'function.assess', 'death.record', 'death.manage', 'problem.record', 'problem.manage', 'symptom.record', 'symptom.manage', 'intervention.record', 'intervention.plan', 'intervention.authorise', 'treatmentplan.record', 'treatmentplan.plan', 'treatmentplan.authorise', 'pathway.record', 'pathway.manage', 'checklist.record', 'checklist.manage', 'recommendation.record', 'recommendation.make', 'recommendation.respond', 'requirement.record', 'requirement.manage', 'due.record', 'due.manage', 'recall.manage', 'followup.manage', 'surveillance.record', 'surveillance.review', 'screening.record', 'screening.review', 'infection.record', 'infection.confirm', 'antimicrobial.record', 'antimicrobial.decide', 'sitecheck.record', 'sitecheck.resolve', 'readiness.record', 'readiness.assess', 'variance.record', 'variance.decide', 'declined.record', 'declined.respond', 'priority.assign', 'priority.downgrade', 'duplicate.flag', 'duplicate.resolve', 'access.approve', 'delegation.give', 'decision.respond', 'record.reconcile', 'precaution.manage', 'allergy.record', 'consent.record', 'palliative.manage', 'safeguarding.manage', 'complaint.manage', 'device.record', 'conference.manage', 'rehab.view', 'test.order', 'test.collect', 'result.receive', 'procedure.manage', 'decision.manage', 'trauma.tertiary', 'feed.plan', 'coroner.decide', 'withdrawal.manage', 'oxygen.prescribe', 'medicine.prescribe'],
    keys: ['.review', '.problem', '.assess', '.progress', '.family', '.task'],
    views: ['overview', 'history', 'problems', 'assess', 'review', 'meds', 'results', 'obs', 'progress', 'allergies', 'careplan', 'tasks', 'handover', 'routes', 'family', 'transfers', 'discharge', 'escalations', 'consults', 'wounds', 'referrals', 'appointments', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'location', 'absence', 'preferences', 'capacity', 'support', 'access', 'external', 'coding', 'reported', 'instruments', 'function', 'usual', 'team', 'acuity', 'deterioration', 'incidents', 'death', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'checklists', 'recommendations', 'requirements', 'caredue', 'recalls', 'followups', 'surveillance', 'screening', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'priorities', 'identity', 'procedures'],
    tabs: [
      { id: 'list', label: 'Patient List' },
      { id: 'overview', label: 'Overview' },
      { id: 'history', label: 'History' },
      { id: 'problems', label: 'Problems' },
      { id: 'assess', label: 'Assessment' },
      { id: 'meds', label: 'Medicines' },
      { id: 'results', label: 'Results' },
      { id: 'progress', label: 'Progress' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'discharge', label: 'Discharge' },
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.knowledge, CARD.transfers, CARD.discharges, CARD.escalations, CARD.consults, CARD.referrals, CARD.appointments, CARD.alerts, CARD.communications, CARD.restrictions, CARD.meals, CARD.absences, CARD.capacity, CARD.external, CARD.codingqueries, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team, CARD.acuity, CARD.deterioration, CARD.incidents, CARD.deaths, CARD.problems, CARD.symptoms, CARD.interventions, CARD.treatmentplans, CARD.pathways, CARD.checklists, CARD.recommendations, CARD.requirements, CARD.caredue, CARD.recalls, CARD.followups, CARD.surveillance, CARD.screening, CARD.infections, CARD.antimicrobials, CARD.sitechecks, CARD.readiness, CARD.variances, CARD.declined, CARD.priorities, CARD.duplicates, CARD.breakglass, CARD.delegation, CARD.downtime],
    ownViews: ['overview', 'history', 'problems', 'assess', 'review', 'meds', 'results', 'obs', 'progress', 'allergies', 'tasks', 'handover', 'family', 'consults', 'referrals', 'transfers', 'discharge', 'escalations', 'alerts', 'deterioration', 'treatmentplans', 'pathways', 'antimicrobials', 'capacity', 'recommendations', 'followups', 'death', 'incidents', 'procedures'],
    homeFour: ['workstation', 'tasks', 'consults', 'discharges'],
    ownCards: ['workstation', 'tasks', 'search', 'handover', 'received', 'knowledge', 'transfers', 'discharges', 'escalations', 'consults', 'referrals', 'alerts', 'codingqueries', 'deterioration', 'problems', 'treatmentplans', 'pathways', 'antimicrobials', 'followups', 'deaths', 'duplicates', 'breakglass', 'delegation'],
    consultsTo: ['physio'],
    refersTo: ['svc-physio'],
  },
  {
    roleKey: 'ed-rn',
    label: 'Registered Nurse',
    matrixRow: 'Emergency Department - RN',
    evidenceStatus: 'Workflow-derived; ED service specification/triage terminology',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'discharge.plan', 'discharge.complete', 'escalation.raise', 'alert.raise', 'communication.manage', 'monitoring.plan', 'monitoring.record', 'restriction.check', 'restriction.manage', 'diet.order', 'meal.record', 'equipment.use', 'equipment.manage', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'deterioration.record', 'incident.report', 'incident.review', 'deterioration.manage', 'usual.act', 'acuity.assess', 'assignment.propose', 'allocation.plan', 'allocation.confirm', 'report.review', 'instrument.use', 'function.assess', 'death.record', 'death.manage', 'problem.record', 'problem.manage', 'symptom.record', 'symptom.manage', 'intervention.record', 'intervention.plan', 'treatmentplan.record', 'treatmentplan.plan', 'pathway.record', 'pathway.manage', 'checklist.record', 'checklist.manage', 'recommendation.record', 'recommendation.make', 'recommendation.respond', 'requirement.record', 'requirement.manage', 'due.record', 'due.manage', 'recall.manage', 'followup.manage', 'surveillance.record', 'screening.record', 'infection.record', 'antimicrobial.record', 'sitecheck.record', 'readiness.record', 'variance.record', 'declined.record', 'priority.assign', 'identity.register', 'duplicate.flag', 'delegation.take', 'decision.respond', 'downtime.manage', 'record.reconcile', 'precaution.manage', 'allergy.record', 'consent.record', 'safeguarding.manage', 'complaint.manage', 'device.record', 'test.collect', 'result.receive', 'procedure.recover', 'decision.view', 'poison.record', 'trauma.record', 'major.manage', 'withdrawal.record', 'danger.record', 'observation.view', 'oxygen.record', 'medicine.give', 'cd.register'],
    keys: ['.triage', '.obs', '.bgl', '.pain', '.assess', '.procedure', '.change', '.family', '.progress', '.task'],
    views: ['overview', 'triage', 'assess', 'obs', 'bgl', 'pain', 'meds', 'procedures', 'results', 'tasks', 'notes', 'progress', 'handover', 'disposition', 'medical', 'allergies', 'changes', 'family', 'routes', 'transfers', 'discharge', 'escalations', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team', 'acuity', 'deterioration', 'incidents', 'death', 'problems', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'checklists', 'recommendations', 'requirements', 'caredue', 'recalls', 'followups', 'surveillance', 'screening', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'priorities', 'identity'],
    tabs: [
      { id: 'list', label: 'ED Board' },
      { id: 'triage', label: 'Triage' },
      { id: 'assess', label: 'Assessment' },
      { id: 'obs', label: 'Observations' },
      { id: 'meds', label: 'Medicines' },
      { id: 'procedures', label: 'Procedures' },
      { id: 'results', label: 'Results' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'notes', label: 'Notes' },
      { id: 'handover', label: 'Handover' },
      { id: 'disposition', label: 'Transfer/Disposition' },
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.transfers, CARD.discharges, CARD.escalations, CARD.alerts, CARD.communications, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.interpreters, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team, CARD.acuity, CARD.deterioration, CARD.incidents, CARD.allocation, CARD.deaths, CARD.problems, CARD.symptoms, CARD.interventions, CARD.treatmentplans, CARD.pathways, CARD.checklists, CARD.recommendations, CARD.requirements, CARD.caredue, CARD.recalls, CARD.followups, CARD.surveillance, CARD.screening, CARD.infections, CARD.antimicrobials, CARD.sitechecks, CARD.readiness, CARD.variances, CARD.declined, CARD.priorities, CARD.arrivals, CARD.delegation, CARD.downtime, CARD.cdbook],
    ownViews: ['overview', 'triage', 'assess', 'obs', 'bgl', 'pain', 'meds', 'procedures', 'results', 'tasks', 'notes', 'progress', 'handover', 'disposition', 'allergies', 'changes', 'family', 'escalations', 'alerts', 'deterioration', 'monitoring', 'incidents', 'declined', 'identity', 'infections', 'capacity', 'equipment'],
    homeFour: ['workstation', 'tasks', 'handover', 'transfers'],
    ownCards: ['workstation', 'tasks', 'search', 'handover', 'received', 'transfers', 'discharges', 'escalations', 'alerts', 'monitoring', 'deterioration', 'incidents', 'allocation', 'priorities', 'declined', 'arrivals', 'delegation', 'downtime', 'cdbook'],
    escalatesTo: ['ed-doctor'],
    board: true,
  },
  {
    roleKey: 'ed-doctor',
    label: 'Emergency Doctor',
    matrixRow: 'Emergency Department - doctor',
    evidenceStatus: 'Workflow-derived; specialist medical/ED specification',
    profession: 'Medical Practitioner',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'result.review', 'knowledge.use', 'transfer.request', 'discharge.plan', 'discharge.decide', 'escalation.raise', 'escalation.respond', 'consult.request', 'referral.request', 'referral.authorise', 'alert.raise', 'communication.manage', 'monitoring.plan', 'restriction.check', 'restriction.manage', 'diet.order', 'equipment.use', 'preference.record', 'capacity.concern', 'capacity.assess', 'whanau.manage', 'access.manage', 'external.manage', 'coding.answer', 'report.record', 'usual.record', 'deterioration.record', 'incident.report', 'incident.review', 'deterioration.manage', 'usual.act', 'acuity.assess', 'assignment.propose', 'assignment.confirm', 'report.review', 'instrument.use', 'function.assess', 'death.record', 'death.manage', 'problem.record', 'problem.manage', 'symptom.record', 'symptom.manage', 'intervention.record', 'intervention.plan', 'intervention.authorise', 'treatmentplan.record', 'treatmentplan.plan', 'treatmentplan.authorise', 'pathway.record', 'pathway.manage', 'checklist.record', 'checklist.manage', 'recommendation.record', 'recommendation.make', 'recommendation.respond', 'requirement.record', 'requirement.manage', 'due.record', 'due.manage', 'recall.manage', 'followup.manage', 'surveillance.record', 'surveillance.review', 'screening.record', 'screening.review', 'infection.record', 'infection.confirm', 'antimicrobial.record', 'antimicrobial.decide', 'sitecheck.record', 'sitecheck.resolve', 'readiness.record', 'readiness.assess', 'variance.record', 'variance.decide', 'declined.record', 'declined.respond', 'priority.assign', 'priority.downgrade', 'identity.register', 'identity.correct', 'duplicate.flag', 'duplicate.resolve', 'access.approve', 'delegation.give', 'decision.respond', 'record.reconcile', 'precaution.manage', 'allergy.record', 'consent.record', 'palliative.manage', 'safeguarding.manage', 'complaint.manage', 'device.record', 'test.order', 'test.collect', 'result.receive', 'procedure.manage', 'decision.manage', 'poison.manage', 'trauma.manage', 'coroner.decide', 'major.manage', 'withdrawal.manage', 'danger.record', 'observation.manage', 'oxygen.prescribe', 'medicine.prescribe'],
    keys: ['.medical', '.problem', '.procedure', '.review', '.progress', '.disposition', '.family', '.task'],
    views: ['overview', 'triage', 'medical', 'problems', 'results', 'meds', 'procedures', 'progress', 'notes', 'tasks', 'disposition', 'obs', 'allergies', 'history', 'handover', 'routes', 'family', 'review', 'transfers', 'discharge', 'escalations', 'consults', 'referrals', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'preferences', 'capacity', 'support', 'access', 'external', 'coding', 'reported', 'instruments', 'function', 'usual', 'team', 'acuity', 'deterioration', 'incidents', 'death', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'checklists', 'recommendations', 'requirements', 'caredue', 'recalls', 'followups', 'surveillance', 'screening', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'priorities', 'identity'],
    tabs: [
      { id: 'list', label: 'ED Board' },
      { id: 'medical', label: 'Medical Assessment' },
      { id: 'problems', label: 'Problems' },
      { id: 'results', label: 'Results' },
      { id: 'meds', label: 'Medicines' },
      { id: 'procedures', label: 'Procedures' },
      { id: 'progress', label: 'Notes' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'disposition', label: 'Disposition' },
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.knowledge, CARD.transfers, CARD.discharges, CARD.escalations, CARD.consults, CARD.referrals, CARD.alerts, CARD.communications, CARD.restrictions, CARD.meals, CARD.capacity, CARD.external, CARD.codingqueries, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team, CARD.acuity, CARD.deterioration, CARD.incidents, CARD.deaths, CARD.problems, CARD.symptoms, CARD.interventions, CARD.treatmentplans, CARD.pathways, CARD.checklists, CARD.recommendations, CARD.requirements, CARD.caredue, CARD.recalls, CARD.followups, CARD.surveillance, CARD.screening, CARD.infections, CARD.antimicrobials, CARD.sitechecks, CARD.readiness, CARD.variances, CARD.declined, CARD.priorities, CARD.arrivals, CARD.duplicates, CARD.breakglass, CARD.delegation, CARD.downtime],
    ownViews: ['overview', 'triage', 'medical', 'problems', 'results', 'meds', 'procedures', 'progress', 'notes', 'tasks', 'disposition', 'obs', 'allergies', 'history', 'handover', 'family', 'review', 'consults', 'referrals', 'transfers', 'escalations', 'alerts', 'deterioration', 'pathways', 'capacity', 'antimicrobials', 'death', 'declined', 'identity', 'incidents'],
    homeFour: ['workstation', 'tasks', 'consults', 'escalations'],
    ownCards: ['workstation', 'tasks', 'search', 'handover', 'received', 'knowledge', 'transfers', 'discharges', 'escalations', 'consults', 'referrals', 'alerts', 'codingqueries', 'deterioration', 'pathways', 'priorities', 'declined', 'arrivals', 'duplicates', 'breakglass', 'delegation'],
    consultsTo: ['genmed-physician'],
    refersTo: ['svc-genmed', 'svc-physio'],
    board: true,
  },
  {
    roleKey: 'physio',
    label: 'Physiotherapist',
    matrixRow: 'Physiotherapy',
    evidenceStatus: 'HISO allied-health model / profession-specific regulation; exact profession mapping varies',
    profession: 'Physiotherapist',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'escalation.raise', 'consult.respond', 'referral.triage', 'appointment.manage', 'alert.raise', 'communication.manage', 'restriction.check', 'restriction.manage', 'equipment.use', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'deterioration.record', 'incident.report', 'usual.act', 'assignment.propose', 'report.review', 'instrument.use', 'function.assess', 'death.record', 'problem.record', 'problem.manage', 'symptom.record', 'symptom.manage', 'intervention.record', 'intervention.plan', 'treatmentplan.record', 'treatmentplan.plan', 'treatmentplan.authorise', 'pathway.record', 'pathway.manage', 'checklist.record', 'checklist.manage', 'recommendation.record', 'recommendation.make', 'recommendation.respond', 'requirement.record', 'requirement.manage', 'due.record', 'due.manage', 'recall.manage', 'followup.manage', 'surveillance.record', 'surveillance.review', 'screening.record', 'screening.review', 'infection.record', 'antimicrobial.record', 'sitecheck.record', 'readiness.record', 'readiness.assess', 'variance.record', 'variance.decide', 'declined.record', 'declined.respond', 'priority.assign', 'priority.downgrade', 'allergy.report', 'safeguarding.raise', 'complaint.record', 'device.report', 'conference.manage', 'rehab.manage', 'equipment.lend'],
    keys: ['.assess', '.mobility', '.goals', '.treatment', '.outcome', '.progress', '.family', '.task'],
    views: ['overview', 'assess', 'mobility', 'goals', 'treatment', 'outcomes', 'progress', 'notes', 'tasks', 'obs', 'problems', 'allergies', 'routes', 'family', 'escalations', 'consults', 'referrals', 'appointments', 'alerts', 'communications', 'restrictions', 'equipment', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team', 'acuity', 'deterioration', 'incidents', 'death', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'checklists', 'recommendations', 'requirements', 'caredue', 'recalls', 'followups', 'surveillance', 'screening', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'priorities'],
    tabs: [
      { id: 'list', label: 'Caseload' },
      { id: 'assess', label: 'Assessment' },
      { id: 'mobility', label: 'Function/Mobility' },
      { id: 'goals', label: 'Goals' },
      { id: 'treatment', label: 'Treatment' },
      { id: 'outcomes', label: 'Outcome Measures' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'notes', label: 'Notes' },
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.received, CARD.escalations, CARD.consults, CARD.referrals, CARD.appointments, CARD.alerts, CARD.communications, CARD.restrictions, CARD.equipment, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team, CARD.problems, CARD.symptoms, CARD.interventions, CARD.treatmentplans, CARD.pathways, CARD.checklists, CARD.recommendations, CARD.requirements, CARD.caredue, CARD.recalls, CARD.followups, CARD.surveillance, CARD.screening, CARD.infections, CARD.antimicrobials, CARD.sitechecks, CARD.readiness, CARD.variances, CARD.declined, CARD.priorities, CARD.downtime],
    ownViews: ['overview', 'assess', 'mobility', 'goals', 'treatment', 'outcomes', 'progress', 'notes', 'tasks', 'obs', 'problems', 'allergies', 'family', 'referrals', 'appointments', 'consults', 'equipment', 'function', 'instruments', 'escalations', 'alerts', 'recommendations', 'declined', 'incidents'],
    homeFour: ['workstation', 'tasks', 'referrals', 'appointments'],
    ownCards: ['workstation', 'tasks', 'search', 'received', 'escalations', 'consults', 'referrals', 'appointments', 'alerts', 'equipment', 'function', 'instruments', 'recommendations', 'priorities', 'declined'],
    escalatesTo: ['genmed-physician', 'genmed-rn'],
  },
  {
    roleKey: 'flow-coordinator',
    label: 'Patient Flow',
    matrixRow: 'Patient flow / bed management',
    evidenceStatus: 'Workflow-derived; operational mapping required',
    profession: null,
    capabilities: ['bed.manage'],
    keys: [],
    views: [],
    tabs: [],
    homeCards: [CARD.flow, CARD.transfers, CARD.discharges, CARD.moves],
  },
  {
    roleKey: 'clinical-coder',
    label: 'Clinical Coding',
    matrixRow: 'Clinical coding / classification',
    evidenceStatus: 'Workflow-derived; classification and reporting requirements to be researched (RR-CODE-001)',
    profession: null,
    capabilities: ['coding.assign'],
    keys: [],
    views: [],
    tabs: [],
    homeCards: [CARD.coding],
  },
  {
    roleKey: 'privacy-officer',
    label: 'Privacy Officer',
    matrixRow: 'Privacy / health information',
    evidenceStatus: 'Workflow-derived; time limits, grounds and what may be withheld to be researched (RR-PRIVACY-001)',
    profession: null,
    capabilities: ['privacy.manage'],
    keys: [],
    views: [],
    tabs: [],
    homeCards: [CARD.privacy],
  },
  {
    roleKey: 'rules-officer',
    label: 'Rules and Standards Officer',
    matrixRow: 'Governance / rules and standards',
    evidenceStatus: 'Workflow-derived; who holds this role is the organisation\'s own choice (SHIFT-DESIGN-RULESET-001)',
    profession: null,
    capabilities: ['rules.manage', 'rules.approve'],
    keys: [],
    views: [],
    tabs: [],
    homeCards: [CARD.rules],
  },
  {
    roleKey: 'arc-rostering',
    label: 'Rostering',
    matrixRow: 'Rostering / staffing',
    evidenceStatus: 'Workflow-derived; legal/organisational verification varies',
    profession: null,
    capabilities: ['roster.decide', 'staffing.report'],
    keys: [],
    views: [],
    tabs: [],
    homeCards: [CARD.vacancies, CARD.swaps, CARD.leave],
  },
];

// Palliative care / hospice (matrix, "Older people, palliative & disability support"). The matrix names the
// service and its tabs but not its positions, so a nurse and a doctor are set up from the shared roles and
// the position names are provisional. Each sees the matrix tabs that SHIFT already has; Bereavement sits inside End of life.
const roleOf = (key: string) => ROLES.find((r) => r.roleKey === key)!;
const withViews = (r: RoleConfig, extra: string[]) => [...new Set([...r.views, ...extra])];
const withCards = (r: RoleConfig, extra: HomeCard[]) => [...r.homeCards, ...extra.filter((c) => !r.homeCards.some((x) => x.id === c.id))];
const HOSPICE_EVIDENCE = 'Matrix names the service, not its positions, so this position is provisional';
ROLES.push(
  {
    ...roleOf('arc-rn'),
    roleKey: 'hospice-rn',
    label: 'Registered Nurse',
    matrixRow: 'Palliative care / hospice',
    evidenceStatus: HOSPICE_EVIDENCE,
    keys: [...new Set([...roleOf('arc-rn').keys, '.goals', '.symptom'])],
    views: withViews(roleOf('arc-rn'), ['symptoms', 'goals', 'death', 'support', 'equipment', 'visits', 'afterhours']),
    ownViews: [...new Set([...(roleOf('arc-rn').ownViews ?? []), 'symptoms', 'goals', 'death', 'support', 'equipment', 'visits', 'afterhours'])],
    tabs: [
      { id: 'list', label: 'Caseload' }, { id: 'assess', label: 'Assessment' }, { id: 'symptoms', label: 'Symptoms' }, { id: 'meds', label: 'Medicines' },
      { id: 'careplan', label: 'Care Plan' }, { id: 'visits', label: 'Visits' }, { id: 'afterhours', label: 'After-hours' }, { id: 'goals', label: 'ACP/Goals' }, { id: 'equipment', label: 'Equipment' }, { id: 'support', label: 'Whānau' },
      { id: 'death', label: 'End-of-life' },
    ],
    capabilities: [...roleOf('arc-rn').capabilities, 'visit.plan', 'visit.record', 'afterhours.record'],
    homeCards: withCards(roleOf('arc-rn'), [CARD.symptoms, CARD.deaths, CARD.visits, CARD.afterhours]),
    homeFour: ['workstation', 'tasks', 'symptoms', 'handover'],
    ownCards: [...new Set([...(roleOf('arc-rn').ownCards ?? []), 'symptoms', 'deaths', 'visits', 'afterhours'])],
    escalatesTo: ['hospice-physician'],
  },
  {
    ...roleOf('genmed-physician'),
    roleKey: 'hospice-physician',
    label: 'Physician',
    matrixRow: 'Palliative care / hospice',
    evidenceStatus: HOSPICE_EVIDENCE,
    keys: [...new Set([...roleOf('genmed-physician').keys, '.goals', '.symptom'])],
    views: withViews(roleOf('genmed-physician'), ['symptoms', 'goals', 'death', 'support', 'equipment', 'afterhours']),
    ownViews: [...new Set([...(roleOf('genmed-physician').ownViews ?? []), 'symptoms', 'goals', 'death', 'support', 'afterhours'])],
    capabilities: [...roleOf('genmed-physician').capabilities, 'afterhours.record'],
    tabs: [
      { id: 'list', label: 'Caseload' }, { id: 'assess', label: 'Assessment' }, { id: 'symptoms', label: 'Symptoms' }, { id: 'meds', label: 'Medicines' },
      { id: 'careplan', label: 'Care Plan' }, { id: 'afterhours', label: 'After-hours' }, { id: 'goals', label: 'ACP/Goals' }, { id: 'support', label: 'Whānau' }, { id: 'death', label: 'End-of-life' },
    ],
    homeCards: withCards(roleOf('genmed-physician'), [CARD.symptoms, CARD.deaths, CARD.afterhours]),
    homeFour: ['workstation', 'tasks', 'symptoms', 'deaths'],
    ownCards: [...new Set([...(roleOf('genmed-physician').ownCards ?? []), 'symptoms', 'deaths', 'afterhours'])],
    consultsTo: undefined,
    refersTo: undefined,
  },
);

// District / community nursing (matrix: Caseload | Referral | Eligibility | Assessment | Care Plan | Visits |
// Medicines | Clinical Care | Equipment/Supplies | Monitoring | Whanau/Providers | Tasks | Review | Discharge).
// Set up from the general medicine nurse. Referral, Eligibility, Clinical Care and Providers have no screen yet.
ROLES.push({
  ...roleOf('genmed-rn'),
  roleKey: 'community-rn',
  label: 'Registered Nurse',
  matrixRow: 'District / community nursing',
  evidenceStatus: 'Matrix names the service, not its positions, so this position is provisional; Referral, Eligibility, Clinical Care and Providers tabs are not built yet',
  capabilities: [...roleOf('genmed-rn').capabilities.filter((c) => c !== 'cd.register'), 'visit.plan', 'visit.record'],
  views: withViews(roleOf('genmed-rn'), ['visits', 'assess', 'careplan', 'monitoring', 'support', 'equipment', 'review', 'discharge']),
  ownViews: [...new Set([...(roleOf('genmed-rn').ownViews ?? []), 'visits', 'assess', 'careplan', 'monitoring', 'support', 'equipment', 'review', 'discharge'])],
  tabs: [
    { id: 'list', label: 'Caseload' }, { id: 'assess', label: 'Assessment' }, { id: 'careplan', label: 'Care Plan' }, { id: 'visits', label: 'Visits' },
    { id: 'meds', label: 'Medicines' }, { id: 'equipment', label: 'Equipment/Supplies' }, { id: 'monitoring', label: 'Monitoring' }, { id: 'support', label: 'Whānau' },
    { id: 'tasks', label: 'Tasks' }, { id: 'review', label: 'Review' }, { id: 'discharge', label: 'Discharge' },
  ],
  homeCards: withCards({ ...roleOf('genmed-rn'), homeCards: roleOf('genmed-rn').homeCards.filter((c) => c.id !== 'cdbook') }, [CARD.visits]),
  homeFour: ['workstation', 'tasks', 'visits', 'handover'],
  ownCards: [...new Set([...(roleOf('genmed-rn').ownCards ?? []).filter((c) => c !== 'cdbook'), 'visits'])],
  escalatesTo: undefined,
});

// General practice (matrix, "Primary & community care"): the GP and the practice nurse, set up from the general
// medicine physician and nurse. Orders, Immunisation, Chronic Care and Education have no screen yet, and Schedule
// is the appointments screen.
const GP_EVIDENCE = 'Matrix names the service, not its positions, so this position is provisional; Orders, Immunisation and Chronic Care tabs are not built yet';
const GP_VIEWS = ['overview', 'history', 'problems', 'assess', 'meds', 'obs', 'results', 'screening', 'referrals', 'communications', 'notes', 'tasks', 'followups', 'recalls', 'appointments', 'education'];
const NURSE_VIEWS = ['recalls', 'assess', 'obs', 'meds', 'screening', 'wounds', 'tasks', 'notes', 'appointments', 'followups', 'education'];
ROLES.push(
  {
    ...roleOf('genmed-physician'),
    roleKey: 'gp',
    label: 'General Practitioner',
    matrixRow: 'General practice / GP',
    evidenceStatus: GP_EVIDENCE,
    keys: [...new Set([...roleOf('genmed-physician').keys, '.progress'])],
    views: withViews(roleOf('genmed-physician'), GP_VIEWS),
    ownViews: [...new Set([...(roleOf('genmed-physician').ownViews ?? []), ...GP_VIEWS])],
    tabs: [
      { id: 'appointments', label: 'Schedule' }, { id: 'list', label: 'Patients' }, { id: 'overview', label: 'Patient Overview' }, { id: 'history', label: 'History' },
      { id: 'problems', label: 'Problems' }, { id: 'assess', label: 'Assessment' }, { id: 'meds', label: 'Medicines' }, { id: 'obs', label: 'Observations' },
      { id: 'results', label: 'Results' }, { id: 'screening', label: 'Preventive Care' }, { id: 'referrals', label: 'Referrals' },
      { id: 'communications', label: 'Correspondence' }, { id: 'notes', label: 'Notes' }, { id: 'tasks', label: 'Inbox/Tasks' }, { id: 'followups', label: 'Follow-up' }, { id: 'education', label: 'Education' },
    ],
    capabilities: [...roleOf('genmed-physician').capabilities, 'education.record'],
    homeCards: withCards(roleOf('genmed-physician'), [CARD.education]),
    homeFour: ['workstation', 'tasks', 'appointments', 'followups'],
    ownCards: [...new Set([...(roleOf('genmed-physician').ownCards ?? []), 'education'])],
    consultsTo: undefined,
    refersTo: undefined,
  },
  {
    ...roleOf('genmed-rn'),
    roleKey: 'practice-nurse',
    label: 'Practice Nurse',
    matrixRow: 'Practice nursing',
    evidenceStatus: GP_EVIDENCE,
    capabilities: [...roleOf('genmed-rn').capabilities.filter((c) => c !== 'cd.register'), 'appointment.manage', 'education.record'],
    views: withViews(roleOf('genmed-rn'), NURSE_VIEWS),
    ownViews: [...new Set([...(roleOf('genmed-rn').ownViews ?? []), ...NURSE_VIEWS])],
    tabs: [
      { id: 'appointments', label: 'Schedule' }, { id: 'list', label: 'Patients' }, { id: 'recalls', label: 'Recalls' }, { id: 'assess', label: 'Assessment' },
      { id: 'obs', label: 'Observations' }, { id: 'meds', label: 'Medicines' }, { id: 'screening', label: 'Screening' }, { id: 'wounds', label: 'Wounds' },
      { id: 'tasks', label: 'Tasks' }, { id: 'notes', label: 'Notes' }, { id: 'education', label: 'Education' },
    ],
    homeCards: withCards({ ...roleOf('genmed-rn'), homeCards: roleOf('genmed-rn').homeCards.filter((c) => c.id !== 'cdbook') }, [CARD.appointments, CARD.recalls, CARD.followups, CARD.education]),
    homeFour: ['workstation', 'tasks', 'recalls', 'appointments'],
    ownCards: [...new Set([...(roleOf('genmed-rn').ownCards ?? []).filter((c) => c !== 'cdbook'), 'appointments', 'recalls', 'followups', 'education'])],
    escalatesTo: ['gp'],
  },
);

// Maternity (matrix, "Maternity, neonatal & child"): the midwife and the obstetric doctor, set up from the general
// medicine nurse and physician. Labour and Birth sit inside the Pregnancy screen. Fetal Monitoring, Feeding, the
// baby's own record, Investigations, Imaging, Orders and Operative Care have no screen yet.
const MATERNITY_EVIDENCE = 'Matrix names the service, not its positions, so this position is provisional; Fetal Monitoring, Feeding, Baby, Investigations, Orders and Operative Care are not built yet';
const MID_VIEWS = ['pregnancy', 'assess', 'meds', 'careplan', 'referrals', 'discharge', 'support', 'obs'];
const OBS_VIEWS = ['pregnancy', 'problems', 'results', 'meds', 'consults', 'progress', 'discharge'];
ROLES.push(
  {
    ...roleOf('genmed-rn'),
    roleKey: 'midwife',
    label: 'Midwife',
    matrixRow: 'Maternity - midwife',
    evidenceStatus: MATERNITY_EVIDENCE,
    profession: 'Midwife',
    capabilities: [...roleOf('genmed-rn').capabilities.filter((c) => c !== 'cd.register'), 'pregnancy.record'],
    views: withViews(roleOf('genmed-rn'), MID_VIEWS),
    ownViews: [...new Set([...(roleOf('genmed-rn').ownViews ?? []), ...MID_VIEWS])],
    tabs: [
      { id: 'list', label: 'Caseload' }, { id: 'pregnancy', label: 'Pregnancy' }, { id: 'assess', label: 'Assessment' }, { id: 'meds', label: 'Medicines' },
      { id: 'careplan', label: 'Care Plan' }, { id: 'referrals', label: 'Referrals/Consults' }, { id: 'discharge', label: 'Transfer/Discharge' },
    ],
    homeCards: withCards({ ...roleOf('genmed-rn'), homeCards: roleOf('genmed-rn').homeCards.filter((c) => c.id !== 'cdbook') }, []),
    homeFour: ['workstation', 'tasks', 'handover', 'escalations'],
    ownCards: (roleOf('genmed-rn').ownCards ?? []).filter((c) => c !== 'cdbook'),
    escalatesTo: ['obstetrician'],
  },
  {
    ...roleOf('genmed-physician'),
    roleKey: 'obstetrician',
    label: 'Obstetrician',
    matrixRow: 'Maternity - obstetric medical',
    evidenceStatus: MATERNITY_EVIDENCE,
    capabilities: [...roleOf('genmed-physician').capabilities, 'pregnancy.record'],
    views: withViews(roleOf('genmed-physician'), OBS_VIEWS),
    ownViews: [...new Set([...(roleOf('genmed-physician').ownViews ?? []), ...OBS_VIEWS])],
    tabs: [
      { id: 'list', label: 'Patient List' }, { id: 'pregnancy', label: 'Pregnancy Overview' }, { id: 'problems', label: 'Problems' }, { id: 'results', label: 'Investigations' },
      { id: 'meds', label: 'Medicines' }, { id: 'consults', label: 'Consults' }, { id: 'progress', label: 'Progress' }, { id: 'discharge', label: 'Discharge' },
    ],
    consultsTo: undefined,
    refersTo: undefined,
  },
);

export const ROLE_BY_KEY = new Map(ROLES.map((r) => [r.roleKey, r]));
