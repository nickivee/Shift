// Clinical decisions made with the person (Shared Lifecycle Object 238). Which decisions must be
// written down this way, and who may decide for someone who cannot take part, are not set in SHIFT:
// national requirements are RR-DECISION-001, and substitute decisions are RR-CAP-001.

export const STATES: Record<string, string> = {
  OPEN: 'Being talked through',
  DECIDED: 'Decided',
  CLOSED: 'Closed',
};

export const TOOK_PART: Record<string, string> = {
  YES: 'Yes, they took part',
  PARTLY: 'Partly (for example drowsy, or needed whānau to help)',
  NO: 'No, they could not take part',
};

export const AGREED: Record<string, string> = {
  AGREED: 'They agree',
  NOT_AGREED: 'They do not agree',
  COULD_NOT_SAY: 'They could not say',
};

// Where each department sees decisions, in screens it already uses.
export const PLACE: Record<string, string> = {
  'genmed-physician': 'review',
  'ed-doctor': 'medical',
  'genmed-rn': 'careplan',
  'ed-rn': 'overview',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-DECISION-001'];
