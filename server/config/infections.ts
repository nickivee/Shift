// Infection episode settings (Shared Lifecycle Object 289). The sites, kinds of evidence,
// resistance flags, responses and complications are the synthetic organisation's own lists
// (ORG-SYN-001). Which infections must be notified to a Medical Officer of Health, and how
// resistant organisms must be flagged and shared between providers, are research requirements
// (RR-INF-001); SHIFT records and shows them but does not notify anyone.

export const SITES: Record<string, string> = {
  CHEST: 'Chest', URINE: 'Urine or kidney', SKIN: 'Skin or soft tissue', WOUND: 'Wound', LINE: 'IV line or device',
  ABDOMEN: 'Abdomen', BLOOD: 'Blood (no clear source)', OTHER: 'Other',
};

// What can be added to an episode, and what each needs.
export const ENTRY_KINDS: Record<string, string> = {
  EVIDENCE: 'Evidence', ORGANISM: 'Organism', SUSCEPTIBILITY: 'Sensitivity', TREATMENT: 'Treatment', RESPONSE: 'Response',
  SOURCE_CONTROL: 'Source control', COMPLICATION: 'Complication',
};

export const RESISTANCE: Record<string, string> = {
  NONE: 'No resistance flag', MRSA: 'MRSA', ESBL: 'ESBL', VRE: 'VRE', CPE: 'CPE', OTHER_MDRO: 'Other multi-resistant organism',
};

export const SUSCEPTIBILITY: Record<string, string> = { S: 'Sensitive', I: 'Intermediate', R: 'Resistant' };

export const RESPONSES: Record<string, string> = { IMPROVING: 'Improving', SAME: 'No change', WORSE: 'Getting worse' };

export const SOURCE_STATUS: Record<string, string> = { PLANNED: 'Planned', DONE: 'Done' };
