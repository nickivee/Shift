// Record retention, legal holds and disposal (entries 27, 28). SHIFT sets no retention period and
// deletes nothing. It records holds, the review of a record against the rule the privacy officer
// names, the decision, and the evidence of what was done (RR-RETENTION-001).
export const REVIEW_STATES: Record<string, string> = { DUE: 'To decide', DECIDED: 'To carry out', DONE: 'Done' };
export const HOLD_STATES: Record<string, string> = { ACTIVE: 'On hold', RELEASED: 'Released' };
export const DECISION: Record<string, string> = { KEEP: 'Keep it', DISPOSE: 'Dispose of it', TRANSFER: 'Send it to another provider' };
export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-006', 'RR-RETENTION-001'];
