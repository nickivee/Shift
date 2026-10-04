// The baby's own record and feeding (matrix: Baby and Feeding tabs for maternity). SHIFT opens a record for the baby, linked
// to the mother, with a placeholder name, the birth time and a local number only. It does not create or allocate an NHI,
// register the birth, or set any newborn screening, checks, feeding targets or amounts: the Health NZ pages on newborn
// NHIs refused automated reading and nothing was assumed (RR-NEWBORN-001). Feeds are recorded as the clinician writes them.
export const BABY_STATES: Record<string, string> = { ACTIVE: 'Open', ENTERED_IN_ERROR: 'Entered in error' };
export const FEED_STATES: Record<string, string> = { GIVEN: 'Recorded', ENTERED_IN_ERROR: 'Entered in error' };
export const METHODS: { code: string; label: string }[] = [
  { code: 'BREAST', label: 'Breastfed' }, { code: 'EXPRESSED', label: 'Expressed milk' }, { code: 'FORMULA', label: 'Formula' }, { code: 'OTHER', label: 'Another way, as written' },
];
export const REFS = ['ORG-SYN-001 v1', 'RR-NEWBORN-001'];
