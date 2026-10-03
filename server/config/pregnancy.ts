// Pregnancy (matrix: Pregnancy tab for midwives and obstetric doctors). SHIFT records what the clinician
// enters. Due-date rules, risk thresholds, visit schedules, fetal monitoring, the baby's own record and NHI,
// and birth registration are not set by SHIFT (RR-MATERNITY-001); the ways a birth is recorded are a rule the
// organisation's jurisdiction sets (pregnancy.birth_modes, see ruleset.ts).
export const STATES: Record<string, string> = {
  ANTENATAL: 'Antenatal', LABOUR: 'In labour', BIRTHED: 'Baby born', POSTNATAL: 'Postnatal', CLOSED: 'Care ended', ENTERED_IN_ERROR: 'Entered in error',
};
export const REFS = ['ORG-SYN-001 v1', 'RR-MATERNITY-001'];
