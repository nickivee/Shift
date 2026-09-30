// Informed consent and refusal (workstation entry 20). A person is told what is proposed, why, the
// risks, benefits and other options including doing nothing, and then says yes or no to that one
// decision. They can withdraw at any time. Capacity is presumed (Code of Rights Right 7(2)); when a
// named capacity assessment for the decision says otherwise, SHIFT records no consent. Who may take
// consent for what, when it must be written, and who may decide for a person who cannot are not
// held in SHIFT (RR-CONSENT-001, RR-CAP-001, RR-TP-001). Advance directives are RR-ADVDIR-001.

export const KINDS: Record<string, string> = {
  PROCEDURE: 'Procedure or operation',
  TEST: 'Test or investigation',
  TREATMENT: 'Treatment or medicine',
  VACCINE: 'Vaccination',
  CARE: 'Personal care',
  PHOTO: 'Photographs or recordings',
  OTHER: 'Other',
};

export const DECISIONS: Record<string, string> = {
  CONSENTED: 'Agreed',
  REFUSED: 'Said no',
};

export const FORMS: Record<string, string> = {
  VERBAL: 'Said it out loud',
  WRITTEN: 'Signed a consent form',
};

export const STATES: Record<string, string> = {
  CONSENTED: 'Agreed',
  REFUSED: 'Said no',
  WITHDRAWN: 'Withdrew their agreement',
  DONE: 'Done',
  RECONSIDERED: 'Changed their mind since',
};

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-005', 'RR-CONSENT-001'];
