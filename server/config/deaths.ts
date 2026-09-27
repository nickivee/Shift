// Death event settings (Shared Lifecycle Object 270). These are the synthetic organisation's
// own choices (ORG-SYN-001). Who may verify a death, who may certify the cause, which deaths
// must be reported to the coroner and how organ and tissue donation is raised are research
// requirements (RR-DTH-001, RR-DTH-002): SHIFT records what was done and by whom, and never
// decides them.

export const EXPECTED: Record<string, string> = {
  EXPECTED: 'Expected', UNEXPECTED: 'Unexpected', UNSURE: 'Not sure',
};

export const CERT: Record<string, string> = {
  CERTIFICATE: 'Medical certificate of cause of death completed',
  CORONER: 'Reported to the coroner',
};

export interface Notice { id: string; label: string; required: boolean }
export const NOTIFY: Notice[] = [
  { id: 'WHANAU', label: 'Whānau or next of kin', required: true },
  { id: 'GP', label: 'Their GP', required: false },
  { id: 'CLINICIAN', label: 'Their named clinician or consultant', required: false },
  { id: 'CORONER', label: 'Coroner', required: false },
  { id: 'SERVICES', label: 'Other services involved in their care', required: false },
  { id: 'FUNERAL', label: 'Funeral director', required: false },
  { id: 'OTHER', label: 'Someone else', required: false },
];
export const NOTIFY_BY_ID = new Map(NOTIFY.map((n) => [n.id, n]));

export const DONATION: Record<string, string> = {
  NOT_APPLICABLE: 'Not applicable', DISCUSSED: 'Discussed with whānau, not going ahead', REFERRED: 'Referred for donation',
};

export const RELEASE: Record<string, string> = {
  FUNERAL_DIRECTOR: 'Funeral director', MORTUARY: 'Hospital mortuary', CORONER: 'For the coroner', WHANAU: 'Whānau',
};
