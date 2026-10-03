// Visits to people where they are (matrix: Visits tab for district nursing, hospice and other home and
// community services). SHIFT records the plan and what happened. Visit frequency, response times,
// eligibility and lone-worker arrangements are not set by SHIFT (RR-VISITS-001); the reasons a visit is
// not done are a rule the organisation's jurisdiction sets (visit.not_done_reasons, see ruleset.ts).
export const STATES: Record<string, string> = { PLANNED: 'Planned', DONE: 'Done', NOT_DONE: 'Not done', CANCELLED: 'Cancelled' };
export const REFS = ['ORG-SYN-001 v1', 'RR-VISITS-001'];
