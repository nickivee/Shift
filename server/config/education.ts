// Education (matrix: Education tab for general practice). SHIFT records what was explained, to whom, how well it was
// understood in the clinician's judgement, and whether more is needed. Education content, schedules and the
// materials used are not set by SHIFT (RR-EDUCATION-001).
export const STATES: Record<string, string> = { DONE: 'Done', FOLLOW_UP: 'More needed', ENTERED_IN_ERROR: 'Entered in error' };
export const GIVEN_TO: { code: string; label: string }[] = [
  { code: 'PERSON', label: 'The person' }, { code: 'WHANAU', label: 'Whānau or carer' }, { code: 'BOTH', label: 'The person and whānau' },
];
export const UNDERSTANDING: { code: string; label: string }[] = [
  { code: 'UNDERSTOOD', label: 'Understood' }, { code: 'PARTLY', label: 'Partly understood' }, { code: 'NEEDS_MORE', label: 'Needs more teaching' }, { code: 'DECLINED', label: 'Declined' },
];
export const REFS = ['ORG-SYN-001 v1', 'RR-EDUCATION-001'];
