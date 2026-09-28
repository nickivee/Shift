// Clinical readiness settings (Shared Lifecycle Object 293). What a person can be assessed as ready
// for, the usual things that must be done first, and which professions may decide are the synthetic
// organisation's own lists (ORG-SYN-001). Who may decide readiness for discharge, transfer or a
// procedure in each New Zealand setting is a research requirement (RR-READY-001).

export const KINDS: Record<string, string> = {
  PROCEDURE: 'For a procedure', DISCHARGE: 'To go home or leave', TRANSFER: 'To move to another service', MOBILISE: 'To get up and walk',
  THERAPY: 'For therapy', OTHER: 'Something else',
};

// Professions that may decide readiness of each kind (with the readiness.assess capability).
export const ASSESSORS: Record<string, string[]> = {
  PROCEDURE: ['Medical Practitioner'],
  DISCHARGE: ['Medical Practitioner', 'Registered Nurse'],
  TRANSFER: ['Medical Practitioner', 'Registered Nurse'],
  MOBILISE: ['Physiotherapist', 'Medical Practitioner', 'Registered Nurse'],
  THERAPY: ['Physiotherapist', 'Medical Practitioner'],
  OTHER: ['Medical Practitioner', 'Registered Nurse', 'Physiotherapist'],
};

// The usual things to be done first. [label, essential]. Essential ones must be done or not
// applicable before someone can be marked ready without conditions.
export const TEMPLATES: Record<string, [string, boolean][]> = {
  PROCEDURE: [['Consent recorded', true], ['Allergies confirmed', true], ['Fasting as instructed', true], ['Blood tests reviewed', true],
    ['Blood thinners held, or a plan in place', true], ['Site and side checked', true]],
  DISCHARGE: [['Medically stable', true], ['Medicines reconciled and supplied', true], ['Safe to move around at home', true], ['Supports at home arranged', true],
    ['Discharge summary written', true], ['Follow-up booked', false], ['Whānau told', false]],
  TRANSFER: [['Stable for the move', true], ['Receiving service has accepted', true], ['Handover given', true], ['Transport and escort arranged', true],
    ['Belongings and medicines packed', false]],
  MOBILISE: [['Observations within limits', true], ['Pain controlled', true], ['Weight-bearing instructions known', true], ['Enough staff to help', true],
    ['Walking aid available', false]],
  THERAPY: [['Medically fit for therapy', true], ['Agreed to therapy', true], ['Goals agreed with the person', true], ['Pain controlled', false]],
  OTHER: [],
};

export const ITEM_STATUS: Record<string, string> = { OUTSTANDING: 'Still to do', COMPLETED: 'Done', NOT_APPLICABLE: 'Not applicable' };

export const END_REASONS: Record<string, string> = {
  WENT_AHEAD: 'It went ahead', NOT_NEEDED: 'No longer needed', PLAN_CHANGED: 'The plan changed', OTHER: 'Other',
};
