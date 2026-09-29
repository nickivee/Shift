// Work queue settings (Cross-System Capability 317, Work Queue Engine):
//   requirement → responsible recipient → due threshold → escalation condition → next authorised
//   recipient → acknowledgement → action → resolution.
// Who work goes to next when it is missed, and how long SHIFT waits, are the synthetic
// organisation's own operational rules (ORG-SYN-001). They are not clinical thresholds. What each
// New Zealand setting requires for escalating missed work is a research requirement (RR-QUEUE-001).

// Each service's ladder, lowest first. Work that is missed goes one step up. There is no step
// above the top of the ladder: work missed there shows as overdue to that role.
export const LADDERS: Record<string, string[]> = {
  'svc-arc': ['arc-caregiver', 'arc-rn'],
  'svc-genmed': ['genmed-rn', 'genmed-physician'],
  'svc-ed': ['ed-rn', 'ed-doctor'],
};

// Minutes past the due time before work that no one has accepted goes up the ladder.
export const NOT_ACCEPTED_MINUTES = 30;
// Minutes past the due time before accepted work that is not done goes up the ladder.
export const NOT_DONE_MINUTES = 60;
// Minutes an escalation can wait without being acknowledged before it goes up again.
export const NOT_ACKNOWLEDGED_MINUTES = 30;

export const REASONS: Record<string, string> = {
  NOT_ACCEPTED: 'No one accepted it',
  NOT_DONE: 'Accepted but not done',
  NOT_ACKNOWLEDGED: 'The escalation was not acknowledged',
};

// How much later a due time can be moved when someone decides the work can wait.
export const EXTEND_MINUTES = [30, 60, 120, 240];
