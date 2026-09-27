// Clinical status settings (Shared Lifecycle Object 267): the levels a clinician can record and
// how soon each must be looked at again. These are the synthetic organisation's own settings
// (ORG-SYN-001). They are a clinician's judgement, not a score: which NZ early-warning and
// acuity tools apply, and how they are calculated, are research requirements (RR-EWS-001,
// RR-ACU-001), so SHIFT calculates nothing.

export interface Level { id: string; label: string; short: string; rank: number; reviewHours: number; tone: string; implication: string; escalate: boolean }
export const LEVELS: Level[] = [
  { id: 'STABLE', label: 'Stable', short: 'Stable', rank: 0, reviewHours: 24, tone: 'ok', implication: 'Usual care and observations.', escalate: false },
  { id: 'WATCH', label: 'Needs closer watching', short: 'Watch', rank: 1, reviewHours: 8, tone: 'warn', implication: 'Watch more closely and tell the nurse in charge.', escalate: false },
  { id: 'UNWELL', label: 'Unwell: needs a senior review', short: 'Unwell', rank: 2, reviewHours: 4, tone: 'danger', implication: 'A senior clinician should review them. Think about their allocation.', escalate: true },
  { id: 'CRITICAL', label: 'Critically unwell', short: 'Critical', rank: 3, reviewHours: 1, tone: 'danger', implication: 'Urgent medical review now. Follow the service\'s emergency process.', escalate: true },
];
export const LEVEL_BY_ID = new Map(LEVELS.map((l) => [l.id, l]));
