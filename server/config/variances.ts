// Clinical exception and variance settings (Shared Lifecycle Object 295). The kinds of variance, the
// reasons, and the decisions are the synthetic organisation's own lists (ORG-SYN-001). Which variances
// in New Zealand must also be reported as incidents or to a regulator, and who may authorise an
// alternative to a charted or protocol action, is a research requirement (RR-VAR-001).

export const CATEGORIES: Record<string, string> = {
  MEDICATION: 'Medicine not given as charted', CARE: 'Care not done as planned', MONITORING: 'Observation or check not done',
  PATHWAY: 'Pathway or protocol step not followed', PROCEDURE: 'Test or procedure not done', OTHER: 'Something else',
};

export const REASONS: Record<string, string> = {
  DECLINED: 'The person declined', NOT_POSSIBLE: 'The person was not available (away, asleep, fasting)', CLINICAL: 'Clinical judgement',
  UNAVAILABLE: 'Staff, stock or equipment not available', ERROR: 'A mistake or omission', OTHER: 'Other',
};

export const DECISIONS: Record<string, string> = {
  ACCEPT: 'Accept: no change needed', ALTERNATIVE: 'Do something else instead', RESCHEDULE: 'Do it later', ESCALATE: 'Escalate for review',
};
