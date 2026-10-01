// Rehabilitation episode for a therapy discipline (entries 49, 50). The referral already covers
// referral → discipline decision → responsibility accepted; the episode carries on from there:
// readiness → baseline → goals, linked to the care plan → plan → sessions delivered or not →
// reassessment → equipment and support → who takes over, and their acceptance → closed.
// How often sessions happen is the therapist's plan; no national rule is encoded (ORG-SYN-001).

export const STATES: Record<string, string> = {
  STARTED: 'Readiness not checked yet',
  NOT_READY: 'Not ready yet',
  ACTIVE: 'In rehab',
  ENDING: 'Handing over: not accepted yet',
  CLOSED: 'Finished',
};

export const NOT_DELIVERED: Record<string, string> = {
  UNWELL: 'Too unwell',
  DECLINED: 'Said no',
  AWAY: 'Off the ward (test, procedure or visit)',
  NO_TIME: 'Physio could not get to them',
  OTHER: 'Other',
};

export const GOAL: Record<string, string> = { WORKING: 'Working on it', MET: 'Met', PARTLY: 'Partly met', NOT_MET: 'Not met', STOPPED: 'Stopped' };

export const NEXT: Record<string, string> = {
  COMMUNITY: 'Community physio',
  OUTPATIENTS: 'Outpatient physio',
  REST_HOME: 'Rest home staff',
  NONE: 'No further physio needed',
  OTHER: 'Other',
};

export const OUTCOME: Record<string, string> = {
  MET: 'Goals met',
  PARTLY: 'Goals partly met',
  NOT_MET: 'Goals not met',
  DECLINED: 'They chose to stop',
  DIED: 'Died',
  ERROR: 'Started in error',
};

export const REFS = ['ORG-SYN-001 v1'];
