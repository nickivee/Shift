// Consumer requests about their own health information (entries 29, 30, 31). SHIFT sets no time
// limit, grounds or fee; those wait for RR-PRIVACY-001. It records what was asked, how the person
// was checked, what was decided and why, and what was sent.
export const STATES: Record<string, string> = { RECEIVED: 'To check', CHECKED: 'To decide', DECIDED: 'To send', CLOSED: 'Closed', WITHDRAWN: 'Withdrawn' };
export const KIND: Record<string, string> = {
  ACCESS: 'Wants to see their information',
  CORRECTION: 'Wants something corrected',
  SHARED: 'Wants to know who it was shared with',
  OTHER_ORG: 'Another organisation is asking for it',
};
export const WHO: Record<string, string> = { SELF: 'The person themselves', REPRESENTATIVE: 'Someone acting for them', ORGANISATION: 'An organisation' };
export const DECISION: Record<string, string> = {
  GRANTED: 'Giving it', PARTLY: 'Giving part of it', REFUSED: 'Not giving it',
  CORRECTED: 'Corrected', NOT_CORRECTED: 'Not corrected',
};
export const DECISIONS_FOR: Record<string, string[]> = {
  ACCESS: ['GRANTED', 'PARTLY', 'REFUSED'], SHARED: ['GRANTED', 'PARTLY', 'REFUSED'], OTHER_ORG: ['GRANTED', 'PARTLY', 'REFUSED'],
  CORRECTION: ['CORRECTED', 'NOT_CORRECTED'],
};
export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-001', 'RR-PRIVACY-001'];
