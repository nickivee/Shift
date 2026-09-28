// Antimicrobial course settings (Shared Lifecycle Object 290). Intents, routes, review timing, change
// types and outcomes are the synthetic organisation's own lists (ORG-SYN-001). SHIFT does not
// prescribe or dispense: a course references the medication order it follows. Local antimicrobial
// guidelines, restricted-agent approval and who may authorise a change are research requirements
// (RR-AMS-001).

export const INTENTS: Record<string, string> = {
  EMPIRICAL: 'Best guess while waiting for results', TARGETED: 'Targeted to a known organism', PROPHYLAXIS: 'To prevent infection',
};

export const ROUTES: Record<string, string> = { IV: 'IV', ORAL: 'Oral', IM: 'Intramuscular', TOPICAL: 'Topical', OTHER: 'Other' };

export const MICRO: Record<string, string> = {
  PENDING: 'Waiting for results', COVERED: 'The organism is sensitive to this', NOT_COVERED: 'The organism is resistant to this', NO_GROWTH: 'No growth',
};

export const DECISIONS: Record<string, string> = {
  CONTINUE: 'Continue as it is', CHANGE: 'Change it', STOP: 'Stop it now',
};

export const CHANGES: Record<string, string> = {
  IV_TO_ORAL: 'IV to oral switch', DE_ESCALATE: 'Narrower (de-escalate)', ESCALATE: 'Broader (escalate)', SWITCH: 'Switch for another reason',
};

export const STOP_REASONS: Record<string, string> = {
  NOT_INFECTION: 'Not an infection after all', ADVERSE: 'Side effect or allergy', NO_LONGER_NEEDED: 'No longer needed', DECLINED: 'The person declined', OTHER: 'Other',
};

export const OUTCOMES: Record<string, string> = {
  CURED: 'Infection cured', IMPROVED: 'Improved', FAILED: 'Did not work', ADVERSE: 'Side effect or allergy', UNKNOWN: 'Not known',
};

// Review within this many days of starting unless the prescriber says otherwise (the 48–72 hour review).
export const REVIEW_DAYS = 2;
