// Named clinician / team assignment kinds (Shared Lifecycle Object 265). Which named people or
// teams a person should have, who can be named, and in which settings a name is required. These
// are the synthetic organisation's own rules (ORG-SYN-001), not law.

export interface AssignmentKind {
  id: string;
  label: string;
  short: string;                 // for the record header
  roles: string[];               // workstation roles a SHIFT worker must hold to be named
  named: 'WORKER' | 'EXTERNAL' | 'TEAM';
  requiredFor: string[];         // encounter kinds where one must be named
}

export const ASSIGNMENT_KINDS: AssignmentKind[] = [
  { id: 'RESPONSIBLE_DOCTOR', label: 'Responsible senior doctor', short: 'Senior doctor', roles: ['genmed-physician', 'ed-doctor'], named: 'WORKER', requiredFor: ['INPATIENT', 'EMERGENCY'] },
  { id: 'NAMED_NURSE', label: 'Named nurse', short: 'Nurse', roles: ['genmed-rn', 'arc-rn', 'ed-rn'], named: 'WORKER', requiredFor: ['INPATIENT', 'RESIDENTIAL'] },
  { id: 'KEY_WORKER', label: 'Key worker (caregiver)', short: 'Key worker', roles: ['arc-caregiver'], named: 'WORKER', requiredFor: [] },
  { id: 'PHYSIO', label: 'Named physiotherapist', short: 'Physio', roles: ['physio'], named: 'WORKER', requiredFor: [] },
  { id: 'GP', label: 'General practitioner', short: 'GP', roles: [], named: 'EXTERNAL', requiredFor: ['RESIDENTIAL'] },
  { id: 'TEAM', label: 'Responsible team', short: 'Team', roles: [], named: 'TEAM', requiredFor: [] },
];

export const KIND_BY_ID = new Map(ASSIGNMENT_KINDS.map((k) => [k.id, k]));
