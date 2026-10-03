// Privacy access review (entries 32, 33): who looked at a record, whether it was appropriate, and
// what was done. SHIFT decides nothing about what is a breach or who must be told (RR-PRIVACYREVIEW-001).
export const STATES: Record<string, string> = { OPEN: 'Looking into it', FINDING: 'To close', CLOSED: 'Closed' };
export const SOURCE: Record<string, string> = { COMPLAINT: 'Someone raised a concern', FLAGGED: 'Flagged on the list', ROUTINE: 'Routine check', OTHER: 'Something else' };
export const FINDING: Record<string, string> = { APPROPRIATE: 'All of it was appropriate', NOT_APPROPRIATE: 'Some of it was not appropriate', UNCLEAR: 'Could not tell' };
export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-001', 'RR-PRIVACYREVIEW-001'];
