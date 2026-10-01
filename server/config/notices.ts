// Equipment safety (entry 135): acceptance check before first use, and safety notices
// (manufacturer field safety notices, recalls, hazard alerts) that either stop use now or need
// an action by a date. What a notice requires is copied from the notice as issued; SHIFT adds
// nothing. The kinds and the acceptance step are the synthetic organisation's settings
// (ORG-SYN-001). Medsafe device recall and adverse-event reporting duties and the electrical
// safety testing standard are RR-EQUIP-001.

export const NOTICE_KINDS: Record<string, string> = {
  STOP: 'Stop using now',
  ACT: 'Keep using; action needed by a date',
};

export const NOTICE_STATES: Record<string, string> = {
  OPEN: 'Open',
  CLOSED: 'All done',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-EQUIP-001'];
