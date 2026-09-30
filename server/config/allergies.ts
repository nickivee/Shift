// Allergy / intolerance / adverse reaction (Shared Lifecycle Object 233). A reaction is recorded
// where it is reported or seen, assessed as suspected or confirmed, and ended only by a person with
// a reason: checked and not an allergy, no longer applies, or recorded in error. Which reactions
// count as allergy or intolerance, who may rule one out, and when a reaction must be reported to the
// Centre for Adverse Reactions Monitoring are not held in SHIFT (RR-ALLERGY-001).

export const KINDS: Record<string, string> = {
  ALLERGY: 'Allergy',
  INTOLERANCE: 'Intolerance or side effect',
};

export const CATEGORIES: Record<string, string> = {
  MEDICINE: 'Medicine',
  FOOD: 'Food',
  ENVIRONMENT: 'Something they touched or breathed in (latex, plasters, pollen)',
  OTHER: 'Other',
};

export const SEVERITY: Record<string, string> = {
  MILD: 'Mild',
  MODERATE: 'Moderate',
  SEVERE: 'Severe',
};

export const CERTAINTY: Record<string, string> = {
  SUSPECTED: 'Suspected, not yet checked',
  CONFIRMED: 'Confirmed',
  REFUTED: 'Checked: not an allergy',
};

export const SOURCES: Record<string, string> = {
  PERSON: 'Told by the person',
  WHANAU: 'Told by whānau or carer',
  SEEN: 'Reaction seen here',
  RECORDS: 'From their records',
};

// How "no known allergies" was established.
export const ASKED: Record<string, string> = {
  PERSON: 'Asked the person',
  WHANAU: 'Asked whānau or carer',
  RECORDS: 'Checked their records',
};

export const END: Record<string, string> = {
  REFUTED: 'Checked: not an allergy',
  RESOLVED: 'No longer applies',
  ERROR: 'Recorded in error',
};

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-ALLERGY-001'];
