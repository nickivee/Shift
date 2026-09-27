// Questionnaire / assessment instrument library (Shared Lifecycle Object 257).
// Each instrument is identified by code and version, and every administration records both, so a
// score is always read against the version that produced it. SHIFT includes only instruments whose
// publishers allow free clinical use. Their text was entered from the publishers' forms and must be
// checked against the current published version before clinical use. Which instruments each NZ
// setting must use, and licensed instruments such as interRAI, are still being researched
// (RR-INSTR-001).

export interface InstrumentOption { label: string; score: number }
export interface InstrumentItem { id: string; text: string; options: InstrumentOption[] }
export interface InstrumentBand { min: number; max: number; label: string; tone: 'ok' | 'warn' | 'danger' }
export interface InstrumentFlag { item: string; atLeast: number; text: string }
export interface Instrument {
  code: string;
  version: string;
  name: string;
  purpose: string;
  source: string;
  licence: string;
  preamble: string;
  items: InstrumentItem[];
  bands: InstrumentBand[];
  flags: InstrumentFlag[];
  selfComplete: boolean;       // the person may fill it in themselves
  repeatDays: number;          // suggested gap before repeating
}

const PHQ_OPTIONS: InstrumentOption[] = [
  { label: 'Not at all', score: 0 },
  { label: 'Several days', score: 1 },
  { label: 'More than half the days', score: 2 },
  { label: 'Nearly every day', score: 3 },
];

export const INSTRUMENTS: Instrument[] = [
  {
    code: 'PHQ-9',
    version: 'PHQ-9 (Pfizer, 1999)',
    name: 'Patient Health Questionnaire (PHQ-9)',
    purpose: 'Depression: screening and measuring severity over time',
    source: 'Spitzer, Williams, Kroenke and colleagues; Pfizer Inc.',
    licence: 'The publisher states no permission is required to reproduce, translate, display or distribute it.',
    preamble: 'Over the last 2 weeks, how often have you been bothered by any of the following problems?',
    items: [
      { id: 'q1', text: 'Little interest or pleasure in doing things', options: PHQ_OPTIONS },
      { id: 'q2', text: 'Feeling down, depressed, or hopeless', options: PHQ_OPTIONS },
      { id: 'q3', text: 'Trouble falling or staying asleep, or sleeping too much', options: PHQ_OPTIONS },
      { id: 'q4', text: 'Feeling tired or having little energy', options: PHQ_OPTIONS },
      { id: 'q5', text: 'Poor appetite or overeating', options: PHQ_OPTIONS },
      { id: 'q6', text: 'Feeling bad about yourself, or that you are a failure or have let yourself or your family down', options: PHQ_OPTIONS },
      { id: 'q7', text: 'Trouble concentrating on things, such as reading the newspaper or watching television', options: PHQ_OPTIONS },
      { id: 'q8', text: 'Moving or speaking so slowly that other people could have noticed, or the opposite: being so fidgety or restless that you have been moving around a lot more than usual', options: PHQ_OPTIONS },
      { id: 'q9', text: 'Thoughts that you would be better off dead, or of hurting yourself in some way', options: PHQ_OPTIONS },
    ],
    bands: [
      { min: 0, max: 4, label: 'Minimal', tone: 'ok' },
      { min: 5, max: 9, label: 'Mild', tone: 'warn' },
      { min: 10, max: 14, label: 'Moderate', tone: 'warn' },
      { min: 15, max: 19, label: 'Moderately severe', tone: 'danger' },
      { min: 20, max: 27, label: 'Severe', tone: 'danger' },
    ],
    flags: [{ item: 'q9', atLeast: 1, text: 'Thoughts of being better off dead or of self-harm were reported. A clinician must follow this up now.' }],
    selfComplete: true,
    repeatDays: 14,
  },
  {
    code: '4AT',
    version: '4AT version 1.2',
    name: '4AT: rapid assessment test for delirium',
    purpose: 'Delirium and cognitive impairment: quick screening',
    source: 'MacLullich, Ryan and Cash; www.the4at.com',
    licence: 'The publisher states it is free to download and use.',
    preamble: 'Score each item from what you observe and what the person answers.',
    items: [
      { id: 'alertness', text: '[1] Alertness: may be drowsy, agitated or hyperactive. Observe; if asleep, try to wake with speech or a gentle touch on the shoulder.', options: [
        { label: 'Normal (fully alert, but not agitated, throughout assessment)', score: 0 },
        { label: 'Mild sleepiness for under 10 seconds after waking, then normal', score: 0 },
        { label: 'Clearly abnormal', score: 4 },
      ] },
      { id: 'amt4', text: '[2] AMT4: age, date of birth, place (name of the hospital or building), current year.', options: [
        { label: 'No mistakes', score: 0 },
        { label: '1 mistake', score: 1 },
        { label: '2 or more mistakes, or untestable', score: 2 },
      ] },
      { id: 'attention', text: '[3] Attention: "Please tell me the months of the year in backwards order, starting at December."', options: [
        { label: 'Achieves 7 months or more correctly', score: 0 },
        { label: 'Starts but scores fewer than 7 months, or refuses to start', score: 1 },
        { label: 'Untestable (cannot start because unwell, drowsy or inattentive)', score: 2 },
      ] },
      { id: 'change', text: '[4] Acute change or fluctuating course: evidence of significant change or fluctuation in alertness, cognition or other mental function arising over the last 2 weeks and still evident in the last 24 hours.', options: [
        { label: 'No', score: 0 },
        { label: 'Yes', score: 4 },
      ] },
    ],
    bands: [
      { min: 0, max: 0, label: 'Delirium or severe cognitive impairment unlikely (delirium still possible if item 4 is incomplete)', tone: 'ok' },
      { min: 1, max: 3, label: 'Possible cognitive impairment', tone: 'warn' },
      { min: 4, max: 12, label: 'Possible delirium, with or without cognitive impairment', tone: 'danger' },
    ],
    flags: [],
    selfComplete: false,
    repeatDays: 1,
  },
];

export const INSTRUMENT_BY_CODE = new Map(INSTRUMENTS.map((i) => [i.code, i]));
