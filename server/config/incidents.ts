// Incident settings (Shared Lifecycle Object 269). These are the synthetic organisation's own
// categories and harm levels (ORG-SYN-001). The national severity rating (the Health Quality &
// Safety Commission's SAC rating and "always report and review" list) and which bodies must be
// told about which events are research requirements (RR-INC-001): SHIFT records the reviewer's
// decision and never decides it.

export const CATEGORIES: Record<string, string> = {
  FALL: 'Fall', MEDICATION: 'Medicine', PRESSURE_INJURY: 'Pressure injury', BEHAVIOUR: 'Aggression or behaviour', EQUIPMENT: 'Equipment',
  DELAY: 'Delay in care or treatment', IDENTIFICATION: 'Wrong person or wrong record', OTHER: 'Other',
};

export interface Harm { id: string; label: string; rank: number; tone: string }
export const HARMS: Harm[] = [
  { id: 'NEAR_MISS', label: 'Near miss: did not reach them', rank: 0, tone: 'muted' },
  { id: 'NONE', label: 'Reached them, no harm', rank: 1, tone: 'muted' },
  { id: 'MINOR', label: 'Minor harm', rank: 2, tone: 'warn' },
  { id: 'MODERATE', label: 'Moderate harm', rank: 3, tone: 'warn' },
  { id: 'MAJOR', label: 'Major harm', rank: 4, tone: 'danger' },
  { id: 'SEVERE', label: 'Severe harm or death', rank: 5, tone: 'danger' },
];
export const HARM_BY_ID = new Map(HARMS.map((h) => [h.id, h]));

export const NOTIFY: Record<string, string> = {
  REQUIRED: 'Notification required', NOT_REQUIRED: 'Not required', UNSURE: 'Not sure: asked for advice',
};
export const DISCLOSURE: Record<string, string> = {
  DONE: 'Talked with them or their whānau', PLANNED: 'Planned', NOT_POSSIBLE: 'Not possible yet', NOT_NEEDED: 'Not needed (near miss)',
};
