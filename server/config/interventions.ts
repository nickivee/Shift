// Intervention settings (Shared Lifecycle Object 276). The synthetic organisation's own
// categories and which need a doctor's authorisation before they start (ORG-SYN-001). Which
// interventions New Zealand law or a regulator requires to be authorised, and by whom, is a
// research requirement (RR-INT-001); restraint is not offered here because its rules
// (NZS 8134 and the restraint elimination guidance) have not yet been researched.

export interface Category { id: string; label: string; authorise: boolean }
export const CATEGORIES: Category[] = [
  { id: 'NURSING', label: 'Nursing care', authorise: false },
  { id: 'THERAPY', label: 'Therapy or exercise', authorise: false },
  { id: 'COMFORT', label: 'Comfort measure', authorise: false },
  { id: 'DEVICE', label: 'Device (catheter, line, tube)', authorise: true },
  { id: 'PROCEDURE', label: 'Procedure', authorise: true },
  { id: 'OTHER', label: 'Other', authorise: false },
];
export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const FREQUENCIES: Record<string, string> = {
  ONCE: 'Once', HOURS: 'Every few hours', DAILY: 'Once a day', AS_NEEDED: 'When needed',
};

export const REVIEW: Record<string, string> = {
  CONTINUE: 'Continue as it is', MODIFY: 'Change it', CEASE: 'Stop it',
};
