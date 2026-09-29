// Delegation settings (Cross-System Capability 308). Which activities each role may delegate, to
// whom, and which need the delegator to check the result, are the synthetic organisation's own
// rules (ORG-SYN-001), modelled on a registered nurse directing and delegating care to health care
// assistants, and a doctor delegating a procedure to a nurse who is competent to do it. The New
// Zealand rules (Nursing Council guidance on direction and delegation, Medical Council guidance on
// delegation) are a research requirement (RR-DELEG-001).

export interface Activity {
  label: string;
  from: string[];      // roles that may delegate it
  to: string[];        // roles it may be delegated to
  review: boolean;     // the delegator checks the result before it is complete
  guide: string;       // what the delegate must report straight back
}

export const ACTIVITIES: Record<string, Activity> = {
  OBS: { label: 'Take and record observations', from: ['arc-rn'], to: ['arc-caregiver'], review: true, guide: 'Any reading outside the usual range, or they seem unwell.' },
  BGL: { label: 'Check blood glucose', from: ['arc-rn'], to: ['arc-caregiver'], review: true, guide: 'Below 4 or above 15 mmol/L, or they are drowsy or sweaty.' },
  REPOSITION: { label: 'Reposition and check skin', from: ['arc-rn'], to: ['arc-caregiver'], review: false, guide: 'Any new redness that does not fade, broken skin or pain.' },
  CARES: { label: 'Personal cares', from: ['arc-rn'], to: ['arc-caregiver'], review: false, guide: 'Any change in how they manage, pain, or refusal.' },
  MEALS: { label: 'Help with meals and fluids, and record intake', from: ['arc-rn'], to: ['arc-caregiver'], review: false, guide: 'Coughing or choking, or eating or drinking much less than usual.' },
  DRESSING: { label: 'Change a simple dressing as the care plan says', from: ['arc-rn'], to: ['arc-caregiver'], review: true, guide: 'The wound looks bigger, redder, smells, or is leaking more.' },
  MEDS: { label: 'Give regular medicines from the blister pack', from: ['arc-rn'], to: ['arc-caregiver'], review: true, guide: 'Any refused, missed or dropped dose, or anything that does not match the chart.' },
  BLOODS: { label: 'Take blood samples', from: ['genmed-physician', 'ed-doctor'], to: ['genmed-rn', 'ed-rn'], review: false, guide: 'Two attempts without success, or they decline.' },
  CANNULA: { label: 'Insert a peripheral IV cannula', from: ['genmed-physician', 'ed-doctor'], to: ['genmed-rn', 'ed-rn'], review: false, guide: 'Two attempts without success.' },
  WHANAU: { label: 'Update whānau on the plan agreed today', from: ['genmed-physician'], to: ['genmed-rn'], review: true, guide: 'Questions you cannot answer, or whānau disagree with the plan.' },
  BACKSLAB: { label: 'Apply a plaster backslab', from: ['ed-doctor'], to: ['ed-rn'], review: true, guide: 'Numbness, tingling, colour change or pain getting worse after it is on.' },
  GLUE: { label: 'Close a simple wound with tissue glue', from: ['ed-doctor'], to: ['ed-rn'], review: true, guide: 'The wound edges do not come together, or it keeps bleeding.' },
};

// How long a delegation lasts, in hours.
export const HOURS = [1, 2, 4, 8, 12];

export const OUTCOMES: Record<string, string> = { DONE_WELL: 'Done as asked', FOLLOW_UP: 'Done, and I will follow something up', REDO: 'Not right yet: please do it again' };

// What always stays with the delegator.
export const KEEPS: Record<string, string> = {
  'arc-rn': 'Assessment, care planning and deciding what the results mean stay with you as the registered nurse.',
  'genmed-physician': 'Diagnosis, the plan and deciding what the results mean stay with you.',
  'ed-doctor': 'Assessment, the plan and deciding what the results mean stay with you.',
};
