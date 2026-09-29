// Downtime continuity. What can be unavailable, and the organisation's approved paper process for
// each while it is. These processes are the synthetic organisation's own configuration, not a
// national standard; what New Zealand requires is still being researched (RR-DOWNTIME-001).

export const FUNCTIONS: Record<string, { label: string; process: string }> = {
  ALL: {
    label: 'All of SHIFT',
    process: 'Use the paper downtime pack kept at the nurses\' station: observation charts, the medicine chart and progress note sheets. Write the person\'s name and NHI, the time, and your name on every sheet. Keep the sheets with the person until they are entered.',
  },
  MEDICINES: {
    label: 'Medicines and administration',
    process: 'Use the paper medicine chart from the downtime pack. Check each dose against the last medicine list you have. Phone pharmacy about anything new.',
  },
  RESULTS: {
    label: 'Laboratory and radiology results',
    process: 'Phone the laboratory or radiology for urgent results. Write each result on the paper results sheet with who gave it, who took it and the time, and read it back.',
  },
  OBSERVATIONS: {
    label: 'Observations and monitoring',
    process: 'Use paper observation charts from the downtime pack, and call for review by the usual escalation criteria.',
  },
  TASKS: {
    label: 'Tasks and handover',
    process: 'Use the paper handover sheet and hand over face to face.',
  },
};

export const STATES: Record<string, string> = {
  DECLARED: 'Down now', RESTORED: 'Back up: entering paper records', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};

export const CHECK_OUTCOMES: Record<string, string> = {
  ENTERED: 'Paper records entered',
  NOTHING: 'Nothing on paper for them',
};

// How far back a downtime can be said to have started when it is declared late.
export const STARTED_AGO_MINUTES = [0, 15, 30, 60, 120, 240];
export const REFS = ['ORG-SYN-001 v1', 'RR-DOWNTIME-001'];
