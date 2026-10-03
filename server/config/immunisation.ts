// Immunisation (matrix: Immunisation tab for general practice and practice nursing). SHIFT records which vaccine was given
// or not given, when, the dose in the clinician's words, where, and the batch number. The list of vaccines comes from the
// organisation's jurisdiction (immunisation.vaccines, see ruleset.ts) and is taken from the National Immunisation Schedule
// on the Health NZ website. SHIFT sets no ages, intervals, eligibility, who may vaccinate, consent steps or reporting to the
// National Immunisation Register (RR-IMMUNISATION-001).
export const STATES: Record<string, string> = { GIVEN: 'Given', NOT_GIVEN: 'Not given', ENTERED_IN_ERROR: 'Entered in error' };
export const NOT_GIVEN_REASONS: { code: string; label: string }[] = [
  { code: 'DECLINED', label: 'Declined' }, { code: 'UNWELL', label: 'Unwell today' }, { code: 'OTHER', label: 'Another reason, as written' },
];
export interface Vaccine { code: string; label: string }
export const REFS = ['ORG-SYN-001 v1', 'RR-IMMUNISATION-001'];
