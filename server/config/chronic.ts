// Chronic care (matrix: Chronic Care tab for general practice). SHIFT records the long-term condition and goals as the
// clinician writes them, when the next review is due, and each review. Review intervals, care standards, targets and
// funding programmes are not set by SHIFT (RR-CHRONIC-001).
export const STATES: Record<string, string> = { ACTIVE: 'Active', ENDED: 'Ended', ENTERED_IN_ERROR: 'Entered in error' };
export const REFS = ['ORG-SYN-001 v1', 'RR-CHRONIC-001'];
