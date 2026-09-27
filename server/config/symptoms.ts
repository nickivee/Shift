// Symptom settings (Shared Lifecycle Object 274). The synthetic organisation's own list of
// common symptoms, patterns and outcomes (ORG-SYN-001). Severity is the person's own 0 to 10
// rating, or the rater's estimate when they cannot give one. How soon to look again after an
// intervention is this organisation's default and can be changed each time.

export const KINDS: Record<string, string> = {
  PAIN: 'Pain', BREATHLESSNESS: 'Breathlessness', NAUSEA: 'Nausea or vomiting', FATIGUE: 'Tiredness', DIZZINESS: 'Dizziness',
  ITCH: 'Itch', AGITATION: 'Restlessness or agitation', OTHER: 'Something else',
};

export const PATTERNS: Record<string, string> = {
  CONSTANT: 'All the time', COMES_AND_GOES: 'Comes and goes', ON_MOVEMENT: 'When moving', AT_NIGHT: 'Worse at night', AFTER_FOOD: 'After eating',
};

export const WHO_RATED: Record<string, string> = { SELF: 'Their own rating', OBSERVED: 'Staff estimate (they could not rate it)' };

export const OUTCOMES: Record<string, string> = {
  RESOLVED: 'Gone', CONTROLLED: 'Controlled with the current plan', PROBLEM: 'Now followed as a clinical problem', OTHER: 'Other',
};

export const REASSESS_MINS = 60;
export const SEVERE = 7;
