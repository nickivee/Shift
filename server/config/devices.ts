// Lines, tubes and catheters attached to a person (entries 186, 187; Shared Lifecycle Object 214):
//   inserted → position confirmed where the kind needs it, before it is used → site checked and
//   still-needed reviewed → problem found → removed (and whether it came out whole).
// The kinds, which need their position confirmed before use, and how often each is usually
// checked are the synthetic organisation's own settings (ORG-SYN-001). National requirements
// for insertion, position confirmation, dwell time and removal are RR-DEVICE-001.

export interface DeviceKind { label: string; short: string; checkHours: number; position: boolean; line: boolean }

export const KINDS: Record<string, DeviceKind> = {
  PIVC: { label: 'Peripheral IV cannula', short: 'IV cannula', checkHours: 8, position: false, line: true },
  MIDLINE: { label: 'Midline', short: 'Midline', checkHours: 12, position: false, line: true },
  PICC: { label: 'PICC line', short: 'PICC', checkHours: 12, position: true, line: true },
  CVC: { label: 'Central line', short: 'Central line', checkHours: 8, position: true, line: true },
  SUBCUT: { label: 'Subcutaneous line (butterfly)', short: 'Subcut line', checkHours: 8, position: false, line: true },
  IDC: { label: 'Urinary catheter', short: 'Urinary catheter', checkHours: 24, position: false, line: false },
  SPC: { label: 'Suprapubic catheter', short: 'Suprapubic catheter', checkHours: 24, position: false, line: false },
  NGT: { label: 'Nasogastric tube', short: 'NG tube', checkHours: 8, position: true, line: false },
  PEG: { label: 'Feeding tube into the stomach (PEG)', short: 'PEG', checkHours: 24, position: false, line: false },
  DRAIN: { label: 'Wound drain', short: 'Drain', checkHours: 8, position: false, line: false },
  OTHER: { label: 'Other line or tube', short: 'Other', checkHours: 12, position: false, line: false },
};

export const SITE: Record<string, string> = {
  OK: 'Looks fine',
  RED: 'Red or warm',
  SWOLLEN: 'Swollen',
  PAIN: 'Sore or painful',
  LEAKING: 'Leaking or oozing',
  BLOCKED: 'Blocked or not draining',
  MOVED: 'Moved or partly out',
};

export const CONFIRM: Record<string, string> = {
  XRAY: 'X-ray reviewed',
  PH: 'pH test of aspirate',
  OTHER: 'Other, as written',
};

export const REMOVED: Record<string, string> = {
  NOT_NEEDED: 'No longer needed',
  PROBLEM: 'Problem at the site or with the device',
  CAME_OUT: 'Came out or pulled out',
  REPLACED: 'Replaced with a new one',
  LEFT: 'Left our care with it in',
  ERROR: 'Recorded in error',
};

export const STATES: Record<string, string> = {
  NEEDS_CHECK: 'Position not confirmed: do not use',
  IN_PLACE: 'In place',
  REMOVED: 'Removed',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-DEVICE-001'];
