// The coroner's side of a death (entry 153). When a death is reported to the coroner, SHIFT
// holds the record for them: nothing is removed, and anything added or changed afterwards is
// counted and shown with its earlier version kept. Requests for information from the coroner
// are received → decided by an authorised clinician (in full, in part, or waiting on advice) →
// sent, with what was sent and how. The coroner's findings and any recommendations are
// recorded with the service's response, and the case is closed. Which deaths must be reported,
// what the coroner may require, what must be released and who may decide, and what a service
// must do with recommendations are RR-CORONER-001. SHIFT records each decision and never
// makes one.

export const DECISION: Record<string, string> = {
  RELEASE: 'Release in full',
  PART: 'Release part; some withheld',
  ADVICE: 'Wait for legal or privacy advice',
};

export const SENT_HOW: Record<string, string> = {
  SECURE_EMAIL: 'Secure email',
  PORTAL: 'Coronial services portal',
  COURIER: 'Courier or by hand',
  OTHER: 'Another way',
};

export const STATES: Record<string, string> = {
  HELD: 'Held for the coroner',
  FINDINGS: 'Findings received',
  CLOSED: 'Closed',
};

export const REQUEST_STATES: Record<string, string> = {
  RECEIVED: 'Waiting for a decision',
  ADVICE: 'Waiting on advice',
  DECIDED: 'Decided, to send',
  SENT: 'Sent',
};

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-CORONER-001'];
