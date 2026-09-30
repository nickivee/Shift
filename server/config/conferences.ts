// Multidisciplinary team meetings and case conferences (Shared Lifecycle Object 239).
// SHIFT keeps the meeting's own steps: who was asked and who came, what was looked at, what was
// discussed and decided, and who does what by when. When a meeting must be held, and who must be
// there, are organisational settings (ORG-SYN-001); SHIFT adds no national rule of its own.

export const KINDS: Record<string, string> = {
  MDT: 'MDT meeting',
  FAMILY: 'Family/whānau meeting',
  CARE_REVIEW: 'Care plan review',
};

export const STATES: Record<string, string> = {
  PLANNED: 'Planned',
  HELD: 'Held: actions open',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

// Roles that take part in meetings; the rostering, coding and flow desks do not.
export const TAKES_PART = ['arc-rn', 'arc-caregiver', 'genmed-rn', 'genmed-physician', 'physio'];

export const REFS = ['ORG-SYN-001 v1'];
