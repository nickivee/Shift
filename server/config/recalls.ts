// Recall settings (Shared Lifecycle Object 283). The kinds of recall, their usual intervals, how
// people are contacted and why a recall ends are the synthetic organisation's own lists
// (ORG-SYN-001). National screening and immunisation programmes run their own recall rules;
// how a service's recall relates to them, and what consent a recall contact needs, are research
// requirements (RR-RECALL-001).

export interface RecallKind { id: string; label: string; everyDays: number | null }

export const KINDS: RecallKind[] = [
  { id: 'FLU', label: 'Influenza vaccine', everyDays: 365 },
  { id: 'B12', label: 'Vitamin B12 injection', everyDays: 91 },
  { id: 'MEDS_REVIEW', label: 'Medicines review with the GP', everyDays: 182 },
  { id: 'EYES', label: 'Eye check (optometrist)', everyDays: 365 },
  { id: 'HF_REVIEW', label: 'Heart failure nurse review', everyDays: null },
  { id: 'OTHER', label: 'Other', everyDays: null },
];
export const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

export const INTERVALS: Record<string, string> = {
  '0': 'Once', '28': 'Every 4 weeks', '42': 'Every 6 weeks', '91': 'Every 3 months', '182': 'Every 6 months', '365': 'Every year',
};

export const CHANNELS: Record<string, string> = {
  IN_PERSON: 'Told them in person', PHONE: 'By phone', LETTER: 'By letter', TEXT: 'By text message', WHANAU: 'Through their whānau or representative',
};

export const EXIT_REASONS: Record<string, string> = {
  NOT_ELIGIBLE: 'No longer eligible', DECLINED: 'The person declined', LEFT_SERVICE: 'Left the service', NO_LONGER_NEEDED: 'No longer needed', OTHER: 'Other',
};

// Due soon: within this many days of the due date.
export const DUE_SOON_DAYS = 30;
