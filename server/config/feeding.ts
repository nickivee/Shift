// Tube feeding (nutrition support, entries 103, 188, 189, 191; Shared Lifecycle Object 244).
// The feed, rate, volumes and flushes are written as the dietitian or doctor prescribed them;
// SHIFT calculates no energy or fluid needs and sets no rates. The tube itself, and whether its
// position is confirmed before use, lives in Lines and tubes. National standards for tube
// position checks, refeeding risk and feed prescribing are RR-FEED-001.

export const STATES: Record<string, string> = {
  ACTIVE: 'Tube feeding',
  STOPPED: 'Stopped',
};

export const METHOD: Record<string, string> = {
  CONTINUOUS: 'Continuous by pump',
  OVERNIGHT: 'Overnight by pump',
  BOLUS: 'Bolus by syringe or gravity',
};

export const ORAL: Record<string, string> = {
  NIL: 'Nothing by mouth',
  TASTES: 'Tastes for pleasure only',
  ORAL: 'Eats and drinks as well',
};

export const GIVEN: Record<string, string> = {
  FEED: 'Feed',
  FLUSH: 'Water flush',
  WATER: 'Extra water',
  HELD: 'Held or stopped',
};

export const TOLERANCE: Record<string, string> = {
  FINE: 'No problems',
  NAUSEA: 'Nausea or vomiting',
  BLOATED: 'Bloated or uncomfortable',
  BOWELS: 'Diarrhoea',
  COUGH: 'Coughing or breathless during the feed',
  TUBE: 'Problem with the tube',
};

// Tolerance worth a nurse or doctor looking at before the next feed.
export const CONCERN = ['NAUSEA', 'COUGH', 'TUBE'];

export const REVIEW: Record<string, string> = {
  CONTINUE: 'Continue as it is',
  CHANGED: 'Change the feed',
  STOPPED: 'Stop tube feeding',
};

// Tubes that can be fed through (kinds from Lines and tubes).
export const TUBES = ['NGT', 'PEG', 'OTHER'];

// Where each department sees tube feeding, in screens it already uses.
export const PLACE: Record<string, string> = {
  'genmed-physician': 'review',
  'genmed-rn': 'diet',
  'arc-rn': 'diet',
  'arc-caregiver': 'diet',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-FEED-001'];
