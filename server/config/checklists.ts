// Checklist settings (the checklist lifecycle in the Transitions document, listed under Shared
// Lifecycle Object 278). These checklists and their items are the synthetic organisation's own
// (ORG-SYN-001). Which checklists New Zealand law, regulators or national programmes require
// (for example the surgical safety checklist, or checks under Ngā paerewa), and their exact
// items, are research requirements (RR-CHK-001).

export interface ChecklistItem { id: string; label: string; evidence?: string }
export interface Checklist { id: string; label: string; purpose: string; dueMins: number; items: ChecklistItem[] }

export const CHECKLISTS: Checklist[] = [
  {
    id: 'SAFETY_ROUND', label: 'Bedside safety check', purpose: 'The person\'s surroundings are safe, checked each shift.', dueMins: 2 * 60,
    items: [
      { id: 'bell', label: 'Call bell within reach and working' },
      { id: 'bed', label: 'Bed at its lowest height with the brakes on' },
      { id: 'aid', label: 'Walking aid within reach' },
      { id: 'floor', label: 'Floor clear and dry' },
      { id: 'drink', label: 'Drink within reach' },
      { id: 'band', label: 'Identity band on and correct' },
    ],
  },
  {
    id: 'ADMISSION', label: 'Admission checklist', purpose: 'Everything needed when someone arrives.', dueMins: 24 * 60,
    items: [
      { id: 'identity', label: 'Identity checked with the person and band on' },
      { id: 'allergies', label: 'Allergies checked with the person', evidence: 'What they said' },
      { id: 'medicines', label: 'Medicines list taken', evidence: 'Where from, e.g. GP list, own supply' },
      { id: 'contact', label: 'Whānau or contact person recorded' },
      { id: 'falls', label: 'Falls risk assessed' },
      { id: 'skin', label: 'Skin and pressure injury risk assessed' },
      { id: 'belongings', label: 'Belongings and valuables listed' },
    ],
  },
  {
    id: 'TRANSFER_OUT', label: 'Before transfer', purpose: 'Ready to move to another ward or service.', dueMins: 60,
    items: [
      { id: 'handover', label: 'Handover given to the receiving team', evidence: 'Who took the handover' },
      { id: 'meds', label: 'Medicines chart and own medicines go with them' },
      { id: 'belongings', label: 'Belongings packed' },
      { id: 'whanau', label: 'Whānau told where they are going' },
      { id: 'escort', label: 'Escort and transport arranged' },
    ],
  },
];
export const CHECKLIST_BY_ID = new Map(CHECKLISTS.map((c) => [c.id, c]));
