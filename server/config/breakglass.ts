// Break-glass settings (Cross-System Capability 307). The pathways, time limits and review
// outcomes are the synthetic organisation's own rules (ORG-SYN-001). The New Zealand rules for
// emergency access to health information, and what a review must cover, are a research
// requirement (RR-BREAKGLASS-001).

// Why the clinician needs the record, and how long access stays open once it opens.
export const KINDS: Record<string, { label: string; minutes: number }> = {
  EMERGENCY: { label: 'Emergency: life or serious harm at risk now', minutes: 60 },
  PRESENT: { label: 'The person is here and needs care from me now', minutes: 120 },
  APPROVAL: { label: 'Other clinical need: a senior approves first', minutes: 60 },
};

// For a person who is present: did they agree to their record being looked at.
export const CONSENT: Record<string, string> = {
  AGREED: 'The person agreed',
  CANNOT: 'The person cannot say (unconscious, confused or too unwell)',
  DECLINED: 'The person said no',
};

export const OUTCOMES: Record<string, string> = {
  APPROPRIATE: 'Appropriate use',
  FOLLOW_UP: 'Appropriate, with follow-up needed',
  INAPPROPRIATE: 'Not appropriate',
};
