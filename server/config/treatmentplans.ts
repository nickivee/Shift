// Treatment plan settings (Shared Lifecycle Object 277). The synthetic organisation's own
// lists (ORG-SYN-001). Who may agree to a plan for a person who cannot agree themselves
// (RR-TP-001) and which clinicians may authorise a treatment plan in each setting (RR-TP-002)
// are research requirements. A medicine in a plan is the intention to use it; prescribing
// and giving it happen in the medicines record, not here.

export const COMPONENTS: Record<string, string> = {
  INTERVENTION: 'Intervention', MEDICINE: 'Medicine', TEST: 'Test or investigation', THERAPY: 'Therapy',
  REFERRAL: 'Referral', EDUCATION: 'Teaching or information', OTHER: 'Other',
};

export const COMPONENT_STATES: Record<string, string> = {
  PLANNED: 'Planned', UNDER_WAY: 'Under way', DONE: 'Done', STOPPED: 'Stopped',
};

export const AGREED_WITH: Record<string, string> = {
  PATIENT: 'The person themselves',
  WHANAU: 'The person, with their whānau',
  EPOA: 'Their EPOA or welfare guardian',
  UNABLE: 'The person cannot agree; decided in their best interests',
};

export const PROGRESS: Record<string, string> = {
  ON_TRACK: 'Going to plan', SLOWER: 'Slower than hoped', NOT_WORKING: 'Not working',
};

export const REVIEW: Record<string, string> = {
  CONTINUE: 'Continue as it is', MODIFY: 'Change the plan', COMPLETE: 'Goal met: complete it', STOP: 'Stop it',
};
