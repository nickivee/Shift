// Major trauma (entry 118). The kinds of trauma call are this hospital's own settings
// (ORG-SYN-001). Activation criteria, survey standards, injury severity scoring and trauma
// network rules are national, so they are RR-TRAUMA-001 and SHIFT applies none of them.

export const STATES: Record<string, string> = {
  ACTIVE: 'In ED',
  ADMITTED: 'Admitted: tertiary survey due',
  COMPLETE: 'Complete',
};

export const TEAM_CALL: Record<string, string> = {
  FULL: 'Full trauma call',
  ALERT: 'Trauma alert (smaller team)',
};

export const PRIMARY: Record<string, string> = {
  airway: 'Airway and neck',
  breathing: 'Breathing',
  circulation: 'Circulation and bleeding',
  disability: 'Disability (conscious level, pupils, glucose)',
  exposure: 'Exposure (whole body, temperature)',
};

export const FOUND_BY: Record<string, string> = {
  PRIMARY: 'Primary survey',
  SECONDARY: 'Secondary survey',
  IMAGING: 'Imaging',
  TERTIARY: 'Tertiary survey',
};

export const NEXT: Record<string, string> = {
  ADMITTED: 'Admitted to a ward',
  TRANSFERRED: 'Transferred to another hospital',
  HOME: 'Home',
};

// Where each department sees trauma, in screens it already uses.
export const PLACE: Record<string, string> = {
  'ed-doctor': 'medical',
  'ed-rn': 'triage',
  'genmed-physician': 'review',
  'genmed-rn': 'careplan',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-TRAUMA-001'];
