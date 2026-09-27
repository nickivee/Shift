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
  | 'assignment.confirm';

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
  vacancies: { id: 'vacancies', label: 'Vacancies', required: true },
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
  codingqueries: { id: 'codingqueries', label: 'Coding questions', required: true },
  reports: { id: 'reports', label: 'In their own words', required: true },
  instruments: { id: 'instruments', label: 'Questionnaires', required: true },
  function: { id: 'function', label: 'Function', required: true },
  usual: { id: 'usual', label: 'Different from usual', required: true },
  team: { id: 'team', label: 'Care team', required: true },
} satisfies Record<string, HomeCard>;

export const ROLES: RoleConfig[] = [
  {
    roleKey: 'arc-rn',
    label: 'Registered Nurse',
    matrixRow: 'Aged residential care - RN',
    evidenceStatus: 'Ngā Paerewa/community specifications; disability funding boundaries may sit outside health',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'escalation.raise', 'escalation.respond', 'wound.identify', 'wound.manage', 'careplan.manage', 'alert.raise', 'communication.manage', 'monitoring.plan', 'monitoring.record', 'restriction.check', 'restriction.manage', 'diet.order', 'meal.record', 'equipment.use', 'equipment.manage', 'leave.manage', 'leave.approve', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'usual.act', 'assignment.propose', 'assignment.confirm', 'report.review', 'instrument.use', 'function.assess'],
    keys: ['.obs', '.bgl', '.weight', '.pain', '.wound', '.skin', '.fall', '.intake', '.cares', '.behaviour', '.change', '.family', '.assess', '.review', '.progress', '.task'],
    views: ['overview', 'history', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'nutrition', 'cares', 'behaviour', 'changes', 'family', 'assess', 'review', 'progress', 'notes', 'meds', 'results', 'allergies', 'careplan', 'tasks', 'handover', 'routes', 'escalations', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'absence', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.escalations, CARD.wounds, CARD.careplans, CARD.alerts, CARD.communications, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.absences, CARD.preferences, CARD.whanau, CARD.interpreters, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team],
  },
  {
    roleKey: 'arc-caregiver',
    label: 'Caregiver / Kaiāwhina',
    matrixRow: 'Aged residential care - caregiver/kaiāwhina',
    evidenceStatus: 'Ngā Paerewa/community specifications; disability funding boundaries may sit outside health',
    profession: null,
    capabilities: ['record.view', 'event.create', 'route.send', 'task.manage', 'handover.use', 'escalation.raise', 'wound.identify', 'alert.raise', 'monitoring.record', 'restriction.check', 'meal.record', 'equipment.use', 'preference.record', 'report.record', 'usual.record'],
    keys: ['.obs', '.weight', '.cares', '.intake', '.skin', '.behaviour', '.change', '.pain', '.fall', '.progress'],
    views: ['overview', 'careplan', 'cares', 'nutrition', 'intake', 'skin', 'behaviour', 'tasks', 'changes', 'notes', 'obs', 'allergies', 'handover', 'escalations', 'wounds', 'alerts', 'monitoring', 'restrictions', 'diet', 'equipment', 'absence', 'preferences', 'support', 'access', 'reported', 'function', 'usual', 'team'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.escalations, CARD.alerts, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.preferences],
    escalatesTo: ['arc-rn'],
  },
  {
    roleKey: 'genmed-rn',
    label: 'Registered Nurse',
    matrixRow: 'General Medicine - RN',
    evidenceStatus: 'Workflow-derived; specialty verification required',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'transfer.arrive', 'bed.manage', 'discharge.plan', 'discharge.complete', 'escalation.raise', 'wound.identify', 'wound.manage', 'careplan.manage', 'referral.request', 'alert.raise', 'communication.manage', 'monitoring.plan', 'monitoring.record', 'restriction.check', 'restriction.manage', 'diet.order', 'meal.record', 'equipment.use', 'equipment.manage', 'bed.request', 'leave.manage', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'usual.act', 'assignment.propose', 'report.review', 'instrument.use', 'function.assess'],
    keys: ['.obs', '.bgl', '.weight', '.pain', '.wound', '.skin', '.fall', '.intake', '.assess', '.change', '.family', '.progress', '.task'],
    views: ['overview', 'history', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'assess', 'changes', 'family', 'progress', 'notes', 'meds', 'results', 'allergies', 'careplan', 'tasks', 'handover', 'routes', 'transfers', 'discharge', 'escalations', 'referrals', 'appointments', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'location', 'absence', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.transfers, CARD.discharges, CARD.escalations, CARD.wounds, CARD.careplans, CARD.referrals, CARD.alerts, CARD.communications, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.moves, CARD.absences, CARD.preferences, CARD.whanau, CARD.interpreters, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team],
    escalatesTo: ['genmed-physician'],
    refersTo: ['svc-physio'],
  },
  {
    roleKey: 'genmed-physician',
    label: 'Physician',
    matrixRow: 'General Medicine - physician',
    evidenceStatus: 'Workflow-derived; specialty verification required',
    profession: 'Medical Practitioner',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'result.review', 'knowledge.use', 'transfer.request', 'transfer.accept', 'discharge.plan', 'discharge.decide', 'escalation.raise', 'escalation.respond', 'consult.request', 'consult.respond', 'referral.request', 'referral.authorise', 'referral.triage', 'appointment.manage', 'alert.raise', 'communication.manage', 'monitoring.plan', 'restriction.check', 'restriction.manage', 'diet.order', 'equipment.use', 'bed.request', 'leave.manage', 'leave.approve', 'preference.record', 'capacity.concern', 'capacity.assess', 'whanau.manage', 'access.manage', 'external.manage', 'coding.answer', 'report.record', 'usual.record', 'usual.act', 'assignment.propose', 'assignment.confirm', 'report.review', 'instrument.use', 'function.assess'],
    keys: ['.review', '.problem', '.assess', '.progress', '.family', '.task'],
    views: ['overview', 'history', 'problems', 'assess', 'review', 'meds', 'results', 'obs', 'progress', 'allergies', 'careplan', 'tasks', 'handover', 'routes', 'family', 'transfers', 'discharge', 'escalations', 'consults', 'wounds', 'referrals', 'appointments', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'location', 'absence', 'preferences', 'capacity', 'support', 'access', 'external', 'coding', 'reported', 'instruments', 'function', 'usual', 'team'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.knowledge, CARD.transfers, CARD.discharges, CARD.escalations, CARD.consults, CARD.referrals, CARD.appointments, CARD.alerts, CARD.communications, CARD.restrictions, CARD.meals, CARD.absences, CARD.capacity, CARD.external, CARD.codingqueries, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team],
    consultsTo: ['physio'],
    refersTo: ['svc-physio'],
  },
  {
    roleKey: 'ed-rn',
    label: 'Registered Nurse',
    matrixRow: 'Emergency Department - RN',
    evidenceStatus: 'Workflow-derived; ED service specification/triage terminology',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'discharge.plan', 'discharge.complete', 'escalation.raise', 'alert.raise', 'communication.manage', 'monitoring.plan', 'monitoring.record', 'restriction.check', 'restriction.manage', 'diet.order', 'meal.record', 'equipment.use', 'equipment.manage', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'usual.act', 'assignment.propose', 'report.review', 'instrument.use', 'function.assess'],
    keys: ['.triage', '.obs', '.bgl', '.pain', '.assess', '.procedure', '.change', '.family', '.progress', '.task'],
    views: ['overview', 'triage', 'assess', 'obs', 'bgl', 'pain', 'meds', 'procedures', 'results', 'tasks', 'notes', 'progress', 'handover', 'disposition', 'medical', 'allergies', 'changes', 'family', 'routes', 'transfers', 'discharge', 'escalations', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.transfers, CARD.discharges, CARD.escalations, CARD.alerts, CARD.communications, CARD.monitoring, CARD.restrictions, CARD.meals, CARD.equipment, CARD.interpreters, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team],
    escalatesTo: ['ed-doctor'],
    board: true,
  },
  {
    roleKey: 'ed-doctor',
    label: 'Emergency Doctor',
    matrixRow: 'Emergency Department - doctor',
    evidenceStatus: 'Workflow-derived; specialist medical/ED specification',
    profession: 'Medical Practitioner',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'result.review', 'knowledge.use', 'transfer.request', 'discharge.plan', 'discharge.decide', 'escalation.raise', 'escalation.respond', 'consult.request', 'referral.request', 'referral.authorise', 'alert.raise', 'communication.manage', 'monitoring.plan', 'restriction.check', 'restriction.manage', 'diet.order', 'equipment.use', 'preference.record', 'capacity.concern', 'capacity.assess', 'whanau.manage', 'access.manage', 'external.manage', 'coding.answer', 'report.record', 'usual.record', 'usual.act', 'assignment.propose', 'assignment.confirm', 'report.review', 'instrument.use', 'function.assess'],
    keys: ['.medical', '.problem', '.procedure', '.review', '.progress', '.disposition', '.family', '.task'],
    views: ['overview', 'triage', 'medical', 'problems', 'results', 'meds', 'procedures', 'progress', 'notes', 'tasks', 'disposition', 'obs', 'allergies', 'history', 'handover', 'routes', 'family', 'review', 'transfers', 'discharge', 'escalations', 'consults', 'referrals', 'alerts', 'communications', 'monitoring', 'restrictions', 'diet', 'equipment', 'preferences', 'capacity', 'support', 'access', 'external', 'coding', 'reported', 'instruments', 'function', 'usual', 'team'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.knowledge, CARD.transfers, CARD.discharges, CARD.escalations, CARD.consults, CARD.referrals, CARD.alerts, CARD.communications, CARD.restrictions, CARD.meals, CARD.capacity, CARD.external, CARD.codingqueries, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team],
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
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'escalation.raise', 'consult.respond', 'referral.triage', 'appointment.manage', 'alert.raise', 'communication.manage', 'restriction.check', 'restriction.manage', 'equipment.use', 'preference.record', 'capacity.concern', 'whanau.manage', 'access.manage', 'external.manage', 'report.record', 'usual.record', 'usual.act', 'assignment.propose', 'report.review', 'instrument.use', 'function.assess'],
    keys: ['.assess', '.mobility', '.goals', '.treatment', '.outcome', '.progress', '.family', '.task'],
    views: ['overview', 'assess', 'mobility', 'goals', 'treatment', 'outcomes', 'progress', 'notes', 'tasks', 'obs', 'problems', 'allergies', 'routes', 'family', 'escalations', 'consults', 'referrals', 'appointments', 'alerts', 'communications', 'restrictions', 'equipment', 'preferences', 'capacity', 'support', 'access', 'external', 'reported', 'instruments', 'function', 'usual', 'team'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.received, CARD.escalations, CARD.consults, CARD.referrals, CARD.appointments, CARD.alerts, CARD.communications, CARD.restrictions, CARD.equipment, CARD.external, CARD.reports, CARD.instruments, CARD.function, CARD.usual, CARD.team],
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
    roleKey: 'arc-rostering',
    label: 'Rostering',
    matrixRow: 'Rostering / staffing',
    evidenceStatus: 'Workflow-derived; legal/organisational verification varies',
    profession: null,
    capabilities: ['roster.decide'],
    keys: [],
    views: [],
    tabs: [],
    homeCards: [CARD.vacancies, CARD.swaps, CARD.leave],
  },
];

export const ROLE_BY_KEY = new Map(ROLES.map((r) => [r.roleKey, r]));
