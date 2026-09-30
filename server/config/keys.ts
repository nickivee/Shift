// .key templates: concise sentence-form entry. Only fields the worker fills in are
// recorded; blanks stay blank and are left out of the record. Nothing is prefilled.
// Bounds here are input validation (impossible values), not clinical thresholds.

export type FieldType = 'number' | 'text' | 'longtext' | 'choice' | 'bp';

export interface KeyField {
  id: string;
  label: string;
  type: FieldType;
  unit?: string;
  options?: string[];
  min?: number;
  max?: number;
}

export interface KeyTemplate {
  code: string;
  version: number;
  label: string;
  category: string;
  fields: KeyField[];
  engines: number[];          // engines engaged when this key commits (registry ids)
  createsTask?: boolean;       // .task creates a coordination object instead of a clinical event
}

const CORE = [2, 4, 5, 6, 210, 231, 272];

export const KEYS: KeyTemplate[] = [
  {
    code: '.obs', version: 1, label: 'Observations', category: 'OBS',
    fields: [
      { id: 'bp', label: 'BP', type: 'bp', unit: 'mmHg' },
      { id: 'hr', label: 'HR', type: 'number', unit: 'bpm', min: 1, max: 350 },
      { id: 'spo2', label: 'SpO2', type: 'number', unit: '%', min: 1, max: 100 },
      { id: 'rr', label: 'RR', type: 'number', unit: '/min', min: 1, max: 120 },
      { id: 't', label: 'T', type: 'number', unit: '°C', min: 20, max: 45 },
      { id: 'o2', label: 'O2', type: 'text' },
      { id: 'loc', label: 'Consciousness', type: 'choice', options: ['Alert', 'New confusion', 'Voice', 'Pain', 'Unresponsive'] },
    ],
    engines: [...CORE, 17, 226],
  },
  {
    code: '.bgl', version: 1, label: 'Blood glucose', category: 'BGL',
    fields: [
      { id: 'bgl', label: 'BGL', type: 'number', unit: 'mmol/L', min: 0.1, max: 100 },
      { id: 'timing', label: 'Timing', type: 'choice', options: ['Fasting', 'Pre-meal', 'Post-meal', 'Bedtime', 'Random'] },
      { id: 'comment', label: 'Comment', type: 'text' },
    ],
    engines: [...CORE, 17, 47, 226],
  },
  {
    code: '.weight', version: 1, label: 'Weight', category: 'WEIGHT',
    fields: [
      { id: 'weight', label: 'Weight', type: 'number', unit: 'kg', min: 0.3, max: 400 },
      { id: 'height', label: 'Height', type: 'number', unit: 'cm', min: 20, max: 250 },
      { id: 'method', label: 'Method', type: 'choice', options: ['Standing', 'Chair', 'Hoist', 'Bed', 'Reported'] },
    ],
    engines: [...CORE, 260, 226],
  },
  {
    code: '.pain', version: 1, label: 'Pain', category: 'PAIN',
    fields: [
      { id: 'site', label: 'Site', type: 'text' },
      { id: 'score', label: 'Score', type: 'number', unit: '/10', min: 0, max: 10 },
      { id: 'character', label: 'Character', type: 'text' },
      { id: 'action', label: 'Action', type: 'text' },
    ],
    engines: [...CORE, 54, 274],
  },
  {
    code: '.wound', version: 1, label: 'Wound', category: 'WOUND',
    fields: [
      { id: 'site', label: 'Site', type: 'text' },
      { id: 'type', label: 'Type', type: 'choice', options: ['Pressure injury', 'Skin tear', 'Surgical', 'Leg ulcer', 'Other'] },
      { id: 'size', label: 'Size', type: 'text', unit: 'cm' },
      { id: 'exudate', label: 'Exudate', type: 'choice', options: ['Nil', 'Low', 'Moderate', 'High'] },
      { id: 'dressing', label: 'Dressing', type: 'text' },
      { id: 'next', label: 'Next due', type: 'text' },
    ],
    engines: [...CORE, 213],
  },
  {
    code: '.skin', version: 1, label: 'Skin check', category: 'SKIN',
    fields: [
      { id: 'area', label: 'Area', type: 'text' },
      { id: 'finding', label: 'Finding', type: 'choice', options: ['Intact', 'Redness', 'Broken', 'Bruise', 'Rash'] },
      { id: 'care', label: 'Care given', type: 'text' },
    ],
    engines: [...CORE, 275],
  },
  {
    code: '.fall', version: 1, label: 'Fall', category: 'FALL',
    fields: [
      { id: 'where', label: 'Where', type: 'text' },
      { id: 'witnessed', label: 'Witnessed', type: 'choice', options: ['Yes', 'No'] },
      { id: 'head', label: 'Head strike', type: 'choice', options: ['Yes', 'No', 'Unknown'] },
      { id: 'injury', label: 'Injury', type: 'text' },
      { id: 'action', label: 'Action', type: 'text' },
    ],
    engines: [...CORE, 36, 269],
  },
  {
    code: '.intake', version: 1, label: 'Intake and output', category: 'INTAKE',
    fields: [
      { id: 'oral', label: 'Oral', type: 'number', unit: 'mL', min: 0, max: 20000 },
      { id: 'iv', label: 'IV', type: 'number', unit: 'mL', min: 0, max: 20000 },
      { id: 'output', label: 'Output', type: 'number', unit: 'mL', min: 0, max: 20000 },
      { id: 'food', label: 'Meal eaten', type: 'choice', options: ['All', 'Most', 'Half', 'Little', 'None'] },
    ],
    engines: [...CORE, 259, 244],
  },
  {
    code: '.cares', version: 1, label: 'Daily care', category: 'CARES',
    fields: [
      { id: 'hygiene', label: 'Hygiene', type: 'choice', options: ['Independent', 'Assisted', 'Full assist', 'Declined'] },
      { id: 'continence', label: 'Continence', type: 'text' },
      { id: 'mobility', label: 'Mobility', type: 'choice', options: ['Independent', 'Walker', 'Assist of 1', 'Assist of 2', 'Hoist', 'Bed rest'] },
      { id: 'sleep', label: 'Sleep', type: 'text' },
      { id: 'comment', label: 'Comment', type: 'text' },
    ],
    engines: [...CORE, 36, 261],
  },
  {
    code: '.behaviour', version: 1, label: 'Behaviour', category: 'BEHAVIOUR',
    fields: [
      { id: 'behaviour', label: 'Behaviour', type: 'text' },
      { id: 'trigger', label: 'Trigger', type: 'text' },
      { id: 'response', label: 'Response', type: 'text' },
      { id: 'outcome', label: 'Outcome', type: 'text' },
    ],
    engines: [...CORE, 36, 275],
  },
  {
    code: '.change', version: 1, label: 'Change noticed', category: 'CHANGE',
    fields: [
      { id: 'change', label: 'Change', type: 'text' },
      { id: 'since', label: 'Since', type: 'text' },
      { id: 'done', label: 'Done so far', type: 'text' },
    ],
    engines: [...CORE, 17, 225, 274],
  },
  {
    code: '.family', version: 1, label: 'Whānau contact', category: 'FAMILY',
    fields: [
      { id: 'who', label: 'Who', type: 'text' },
      { id: 'relationship', label: 'Relationship', type: 'text' },
      { id: 'discussed', label: 'Discussed', type: 'text' },
      { id: 'outcome', label: 'Outcome', type: 'text' },
    ],
    engines: [...CORE, 109, 252],
  },
  {
    code: '.assess', version: 1, label: 'Assessment', category: 'ASSESSMENT',
    fields: [
      { id: 'area', label: 'Area', type: 'choice', options: ['Skin', 'Mobility', 'Continence', 'Cognition', 'Pain', 'Nutrition', 'Mood', 'Sleep', 'Respiratory', 'Cardiovascular', 'Other'] },
      { id: 'finding', label: 'Finding', type: 'text' },
      { id: 'plan', label: 'Plan', type: 'text' },
    ],
    engines: [...CORE, 17, 227],
  },
  {
    code: '.review', version: 1, label: 'Review', category: 'REVIEW',
    fields: [
      { id: 'reviewed', label: 'Reviewed', type: 'text' },
      { id: 'impression', label: 'Impression', type: 'text' },
      { id: 'plan', label: 'Plan', type: 'text' },
      { id: 'next', label: 'Next review', type: 'text' },
    ],
    engines: [...CORE, 21, 241],
  },
  {
    code: '.progress', version: 1, label: 'Progress note', category: 'PROGRESS',
    fields: [{ id: 'note', label: 'Note', type: 'longtext' }],
    engines: [...CORE, 21, 229],
  },
  {
    code: '.problem', version: 1, label: 'Problem', category: 'PROBLEM',
    fields: [
      { id: 'problem', label: 'Problem', type: 'text' },
      { id: 'status', label: 'Status', type: 'choice', options: ['Active', 'Resolved', 'Under investigation'] },
      { id: 'note', label: 'Note', type: 'text' },
    ],
    engines: [...CORE, 228, 273],
  },
  {
    code: '.triage', version: 1, label: 'Triage', category: 'TRIAGE',
    fields: [
      { id: 'complaint', label: 'Presenting complaint', type: 'text' },
      { id: 'category', label: 'Triage category', type: 'choice', options: ['ATS 1', 'ATS 2', 'ATS 3', 'ATS 4', 'ATS 5'] },
      { id: 'area', label: 'Area', type: 'choice', options: ['Resus', 'Acute', 'Minors', 'Waiting room'] },
      { id: 'note', label: 'Triage note', type: 'text' },
    ],
    engines: [...CORE, 17, 225],
  },
  {
    code: '.medical', version: 1, label: 'Medical assessment', category: 'MEDICAL',
    fields: [
      { id: 'history', label: 'History', type: 'text' },
      { id: 'examination', label: 'Examination', type: 'text' },
      { id: 'impression', label: 'Impression', type: 'text' },
      { id: 'plan', label: 'Plan', type: 'text' },
    ],
    engines: [...CORE, 21, 227, 241],
  },
  {
    code: '.procedure', version: 1, label: 'Procedure', category: 'PROCEDURE',
    fields: [
      { id: 'procedure', label: 'Procedure', type: 'text' },
      { id: 'site', label: 'Site', type: 'text' },
      { id: 'outcome', label: 'Outcome', type: 'text' },
    ],
    engines: [...CORE, 229],
  },
  {
    code: '.disposition', version: 1, label: 'Disposition', category: 'DISPOSITION',
    fields: [
      { id: 'decision', label: 'Decision', type: 'choice', options: ['Admit', 'Discharge home', 'Transfer', 'Left before completion', 'Did not wait'] },
      { id: 'to', label: 'To', type: 'text' },
      { id: 'followup', label: 'Follow-up', type: 'text' },
      { id: 'note', label: 'Note', type: 'text' },
    ],
    engines: [...CORE, 241, 252],
  },
  {
    code: '.mobility', version: 1, label: 'Function and mobility', category: 'MOBILITY',
    fields: [
      { id: 'transfers', label: 'Transfers', type: 'choice', options: ['Independent', 'Supervision', 'Assist of 1', 'Assist of 2', 'Hoist'] },
      { id: 'aid', label: 'Walking aid', type: 'choice', options: ['None', 'Stick', 'Frame', 'Walker', 'Wheelchair'] },
      { id: 'distance', label: 'Distance', type: 'text', unit: 'm' },
      { id: 'note', label: 'Note', type: 'text' },
    ],
    engines: [...CORE, 36, 261],
  },
  {
    code: '.goals', version: 1, label: 'Goals', category: 'GOALS',
    fields: [
      { id: 'goal', label: 'Goal', type: 'text' },
      { id: 'by', label: 'By', type: 'text' },
      { id: 'agreed', label: 'Agreed with', type: 'text' },
    ],
    engines: [...CORE, 227],
  },
  {
    code: '.treatment', version: 1, label: 'Treatment', category: 'TREATMENT',
    fields: [
      { id: 'intervention', label: 'Intervention', type: 'text' },
      { id: 'response', label: 'Response', type: 'text' },
      { id: 'next', label: 'Next', type: 'text' },
    ],
    engines: [...CORE, 229],
  },
  {
    code: '.outcome', version: 1, label: 'Outcome measure', category: 'OUTCOME',
    fields: [
      { id: 'measure', label: 'Measure', type: 'text' },
      { id: 'score', label: 'Score', type: 'text' },
      { id: 'note', label: 'Note', type: 'text' },
    ],
    engines: [...CORE, 226],
  },
  {
    code: '.task', version: 1, label: 'Task', category: 'TASK',
    fields: [
      { id: 'task', label: 'Task', type: 'text' },
      { id: 'due', label: 'Due', type: 'text' },
    ],
    engines: [5, 6, 14, 217, 231, 281],
    createsTask: true,
  },
];

export const KEY_BY_CODE = new Map(KEYS.map((k) => [k.code, k]));

// Read-only retrieval views. ?view and the matching touch tab open the same thing.
export interface RetrieveView {
  code: string;
  label: string;
  kind: 'events' | 'overview' | 'meds' | 'results' | 'allergies' | 'careplan' | 'tasks' | 'handover' | 'routes' | 'history' | 'transfers' | 'discharge' | 'escalations' | 'consults' | 'wounds' | 'referrals' | 'appointments' | 'alerts' | 'communications' | 'monitoring' | 'restrictions' | 'diet' | 'equipment' | 'location' | 'leave' | 'preferences' | 'capacity' | 'support' | 'access' | 'external' | 'coding' | 'reported' | 'instruments' | 'function' | 'usual' | 'team' | 'acuity' | 'deterioration' | 'incidents' | 'death' | 'problems' | 'symptoms' | 'interventions' | 'treatmentplans' | 'pathways' | 'checklists' | 'recommendations' | 'requirements' | 'caredue' | 'recalls' | 'followups' | 'surveillance' | 'screening' | 'infections' | 'antimicrobials' | 'sitechecks' | 'readiness' | 'variances' | 'declined' | 'priorities' | 'identity';
  categories?: string[];
  key?: string;   // the .key a worker would use to add to this view
}

// Screens that also appear inside a department's own screen, so the work sits where it is done:
// ED priorities under Triage, site checks under Procedures, readiness under Disposition or Discharge.
export const EMBEDS: Record<string, string[]> = {
  triage: ['priorities'], procedures: ['sitechecks'], disposition: ['readiness'], discharge: ['readiness'],
};

export const VIEWS: RetrieveView[] = [
  { code: 'overview', label: 'Overview', kind: 'overview' },
  { code: 'history', label: 'History', kind: 'history' },
  { code: 'obs', label: 'Observations', kind: 'events', categories: ['OBS', 'BGL'], key: '.obs' },
  { code: 'bgl', label: 'Blood glucose', kind: 'events', categories: ['BGL'], key: '.bgl' },
  { code: 'weight', label: 'Weight', kind: 'events', categories: ['WEIGHT'], key: '.weight' },
  { code: 'pain', label: 'Pain', kind: 'events', categories: ['PAIN'], key: '.pain' },
  { code: 'symptoms', label: 'Symptoms', kind: 'symptoms' },
  { code: 'interventions', label: 'Interventions', kind: 'interventions' },
  { code: 'treatmentplans', label: 'Treatment plans', kind: 'treatmentplans' },
  { code: 'pathways', label: 'Pathways', kind: 'pathways' },
  { code: 'checklists', label: 'Checklists', kind: 'checklists' },
  { code: 'recommendations', label: 'Recommendations', kind: 'recommendations' },
  { code: 'requirements', label: 'Requirements', kind: 'requirements' },
  { code: 'caredue', label: 'Care due', kind: 'caredue' },
  { code: 'recalls', label: 'Recalls', kind: 'recalls' },
  { code: 'followups', label: 'Follow-ups', kind: 'followups' },
  { code: 'surveillance', label: 'Surveillance', kind: 'surveillance' },
  { code: 'screening', label: 'Screening', kind: 'screening' },
  { code: 'infections', label: 'Infections and isolation', kind: 'infections' },
  { code: 'antimicrobials', label: 'Antimicrobials', kind: 'antimicrobials' },
  { code: 'sitechecks', label: 'Site checks', kind: 'sitechecks' },
  { code: 'readiness', label: 'Readiness', kind: 'readiness' },
  { code: 'variances', label: 'Variances', kind: 'variances' },
  { code: 'declined', label: 'Declined care', kind: 'declined' },
  { code: 'priorities', label: 'Priority', kind: 'priorities' },
  { code: 'identity', label: 'Identity', kind: 'identity' },
  { code: 'wounds', label: 'Wounds', kind: 'wounds', categories: ['WOUND'] },
  { code: 'skin', label: 'Skin', kind: 'events', categories: ['SKIN', 'WOUND'], key: '.skin' },
  { code: 'falls', label: 'Falls', kind: 'events', categories: ['FALL'], key: '.fall' },
  { code: 'intake', label: 'Intake/Output', kind: 'events', categories: ['INTAKE'], key: '.intake' },
  { code: 'nutrition', label: 'Nutrition', kind: 'events', categories: ['INTAKE', 'WEIGHT'], key: '.intake' },
  { code: 'cares', label: 'Daily Care', kind: 'events', categories: ['CARES'], key: '.cares' },
  { code: 'behaviour', label: 'Behaviour', kind: 'events', categories: ['BEHAVIOUR'], key: '.behaviour' },
  { code: 'changes', label: 'Changes/Escalation', kind: 'events', categories: ['CHANGE'], key: '.change' },
  { code: 'family', label: 'Family', kind: 'events', categories: ['FAMILY'], key: '.family' },
  { code: 'assess', label: 'Assessment', kind: 'events', categories: ['ASSESSMENT'], key: '.assess' },
  { code: 'review', label: 'Review', kind: 'events', categories: ['REVIEW'], key: '.review' },
  { code: 'progress', label: 'Progress', kind: 'events', categories: ['PROGRESS', 'REVIEW'], key: '.progress' },
  { code: 'notes', label: 'Notes', kind: 'events', categories: ['PROGRESS'], key: '.progress' },
  { code: 'problems', label: 'Problems', kind: 'problems', key: '.problem' },
  { code: 'triage', label: 'Triage', kind: 'events', categories: ['TRIAGE'], key: '.triage' },
  { code: 'medical', label: 'Medical Assessment', kind: 'events', categories: ['MEDICAL'], key: '.medical' },
  { code: 'procedures', label: 'Procedures', kind: 'events', categories: ['PROCEDURE'], key: '.procedure' },
  { code: 'disposition', label: 'Disposition', kind: 'events', categories: ['DISPOSITION'], key: '.disposition' },
  { code: 'mobility', label: 'Function/Mobility', kind: 'events', categories: ['MOBILITY'], key: '.mobility' },
  { code: 'goals', label: 'Goals', kind: 'events', categories: ['GOALS'], key: '.goals' },
  { code: 'treatment', label: 'Treatment', kind: 'events', categories: ['TREATMENT'], key: '.treatment' },
  { code: 'outcomes', label: 'Outcome Measures', kind: 'events', categories: ['OUTCOME'], key: '.outcome' },
  { code: 'meds', label: 'Medicines', kind: 'meds' },
  { code: 'results', label: 'Results', kind: 'results' },
  { code: 'allergies', label: 'Allergies', kind: 'allergies' },
  { code: 'careplan', label: 'Care Plan', kind: 'careplan' },
  { code: 'tasks', label: 'Tasks', kind: 'tasks', key: '.task' },
  { code: 'handover', label: 'Handover', kind: 'handover' },
  { code: 'routes', label: 'Sent and received', kind: 'routes' },
  { code: 'transfers', label: 'Admission/Transfer', kind: 'transfers' },
  { code: 'discharge', label: 'Discharge', kind: 'discharge' },
  { code: 'escalations', label: 'Escalations', kind: 'escalations' },
  { code: 'consults', label: 'Consultations', kind: 'consults' },
  { code: 'referrals', label: 'Referrals', kind: 'referrals' },
  { code: 'appointments', label: 'Appointments', kind: 'appointments' },
  { code: 'alerts', label: 'Alerts', kind: 'alerts' },
  { code: 'communications', label: 'Communications', kind: 'communications' },
  { code: 'monitoring', label: 'Monitoring', kind: 'monitoring' },
  { code: 'restrictions', label: 'Restrictions', kind: 'restrictions' },
  { code: 'diet', label: 'Diet and meals', kind: 'diet' },
  { code: 'equipment', label: 'Equipment', kind: 'equipment' },
  { code: 'location', label: 'Bed and location', kind: 'location' },
  { code: 'absence', label: 'Care level and time away', kind: 'leave' },
  { code: 'preferences', label: 'Preferences', kind: 'preferences' },
  { code: 'capacity', label: 'Consent and capacity', kind: 'capacity' },
  { code: 'support', label: 'Whānau and support', kind: 'support' },
  { code: 'access', label: 'Communication needs', kind: 'access' },
  { code: 'external', label: 'From other providers', kind: 'external' },
  { code: 'coding', label: 'Coding', kind: 'coding' },
  { code: 'reported', label: 'In their words', kind: 'reported' },
  { code: 'instruments', label: 'Questionnaires', kind: 'instruments' },
  { code: 'function', label: 'Function', kind: 'function' },
  { code: 'usual', label: 'Usual state', kind: 'usual' },
  { code: 'acuity', label: 'Clinical status', kind: 'acuity' },
  { code: 'deterioration', label: 'Deterioration', kind: 'deterioration' },
  { code: 'incidents', label: 'Incidents and safeguarding', kind: 'incidents' },
  { code: 'death', label: 'End of life', kind: 'death' },
  { code: 'team', label: 'Care team', kind: 'team' },
];

export const VIEW_BY_CODE = new Map(VIEWS.map((v) => [v.code, v]));
