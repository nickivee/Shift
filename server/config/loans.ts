// Equipment lent to a person to take home (entry 198):
//   on the register → fitted and lent, with how to use it and when it is due back → returned →
//   cleaned before anyone else has it → available again. Damaged or missing parts take it out of
//   use; one that never comes back is written off. Which aids are lent and for how long are the
//   synthetic organisation's own settings (ORG-SYN-001). Funding eligibility (ACC, Whaikaha,
//   Te Whatu Ora) and the national cleaning standard for reusable equipment are RR-LOAN-001.

export const LOANABLE: Record<string, string> = {
  WALKING_FRAME: 'Walking frame',
  CRUTCHES: 'Crutches',
  WALKING_STICK: 'Walking stick',
  SHOWER_STOOL: 'Shower stool',
  TOILET_FRAME: 'Toilet frame',
  WHEELCHAIR: 'Wheelchair',
};

export const CONDITION: Record<string, string> = {
  GOOD: 'Back in good order',
  DAMAGED: 'Damaged or worn',
  INCOMPLETE: 'Parts missing',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-LOAN-001'];
