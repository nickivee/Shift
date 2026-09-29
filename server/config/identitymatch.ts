// Identity matching settings (Shared Lifecycle Object 300, identity). Where the details came from,
// and what counts as enough agreement to join an arrival to an existing record, are the synthetic
// organisation's own rules (ORG-SYN-001), modelled on positive patient identification with two
// identifiers. The New Zealand rules for NHI searching, temporary identities for unidentified
// people and merging records are a research requirement (RR-IDENT-001).

export const SOURCES: Record<string, string> = {
  PERSON: 'The person told us', WHANAU: 'Whānau or support person', AMBULANCE: 'Ambulance handover', DOCUMENT: 'Photo ID or document',
  REFERRAL: 'Referral or transfer letter', NONE: 'No one could say',
};

export const GENDERS: Record<string, string> = { FEMALE: 'Female', MALE: 'Male', ANOTHER: 'Another gender', UNKNOWN: 'Not known' };

// Each identifier SHIFT compares, and its label in matching evidence.
export const CHECKS: Record<string, string> = { NHI: 'NHI', DOB: 'Date of birth', FAMILY: 'Family name', GIVEN: 'Given name', GENDER: 'Gender' };

// Encounter kind for an arrival, by service.
export const ARRIVAL_KIND: Record<string, string> = { 'svc-ed': 'EMERGENCY', 'svc-arc': 'RESIDENTIAL' };
