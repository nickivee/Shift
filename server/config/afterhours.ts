// After-hours contacts (matrix: After-hours tab for palliative care / hospice). SHIFT records who made contact,
// what they were worried about, the advice given, what came of it, and the day team's review. Response times,
// triage rules, advice content and on-call arrangements are not set by SHIFT (RR-AFTERHOURS-001).
export const STATES: Record<string, string> = { OPEN: 'To review', REVIEWED: 'Reviewed', ENTERED_IN_ERROR: 'Entered in error' };
export const CALLERS: { code: string; label: string }[] = [
  { code: 'PERSON', label: 'The person' }, { code: 'WHANAU', label: 'Whānau or carer' }, { code: 'SERVICE', label: 'Another service' }, { code: 'OTHER', label: 'Someone else' },
];
export const OUTCOMES: { code: string; label: string }[] = [
  { code: 'ADVICE', label: 'Advice given' }, { code: 'VISIT', label: 'Visit arranged' }, { code: 'ADMITTED', label: 'Admitted' }, { code: 'AMBULANCE', label: 'Ambulance called' },
  { code: 'OTHER', label: 'Something else, as written' },
];
export const REFS = ['ORG-SYN-001 v1', 'RR-AFTERHOURS-001'];
