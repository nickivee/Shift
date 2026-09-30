// Isolation / transmission precautions (Shared Lifecycle Object 235) and infection prevention and
// control (Build 99). The precaution types are the usual transmission-based precautions; which one
// an organism needs, for how long and how it is cleared is the organisation's infection prevention
// policy, which SHIFT does not hold. A clinician chooses; SHIFT never suggests or stops one itself
// (RR-IPC-001).

export const TYPES: Record<string, string> = {
  CONTACT: 'Contact',
  DROPLET: 'Droplet',
  AIRBORNE: 'Airborne',
};

export const ROOMS: Record<string, string> = {
  SINGLE: 'Single room',
  SINGLE_TOILET: 'Single room with its own toilet',
  NEGATIVE_PRESSURE: 'Negative pressure room',
  COHORT: 'Shared bay with people who have the same infection',
  OWN_ROOM: 'Stays in their own room',
  NONE: 'No room change needed',
};

export const STATES: Record<string, string> = {
  REQUIRED: 'Needed, not yet in place',
  IN_PLACE: 'In place',
  CEASED: 'Stopped',
};

export const CEASE: Record<string, string> = {
  CLEARED: 'Cleared under the infection prevention policy',
  NOT_INFECTIOUS: 'Infection ruled out',
  LEFT: 'Left the service',
  ERROR: 'Started in error',
};

export const REVIEW_HOURS = [24, 48, 72, 168];

export const OUTBREAK_STATES: Record<string, string> = { DECLARED: 'Outbreak now', CLOSED: 'Closed' };

export const PERSON_STATES: Record<string, string> = {
  CASE: 'Case', RECOVERED: 'Recovered',
  WATCHING: 'Contact: watching', CLEARED: 'Contact: no illness', BECAME_CASE: 'Contact: became a case',
};

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-IPC-001', 'RR-INF-001'];
