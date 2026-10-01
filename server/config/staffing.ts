// Safe staffing (entries 34–36): the staff each shift is planned to have, set against who is
// actually rostered and who has called in unable to work. A shift short of its plan shows as a
// gap until the rosterer fills it (calls someone in or advertises it as a vacancy) or records
// that it will run short, with the plan for the shift and who was told. The numbers below are
// the synthetic organisation's own staffing plan (ORG-SYN-001), not a national requirement:
// minimum staffing and registered nurse cover in aged residential care are RR-STAFF-001.
// Working out staffing from how much care residents need is blocked by RR-ACU-001.

export const PLAN: Record<string, Record<string, Record<string, number>>> = {
  'svc-arc': {
    AM: { 'arc-rn': 1, 'arc-caregiver': 3 },
    PM: { 'arc-rn': 1, 'arc-caregiver': 2 },
    NIGHT: { 'arc-rn': 1, 'arc-caregiver': 1 },
  },
};

// The roles counted for each service, in the words that department uses.
export const ROLE_WORDS: Record<string, [string, string]> = {
  'arc-rn': ['registered nurse', 'registered nurses'],
  'arc-caregiver': ['caregiver', 'caregivers'],
};

// Why someone can't work a rostered shift. The reason itself stays with them.
export const ABSENCE: Record<string, string> = {
  SICK: 'Sick',
  OTHER: 'Other unplanned absence',
};

// How many days ahead the rosterer sees.
export const DAYS_AHEAD = 7;

export const REFS = ['ORG-SYN-001 v1', 'RR-STAFF-001'];
