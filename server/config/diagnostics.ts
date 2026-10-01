// Laboratory tests: order → sample taken and labelled at the bedside → sent → result (electronic,
// or phoned through by the laboratory and read back) → reviewed; a critical result must reach a
// doctor and be acknowledged with a plan; a corrected result keeps the original.
// Which results are critical is the laboratory's call (its flag, or what it phones through); SHIFT
// sets no thresholds. How quickly a sample is taken is an organisational setting (ORG-SYN-001);
// national requirements for communicating critical results are RR-RESULT-001.

export interface TestDef { label: string; sample: string }

export const TESTS: Record<string, TestDef> = {
  FBC: { label: 'Full blood count', sample: 'Blood' },
  ELECTROLYTES: { label: 'Electrolytes and kidney function', sample: 'Blood' },
  LFT: { label: 'Liver function', sample: 'Blood' },
  CRP: { label: 'CRP', sample: 'Blood' },
  TROPONIN: { label: 'Troponin', sample: 'Blood' },
  LACTATE: { label: 'Lactate', sample: 'Blood' },
  COAGS: { label: 'Clotting (INR)', sample: 'Blood' },
  CULTURE: { label: 'Blood cultures', sample: 'Blood' },
  GLUCOSE: { label: 'Glucose (lab)', sample: 'Blood' },
  URINE: { label: 'Urine microscopy and culture', sample: 'Urine' },
};

export const PRIORITY: Record<string, { label: string; takeWithinMins: number }> = {
  URGENT: { label: 'Urgent', takeWithinMins: 60 },
  ROUTINE: { label: 'Routine', takeWithinMins: 12 * 60 },
};

export const ORDER_STATES: Record<string, string> = {
  ORDERED: 'Sample not taken yet',
  COLLECTED: 'Sample taken, not sent',
  SENT: 'With the lab',
  RESULTED: 'Result back',
  CANCELLED: 'Cancelled',
};

export const LAB = 'Te Awa Laboratory';

export const REFS = ['ORG-SYN-001 v1', 'RR-RESULT-001'];
