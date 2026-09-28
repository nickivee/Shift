// Procedure site and side check settings (Shared Lifecycle Object 291). The sides, the sources a
// site can be checked against, and what each check needs are the synthetic organisation's own
// lists (ORG-SYN-001), modelled on the surgical safety checklist. Which procedures outside theatre
// must have a site mark and a team time-out in New Zealand is a research requirement (RR-SITE-001).

export const SIDES: Record<string, string> = {
  LEFT: 'Left', RIGHT: 'Right', BILATERAL: 'Both sides', MIDLINE: 'Midline', NOT_APPLICABLE: 'No side',
};

export const CHECK_KINDS: Record<string, string> = {
  SOURCE: 'Checked against a document', PATIENT: 'Checked with the person', MARK: 'Site marked', TEAM: 'Team time-out',
};

export const SOURCES: Record<string, string> = {
  CONSENT: 'Consent form', IMAGING: 'Imaging report', REFERRAL: 'Referral or request', NOTES: 'Clinical notes', SCHEDULE: 'Procedure list', OTHER: 'Other',
};

// What a check can find. Not every outcome fits every kind of check.
export const OUTCOMES: Record<string, string> = {
  MATCH: 'Matches the planned site and side', MISMATCH: 'Does not match', UNABLE: 'The person cannot confirm', NOT_REQUIRED: 'Not required',
};
export const OUTCOMES_FOR: Record<string, string[]> = {
  SOURCE: ['MATCH', 'MISMATCH'], PATIENT: ['MATCH', 'MISMATCH', 'UNABLE'], MARK: ['MATCH', 'NOT_REQUIRED'], TEAM: ['MATCH', 'MISMATCH'],
};
