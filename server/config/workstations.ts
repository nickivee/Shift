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
  | 'knowledge.use';

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
}

const CARD = {
  workstation: { id: 'workstation', label: 'Workstation', required: true },
  tasks: { id: 'tasks', label: 'Tasks', required: true },
  search: { id: 'search', label: 'Search', required: false },
  handover: { id: 'handover', label: 'Handover', required: true },
  received: { id: 'received', label: 'Received', required: true },
  knowledge: { id: 'knowledge', label: 'Shared knowledge', required: false },
} satisfies Record<string, HomeCard>;

export const ROLES: RoleConfig[] = [
  {
    roleKey: 'arc-rn',
    label: 'Registered Nurse',
    matrixRow: 'Aged residential care - RN',
    evidenceStatus: 'Ngā Paerewa/community specifications; disability funding boundaries may sit outside health',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use'],
    keys: ['.obs', '.bgl', '.weight', '.pain', '.wound', '.skin', '.fall', '.intake', '.cares', '.behaviour', '.change', '.family', '.assess', '.review', '.progress', '.task'],
    views: ['overview', 'history', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'nutrition', 'cares', 'behaviour', 'changes', 'family', 'assess', 'review', 'progress', 'notes', 'meds', 'results', 'allergies', 'careplan', 'tasks', 'handover', 'routes'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received],
  },
  {
    roleKey: 'arc-caregiver',
    label: 'Caregiver / Kaiāwhina',
    matrixRow: 'Aged residential care - caregiver/kaiāwhina',
    evidenceStatus: 'Ngā Paerewa/community specifications; disability funding boundaries may sit outside health',
    profession: null,
    capabilities: ['record.view', 'event.create', 'route.send', 'task.manage', 'handover.use'],
    keys: ['.obs', '.weight', '.cares', '.intake', '.skin', '.behaviour', '.change', '.pain', '.fall', '.progress'],
    views: ['overview', 'careplan', 'cares', 'nutrition', 'intake', 'skin', 'behaviour', 'tasks', 'changes', 'notes', 'obs', 'allergies', 'handover'],
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
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover],
  },
  {
    roleKey: 'genmed-rn',
    label: 'Registered Nurse',
    matrixRow: 'General Medicine - RN',
    evidenceStatus: 'Workflow-derived; specialty verification required',
    profession: 'Registered Nurse',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use'],
    keys: ['.obs', '.bgl', '.weight', '.pain', '.wound', '.skin', '.fall', '.intake', '.assess', '.change', '.family', '.progress', '.task'],
    views: ['overview', 'history', 'obs', 'bgl', 'weight', 'pain', 'wounds', 'skin', 'falls', 'intake', 'assess', 'changes', 'family', 'progress', 'notes', 'meds', 'results', 'allergies', 'careplan', 'tasks', 'handover', 'routes'],
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
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received],
  },
  {
    roleKey: 'genmed-physician',
    label: 'Physician',
    matrixRow: 'General Medicine - physician',
    evidenceStatus: 'Workflow-derived; specialty verification required',
    profession: 'Medical Practitioner',
    capabilities: ['record.view', 'event.create', 'event.amend', 'route.send', 'route.receive', 'task.manage', 'handover.use', 'result.review', 'knowledge.use'],
    keys: ['.review', '.problem', '.assess', '.progress', '.family', '.task'],
    views: ['overview', 'history', 'problems', 'assess', 'review', 'meds', 'results', 'obs', 'progress', 'allergies', 'careplan', 'tasks', 'handover', 'routes', 'family'],
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
    ],
    homeCards: [CARD.workstation, CARD.tasks, CARD.search, CARD.handover, CARD.received, CARD.knowledge],
  },
];

export const ROLE_BY_KEY = new Map(ROLES.map((r) => [r.roleKey, r]));
