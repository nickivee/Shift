// Data reconciliation (Cross-System Capability): incoming data → matching → comparison →
// conflict/duplicate detection → authorised reconciliation → canonical linkage/state → provenance.
// What another provider lists (allergies, medicines) is compared with this record, and a clinician
// decides each difference. A medicine difference is never changed here: it goes to a prescriber.

export const FACT_KINDS: Record<string, string> = {
  ALLERGY: 'Allergy or intolerance',
  NO_KNOWN_ALLERGIES: 'No known allergies',
  MEDICINE: 'Medicine',
};

export const DIFFERENCES: Record<string, string> = {
  SAME: 'Same as our record',
  NEW: 'Not in our record',
  DIFFERENT: 'Different from our record',
  CONFLICT: 'Conflicts with our record',
  OURS_ONLY: 'In our record, not on theirs',
};

export const DECISIONS: Record<string, string> = {
  ADD: 'Add it to our record',
  UPDATE: 'Change ours to match theirs',
  KEEP_OURS: 'Keep our record as it is',
  PRESCRIBER: 'Ask a prescriber to decide',
  NO_CHANGE: 'No change needed',
};

// Which decisions each difference allows. An allergy is never removed because a sender did not
// list it or said there were none: that stays a decision to keep ours and tell the sender.
export function allowed(kind: string, difference: string): string[] {
  if (kind === 'MEDICINE') return ['PRESCRIBER', 'NO_CHANGE'];
  if (difference === 'OURS_ONLY') return ['KEEP_OURS'];
  if (kind === 'NO_KNOWN_ALLERGIES') return difference === 'NEW' ? ['ADD', 'KEEP_OURS'] : ['KEEP_OURS'];
  if (difference === 'DIFFERENT') return ['UPDATE', 'KEEP_OURS'];
  return ['ADD', 'KEEP_OURS'];
}

export const CERTAINTY: Record<string, string> = {
  CONFIRMED: 'Confirmed with the person or whānau',
  SUSPECTED: 'Not yet confirmed',
};

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-RECONCILE-001'];
