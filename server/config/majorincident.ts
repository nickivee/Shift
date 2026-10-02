// Major incident in the Emergency Department (entry 151): a mass casualty event declared on
// standby or active → casualties registered fast with an incident number, each given a priority
// and re-triaged as they change → stood down → closed with a debrief. The priority words are the
// synthetic organisation's own (ORG-SYN-001). Who may declare a major incident, the national and
// regional health emergency plans it sits under, and the triage method to use are RR-MCI-001.

export const SERVICES = ['svc-ed'];

export const LEVELS: Record<string, string> = {
  STANDBY: 'Standby: casualties may come',
  ACTIVE: 'Active: casualties coming',
};

export const STATES: Record<string, string> = {
  STANDBY: 'Standby',
  ACTIVE: 'Active',
  STOOD_DOWN: 'Stood down, debrief to do',
  CLOSED: 'Closed',
};

export const PRIORITY: Record<string, string> = {
  IMMEDIATE: 'Immediate (P1)',
  URGENT: 'Urgent (P2)',
  DELAYED: 'Delayed (P3)',
  DEAD: 'Dead',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-MCI-001'];
