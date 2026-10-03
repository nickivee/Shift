// Eligibility (matrix: Eligibility tab for district and community nursing). SHIFT records that someone checked whether a
// person is eligible for publicly funded services, what the eligibility was based on, what was seen, and the outcome.
// The categories, evidence and rules of the Health and Disability Services Eligibility Direction 2011 are not set by SHIFT
// (RR-ELIGIBILITY-001). Health NZ's public page says checking eligibility is the responsibility of every provider giving
// publicly funded care, and that a person must be eligible at the time they receive a service because eligibility is not
// retrospective.
export const STATES: Record<string, string> = { CHECKED: 'Checked', ENTERED_IN_ERROR: 'Entered in error' };
export const OUTCOMES: { code: string; label: string }[] = [
  { code: 'ELIGIBLE', label: 'Eligible' }, { code: 'NOT_ELIGIBLE', label: 'Not eligible' }, { code: 'UNCONFIRMED', label: 'Not yet confirmed' },
];
export const SOURCE_NOTE = 'Checking eligibility is the responsibility of every provider giving publicly funded care, and a person must be eligible when they receive a service because eligibility is not retrospective (Health NZ, Eligibility explained).';
export const REFS = ['ORG-SYN-001 v1', 'RR-ELIGIBILITY-001'];
