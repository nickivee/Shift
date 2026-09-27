// Clinical pathway settings (Shared Lifecycle Object 278). These pathways, their eligibility
// questions, steps and timings are the synthetic organisation's own (ORG-SYN-001). They are
// not clinically validated. Which national pathways and protocols apply in New Zealand (for
// example Health Quality & Safety Commission falls and sepsis guidance), their exact steps and
// time frames, and who owns them are research requirements (RR-PW-001); SHIFT tracks what was
// done against whichever pathway an organisation configures.

export interface PathwayStep { id: string; label: string; dueMins: number; optional?: boolean }
export interface Pathway {
  id: string; label: string; purpose: string;
  eligibility: string[];          // every answer must be yes to start without a deviation
  triggerKey?: string;            // an entry that suggests this pathway
  steps: PathwayStep[];
}

export const PATHWAYS: Pathway[] = [
  {
    id: 'POST_FALL', label: 'After a fall', purpose: 'Checks and follow-up after someone falls.', triggerKey: '.fall',
    eligibility: ['The person has had a fall (seen or found on the floor)'],
    steps: [
      { id: 'injury', label: 'Check for injury before moving them', dueMins: 0 },
      { id: 'obs', label: 'Observations after the fall', dueMins: 30 },
      { id: 'doctor', label: 'Tell the doctor, nurse practitioner or GP', dueMins: 60 },
      { id: 'whanau', label: 'Tell their whānau or next of kin', dueMins: 240, optional: true },
      { id: 'incident', label: 'Report the fall as an incident', dueMins: 24 * 60 },
      { id: 'risk', label: 'Review their falls risk and care plan', dueMins: 24 * 60 },
    ],
  },
  {
    id: 'SEPSIS', label: 'Possible sepsis', purpose: 'Fast assessment and treatment when infection may be making someone very unwell.',
    eligibility: ['An infection is suspected', 'They are unwell or getting worse'],
    steps: [
      { id: 'senior', label: 'Senior clinician review', dueMins: 30 },
      { id: 'bloods', label: 'Blood tests, including cultures', dueMins: 60 },
      { id: 'antibiotics', label: 'Antibiotics as prescribed', dueMins: 60 },
      { id: 'fluids', label: 'Fluids as prescribed', dueMins: 60, optional: true },
      { id: 'monitor', label: 'Closer observation plan in place', dueMins: 60 },
      { id: 'review', label: 'Review response to treatment', dueMins: 6 * 60 },
    ],
  },
  {
    id: 'DELIRIUM', label: 'New confusion', purpose: 'Looking for and treating the cause of new or worse confusion.',
    eligibility: ['Confusion is new or worse than usual', 'It came on over hours or days'],
    steps: [
      { id: 'screen', label: 'Confusion screen', dueMins: 2 * 60 },
      { id: 'whanau', label: 'Ask whānau what is usual for them', dueMins: 4 * 60 },
      { id: 'causes', label: 'Look for causes: infection, pain, constipation, fluids', dueMins: 8 * 60 },
      { id: 'meds', label: 'Medicines review', dueMins: 24 * 60 },
      { id: 'comfort', label: 'Comfort, orientation and sleep measures in the care plan', dueMins: 24 * 60 },
      { id: 'review', label: 'Review whether the confusion is settling', dueMins: 48 * 60 },
    ],
  },
];
export const PATHWAY_BY_ID = new Map(PATHWAYS.map((p) => [p.id, p]));

export const STEP_STATES: Record<string, string> = {
  PENDING: 'To do', DONE: 'Done', SKIPPED: 'Skipped', NOT_APPLICABLE: 'Not applicable', DEFERRED: 'Deferred',
};

export const EXIT_REASONS: Record<string, string> = {
  NO_LONGER_MEETS: 'No longer meets the pathway', OTHER_PATHWAY: 'Moved to another pathway or plan', TRANSFERRED: 'Transferred or discharged',
  DECLINED: 'The person declined', OTHER: 'Other',
};
