// Procedures (Shared Lifecycle Object 211). Which procedures need written consent, who may do
// each one and how long recovery observations run are organisational settings (ORG-SYN-001);
// national requirements are RR-PROC-001. SHIFT links to the person's own consent (consent.ts)
// and site check (siteverify.ts) rather than keeping its own copies.

export const STATES: Record<string, string> = {
  PROPOSED: 'Proposed',
  PLANNED: 'Planned',
  IN_PROGRESS: 'Happening now',
  RECOVERY: 'Recovering',
  FINISHED: 'Finished',
  CANCELLED: 'Cancelled',
};

export const HOW: Record<string, string> = {
  COMPLETED: 'Done as planned',
  MODIFIED: 'Done, but changed',
  ABANDONED: 'Stopped before finishing',
};

// When there is no consent to link: only an emergency, written in the doctor's words.
export const NO_CONSENT: Record<string, string> = {
  EMERGENCY: 'Emergency: no time to ask, and it cannot wait',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-PROC-001'];
