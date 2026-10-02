// Immediate danger check at the front door of the Emergency Department (entries 40, 41): before
// anything else, someone asks whether anyone is in immediate danger. SHIFT records the answer, what
// was done straight away and who was told; it decides nothing. The national and local expectations
// for safety at the front door are RR-DANGER-001.

export const STATES: Record<string, string> = {
  CLEAR: 'No one in danger',
  DANGER: 'Danger, not yet made safe',
  MADE_SAFE: 'Made safe',
};

export const KIND: Record<string, string> = {
  TO_PATIENT: 'The patient is in danger',
  FROM_PATIENT: 'The patient is a danger to others',
  FROM_OTHERS: 'Someone with them is a danger',
  SCENE: 'Weapon or hazardous substance',
  OTHER: 'Something else',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-DANGER-001'];
