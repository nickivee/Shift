// Poisoning and overdose in ED (entry 117). What to watch for, which tests and antidotes are needed
// and when someone is safe to go home come from the National Poisons Centre, a toxicologist or the
// treating doctor, and are recorded as they were given. SHIFT holds no toxic doses or thresholds of
// its own. National requirements, including assessment after deliberate self-harm, are RR-POISON-001.

export const STATES: Record<string, string> = {
  ASSESSING: 'Being assessed',
  MONITORING: 'Being watched',
  CLEARED: 'Medically cleared',
  ADMITTED: 'Admitted',
};

export const ROUTE: Record<string, string> = {
  ORAL: 'Swallowed',
  INHALED: 'Breathed in',
  SKIN: 'On the skin',
  EYE: 'In the eye',
  INJECTED: 'Injected',
  BITE: 'Bite or sting',
  UNKNOWN: 'Not known',
};

export const TIME_KNOWN: Record<string, string> = {
  KNOWN: 'Time known',
  ESTIMATED: 'Time estimated',
  UNKNOWN: 'Time not known',
};

export const INTENT: Record<string, string> = {
  ACCIDENTAL: 'Accidental',
  DELIBERATE: 'Deliberate self-harm',
  RECREATIONAL: 'Recreational',
  WORK: 'At work',
  UNKNOWN: 'Not known',
};

export const ADVICE_FROM: Record<string, string> = {
  POISONS_CENTRE: 'National Poisons Centre',
  TOXICOLOGIST: 'Toxicologist',
  OTHER: 'Other',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-POISON-001'];
