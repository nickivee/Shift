// Surveillance plan settings (Shared Lifecycle Object 285). The kinds of surveillance, their usual
// checks and intervals, what a result can show, and why a plan stops are the synthetic
// organisation's own lists (ORG-SYN-001). Who may decide to continue, change or stop a plan, and
// how long a concerning result may wait for review, are research requirements (RR-SURV-001).

export interface SurvKind { id: string; label: string; check: string; everyDays: number | null }

export const KINDS: SurvKind[] = [
  { id: 'KIDNEY_POTASSIUM', label: 'Kidney function and potassium', check: 'Creatinine, eGFR and potassium', everyDays: 7 },
  { id: 'LITHIUM', label: 'Lithium level', check: 'Lithium level 12 hours after the dose, with kidney and thyroid function', everyDays: 91 },
  { id: 'INR', label: 'Warfarin (INR)', check: 'INR', everyDays: 7 },
  { id: 'WEIGHT_HF', label: 'Weight for heart failure', check: 'Weigh at the same time each day, same scales', everyDays: 1 },
  { id: 'SKIN_LESION', label: 'Skin lesion', check: 'Photograph and measure the lesion', everyDays: 28 },
  { id: 'NEURO_FALL', label: 'After a fall on a blood thinner', check: 'Conscious level, pupils and limb power', everyDays: null },
  { id: 'OTHER', label: 'Other', check: '', everyDays: null },
];
export const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

// Interval in days; '0' means only when the trigger happens.
export const INTERVALS: Record<string, string> = {
  '0': 'Only when triggered', '1': 'Every day', '2': 'Every 2 days', '7': 'Every week', '14': 'Every 2 weeks', '28': 'Every 4 weeks',
  '91': 'Every 3 months', '182': 'Every 6 months', '365': 'Every year',
};

export const FINDINGS: Record<string, string> = {
  EXPECTED: 'As expected', CHANGED: 'Changed, not urgent', CONCERNING: 'Concerning',
};

export const NOT_DONE_REASONS: Record<string, string> = {
  DECLINED: 'The person declined', AWAY: 'The person was away', NOT_POSSIBLE: 'Could not be done (e.g. no access, sample failed)', OTHER: 'Other',
};

export const DECISIONS: Record<string, string> = {
  CONTINUE: 'Continue as planned', MODIFY: 'Change the plan', CEASE: 'Stop surveillance',
};

export const CEASE_REASONS: Record<string, string> = {
  NO_LONGER_NEEDED: 'No longer needed', MEDICINE_STOPPED: 'The medicine was stopped', CARE_ELSEWHERE: 'Care moved to another provider',
  DECLINED: 'The person declined further checks', OTHER: 'Other',
};

// Due soon: within this many days of the due date.
export const DUE_SOON_DAYS = 7;
