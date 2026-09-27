// Baseline / usual state vocabulary (Shared Lifecycle Object 262). What SHIFT asks about when
// recording how someone usually is. Everyday function (walking, washing and so on) is recorded
// in Function (Object 261). A usual range for a measurement is what is normal for this person;
// it does not change early warning scores or any prescribed target.

export interface UsualDomain {
  id: string;
  label: string;
  hint: string;
  measure?: { field: string; unit: string; min: number; max: number };   // read from the latest observations
}

export const DOMAINS: UsualDomain[] = [
  { id: 'THINKING', label: 'Thinking and memory', hint: 'e.g. sharp, does the crossword; or forgetful, knows family but not the date' },
  { id: 'COMMUNICATION', label: 'Speech and understanding', hint: 'e.g. clear speech; hard of hearing on the left' },
  { id: 'MOOD', label: 'Mood and behaviour', hint: 'e.g. cheerful and chatty; anxious in the evenings' },
  { id: 'EATING', label: 'Appetite and eating', hint: 'e.g. good appetite, finishes meals' },
  { id: 'CONTINENCE', label: 'Bladder and bowels', hint: 'e.g. continent; bowels daily' },
  { id: 'SLEEP', label: 'Sleep', hint: 'e.g. sleeps through; up once to the toilet' },
  { id: 'SKIN', label: 'Skin', hint: 'e.g. fragile skin on shins' },
  { id: 'PAIN', label: 'Pain', hint: 'e.g. knee pain 3 out of 10 most days' },
  { id: 'SPO2', label: 'Oxygen saturation', hint: 'e.g. lives at 88 to 92% on room air', measure: { field: 'spo2', unit: '%', min: 50, max: 100 } },
  { id: 'HR', label: 'Heart rate', hint: 'e.g. usually 50s on a beta blocker', measure: { field: 'hr', unit: 'bpm', min: 20, max: 250 } },
  { id: 'SYSTOLIC', label: 'Systolic blood pressure', hint: 'e.g. usually 100 to 110', measure: { field: 'bp', unit: 'mmHg', min: 50, max: 260 } },
  { id: 'RR', label: 'Breathing rate', hint: 'e.g. usually 20 to 24 with COPD', measure: { field: 'rr', unit: '/min', min: 4, max: 60 } },
];

export const DOMAIN_BY_ID = new Map(DOMAINS.map((d) => [d.id, d]));
