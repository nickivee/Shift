// Care due settings (the due-date lifecycle listed under Shared Lifecycle Object 278). The
// kinds of care, their usual intervals, and when an item counts as upcoming, due or overdue are
// the synthetic organisation's own settings (ORG-SYN-001). How late care may be before it must
// be escalated or reported is a research requirement (RR-DUE-001); SHIFT shows the lateness
// and leaves escalation to people.

export interface DueKind { id: string; label: string; every: number | null }

// Usual interval in hours; null means once.
export const KINDS: DueKind[] = [
  { id: 'REPOSITION', label: 'Change position (pressure care)', every: 2 },
  { id: 'CANNULA', label: 'Check the IV cannula site', every: 8 },
  { id: 'DRESSING', label: 'Change the dressing', every: 72 },
  { id: 'CATHETER_BAG', label: 'Change the catheter bag', every: 168 },
  { id: 'WEIGHT', label: 'Weigh', every: 24 },
  { id: 'BLOODS', label: 'Take bloods', every: null },
  { id: 'OTHER', label: 'Other', every: null },
];
export const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

export const INTERVALS: Record<string, string> = {
  '0': 'Once', '1': 'Every hour', '2': 'Every 2 hours', '4': 'Every 4 hours', '6': 'Every 6 hours', '8': 'Every 8 hours',
  '12': 'Every 12 hours', '24': 'Every day', '48': 'Every 2 days', '72': 'Every 3 days', '168': 'Every week',
};

export const RESCHEDULE_REASONS: Record<string, string> = {
  PERSON_AWAY: 'The person is away from the ward or asleep', PERSON_DECLINED: 'The person asked to wait', CLINICAL: 'Clinical reason',
  WORKLOAD: 'Staff not available', OTHER: 'Other',
};

const MIN = 60_000;
// Upcoming: from a quarter of the interval before it is due (at least 30 minutes, at most a day).
export const upcomingLead = (everyHours: number | null) => (everyHours ? Math.min(Math.max(everyHours * 15, 30), 24 * 60) : 60) * MIN;
// Due: until a quarter of the interval after it was due (at least 15 minutes, at most 4 hours); then overdue.
export const grace = (everyHours: number | null) => (everyHours ? Math.min(Math.max(everyHours * 15, 15), 4 * 60) : 60) * MIN;
