// Requirement settings (the requirement lifecycle listed under Shared Lifecycle Object 278).
// Priorities, reasons for deferring and outcomes are the synthetic organisation's own lists
// (ORG-SYN-001). Who is accountable for a requirement that is deferred or never done, and how
// long a deferral may run, are research requirements (RR-REQ-001).

export const SOURCES: Record<string, string> = {
  RECOMMENDATION: 'An accepted recommendation', MANUAL: 'Added by the team',
};

export const PRIORITIES: Record<string, string> = { URGENT: 'Urgent', TODAY: 'Today', ROUTINE: 'Routine' };

export const DEFER_REASONS: Record<string, string> = {
  PERSON_NOT_READY: 'The person is away or not ready', WAITING: 'Waiting on something else', NOT_SAFE: 'Not safe to do now',
  NO_RESOURCE: 'Equipment or staff not available', OTHER: 'Other',
};

export const OUTCOMES: Record<string, string> = {
  MET: 'Done, need met', PARTLY_MET: 'Partly met', NOT_MET: 'Not met', NO_LONGER_NEEDED: 'No longer needed',
};
