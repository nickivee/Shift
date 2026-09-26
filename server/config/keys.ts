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
  kind: 'events' | 'overview' | 'meds' | 'results' | 'allergies' | 'careplan' | 'tasks' | 'handover' | 'routes' | 'history';
  categories?: string[];
  key?: string;   // the .key a worker would use to add to this view
}

export const VIEWS: RetrieveView[] = [
  { code: 'overview', label: 'Overview', kind: 'overview' },
  { code: 'history', label: 'History', kind: 'history' },
  { code: 'obs', label: 'Observations', kind: 'events', categories: ['OBS', 'BGL'], key: '.obs' },
  { code: 'bgl', label: 'Blood glucose', kind: 'events', categories: ['BGL'], key: '.bgl' },
  { code: 'weight', label: 'Weight', kind: 'events', categories: ['WEIGHT'], key: '.weight' },
  { code: 'pain', label: 'Pain', kind: 'events', categories: ['PAIN'], key: '.pain' },
  { code: 'wounds', label: 'Wounds', kind: 'events', categories: ['WOUND'], key: '.wound' },
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
  { code: 'problems', label: 'Problems', kind: 'events', categories: ['PROBLEM'], key: '.problem' },
  { code: 'meds', label: 'Medicines', kind: 'meds' },
  { code: 'results', label: 'Results', kind: 'results' },
  { code: 'allergies', label: 'Allergies', kind: 'allergies' },
  { code: 'careplan', label: 'Care Plan', kind: 'careplan' },
  { code: 'tasks', label: 'Tasks', kind: 'tasks', key: '.task' },
  { code: 'handover', label: 'Handover', kind: 'handover' },
  { code: 'routes', label: 'Sent and received', kind: 'routes' },
];

export const VIEW_BY_CODE = new Map(VIEWS.map((v) => [v.code, v]));
