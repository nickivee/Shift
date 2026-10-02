// Short stay for observation in the Emergency Department (entries 40, 41). A doctor decides someone
// should stay for a while to be watched, says why and what to watch for, and when to look again. How
// long is too long, and what must happen at the end of a stay, are the service's own rules and are a
// research requirement (RR-OBSERVATION-001). SHIFT sets no time limit and never decides an outcome.

export const STATES: Record<string, string> = {
  OBSERVING: 'In observation',
  ENDED: 'Observation ended',
};

export const OUTCOME: Record<string, string> = {
  HOME: 'Going home',
  ADMIT: 'Needs admission',
  OTHER: 'Something else',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-OBSERVATION-001'];
