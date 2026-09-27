// Recommendation settings (the recommendation lifecycle listed under Shared Lifecycle Object
// 278). How a recommendation was communicated, and why one might not be implemented, are the
// synthetic organisation's own lists (ORG-SYN-001). Whether a recommendation from one
// profession binds another, and what must be documented when one is declined, are research
// requirements (RR-REC-001). Recommendations go only to services in the same organisation;
// sending one elsewhere is a disclosure (RR-DISC-001) and is not offered.

export const CHANNELS: Record<string, string> = {
  SHIFT: 'Sent in SHIFT', VERBAL: 'Told them in person', PHONE: 'By phone', MEETING: 'At a team meeting',
};

export const NOT_DONE: Record<string, string> = {
  DECLINED_BY_PERSON: 'The person declined', NOT_SAFE: 'Not safe to do now', NO_RESOURCE: 'Equipment or staff not available',
  CONDITION_CHANGED: 'Their condition changed', OTHER: 'Other',
};
