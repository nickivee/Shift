// Palliative and end-of-life care (entries 53, 54, 166). A person is recognised as needing
// palliative care, their wishes are recorded in their words (where they want to be cared for and
// to die, what matters, who to call), the plan is reviewed by a set time, the last days of life
// are recognised and whānau told, comfort is checked, and after death whānau are followed up.
// Resuscitation and treatment-limitation decisions, anticipatory prescribing, national last-days
// guidance and the End of Life Choice Act 2019 are not held in SHIFT (RR-EOL-001).

export const PLACES: Record<string, string> = {
  HERE: 'Here, where they are now',
  HOME: 'At home',
  HOSPICE: 'In a hospice',
  HOSPITAL: 'In hospital',
  NOT_SAID: 'Not said yet',
};

export const STATES: Record<string, string> = {
  PALLIATIVE: 'Palliative care',
  LAST_DAYS: 'Likely in the last days of life',
  ENDED: 'Ended',
};

export const END: Record<string, string> = {
  DIED: 'Died',
  IMPROVED: 'No longer needs palliative care',
  LEFT: 'Left our care',
  ERROR: 'Recorded in error',
};

export const REVIEW_HOURS = [24, 72, 168, 336];

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-005', 'RR-EOL-001'];
