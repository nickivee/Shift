// Declined care settings (Shared Lifecycle Object 296). Everyone has the right to refuse services
// (Code of Rights, Right 7(7), LAW-NZ-005). The kinds of care, who can decline, risk levels and
// outcomes are the synthetic organisation's own lists (ORG-SYN-001). When a representative (an
// enduring power of attorney or welfare guardian) may decline for someone, and what must be recorded
// when a refusal puts the person at serious risk, is a research requirement (RR-DECLINE-001).

export const CATEGORIES: Record<string, string> = {
  MEDICINE: 'A medicine', CARE: 'Personal or nursing care', TEST: 'A test or observation', PROCEDURE: 'A procedure',
  TREATMENT: 'Treatment or therapy', ADMISSION: 'Admission, transfer or staying in', OTHER: 'Something else',
};

export const DECIDED_BY: Record<string, string> = { PERSON: 'The person', REPRESENTATIVE: 'Their representative (EPOA or welfare guardian)' };

export const RISKS: Record<string, string> = { LOW: 'Low', MODERATE: 'Moderate', HIGH: 'High: could cause serious harm' };

export const REOFFER: Record<string, string> = { ACCEPTED: 'Accepted this time', DECLINED: 'Declined again' };
