// Follow-up settings (Shared Lifecycle Object 284). How a follow-up is arranged and the outcomes
// are the synthetic organisation's own lists (ORG-SYN-001). Who stays accountable for a
// follow-up handed to a GP or another provider, and what must be sent to them, are research
// requirements (RR-FU-001). SHIFT sends nothing outside the organisation (RR-DISC-001); it records
// who took responsibility and how they were told.

export const LINKS: Record<string, string> = {
  REFERRAL: 'Referral sent', APPOINTMENT: 'Appointment requested', TASK: 'Task for the team', LETTER: 'In the discharge letter', OTHER: 'Other',
};

export const TOLD: Record<string, string> = {
  LETTER: 'Discharge letter', PHONE: 'Phone call', EREFERRAL: 'Electronic referral', IN_PERSON: 'In person', OTHER: 'Other',
};

export const OUTCOMES: Record<string, string> = {
  RESOLVED: 'Nothing more needed', ONGOING: 'Being managed by the provider', FURTHER: 'Further follow-up needed', NOT_DONE: 'Did not happen',
};
