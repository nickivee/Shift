// Residential care: a place offered and taken, the level of care a person has been assessed as
// needing, a change of level, and hospital stays while their room is held (entries 51, 52).
// A needs assessment service decides a person's level of care; the rest home records what it was
// told and where from. It does not decide the level. The contract's exact levels, who may assess,
// what funding covers, and how long a room is held while someone is in hospital are RR-ARC-001.
// interRAI assessments are RR-INSTR-001.

export const LEVELS: Record<string, string> = {
  REST_HOME: 'Rest home',
  HOSPITAL: 'Hospital level',
  DEMENTIA: 'Dementia care',
  PSYCHOGERIATRIC: 'Psychogeriatric care',
  NOT_KNOWN: 'Not known yet',
};

// The levels this rest home provides. Organisational configuration (synthetic, ORG-SYN-001).
export const PROVIDED = ['REST_HOME', 'HOSPITAL', 'DEMENTIA'];

export const KINDS: Record<string, string> = {
  LONG_TERM: 'Long-term',
  RESPITE: 'Respite (short stay)',
  OTHER: 'Other short stay',
};

export const SOURCES: Record<string, string> = {
  NASC: 'Needs assessment service',
  HOSPITAL: 'Hospital team',
  OTHER: 'Other',
};

export const STATES: Record<string, string> = {
  OFFERED: 'Place offered',
  ACCEPTED: 'Place accepted, not moved in yet',
  LIVING_HERE: 'Living here',
  IN_HOSPITAL: 'In hospital, room held',
  DECLINED: 'Place not taken',
  ENDED: 'Left our care',
};

export const END: Record<string, string> = {
  DIED: 'Died',
  MOVED: 'Moved to another rest home',
  HOME: 'Went home',
  LEVEL: 'Needs a level of care we do not provide',
  STAYED: 'Stayed in hospital or moved from there',
  RESPITE_DONE: 'Short stay finished',
  ERROR: 'Recorded in error',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-ARC-001'];
