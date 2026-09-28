// Screening settings (Shared Lifecycle Object 286). The screens a service offers, how often they
// are repeated, how people are offered and told, and why an episode ends are the synthetic
// organisation's own lists (ORG-SYN-001). National screening programmes (bowel, breast, cervical,
// diabetic retinal) have their own eligibility, consent and result rules; how a service's own
// screening relates to them is a research requirement (RR-SCREEN-001), so SHIFT does not act as
// a national programme register.

export interface ScreenKind { id: string; label: string; test: string; everyDays: number | null }

export const KINDS: ScreenKind[] = [
  { id: 'RETINAL', label: 'Diabetic eye screening', test: 'Retinal photographs', everyDays: 730 },
  { id: 'HEP_C', label: 'Hepatitis C', test: 'Hepatitis C antibody blood test', everyDays: null },
  { id: 'COGNITION', label: 'Memory and thinking', test: 'Cognitive screen (e.g. MoCA)', everyDays: 365 },
  { id: 'MOOD', label: 'Low mood', test: 'Mood screen (e.g. GDS-15)', everyDays: 182 },
  { id: 'HEARING', label: 'Hearing', test: 'Whisper test and ear check', everyDays: 365 },
  { id: 'OTHER', label: 'Other', test: '', everyDays: null },
];
export const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

export const CHANNELS: Record<string, string> = {
  IN_PERSON: 'In person', PHONE: 'By phone', LETTER: 'By letter', TEXT: 'By text message', WHANAU: 'Through their whānau or representative',
};

export const FINDINGS: Record<string, string> = {
  NORMAL: 'Normal', ABNORMAL: 'Abnormal', INCONCLUSIVE: 'Inconclusive',
};

export const OUTCOMES: Record<string, string> = {
  RECALL: 'Screen again later', ESCALATE: 'Further tests or referral', EXIT: 'No more screening',
};

export const EXIT_REASONS: Record<string, string> = {
  NOT_ELIGIBLE: 'No longer eligible', DECLINED: 'The person declined', DIAGNOSED: 'Already diagnosed; screening no longer applies',
  LEFT_SERVICE: 'Left the service', OTHER: 'Other',
};

// Offer soon: within this many days of the due date.
export const OFFER_SOON_DAYS = 30;
