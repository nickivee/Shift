// The rule book (Cross-System Capability 313, Rule Engine):
//   risk → diagnosis recommendation → order result → clinical decision alert → completed action.
// Every rule that can generate an alert is listed here with its version, where it came from, what
// it looks at and what it expects someone to do. Rules are the synthetic organisation's own
// (ORG-SYN-001) and SHIFT adds no clinical thresholds of its own. A rule whose clinical content
// needs values SHIFT does not have (a threshold or a dosing table) waits for approval and does not
// run (RR-RULES-001).

export type Step = 'RISK' | 'DIAGNOSIS' | 'ORDER' | 'RESULT' | 'CARE';

export interface RuleInfo {
  label: string;
  step: Step;
  version: number;
  status: 'ACTIVE' | 'AWAITING_APPROVAL';
  source: string;
  checks: string;               // what the rule looks at, in plain words
  expects: string;              // what someone is expected to do
  // A clinical decision alert needs a decision recorded. An outcome that closes it stays closed
  // while the same facts hold, so the same decision is not asked for again.
  outcomes?: Record<string, { label: string; closes: boolean }>;
  waiting?: string;             // for a rule awaiting approval: what it is waiting for
}

export const STEPS: Record<Step, string> = { RISK: 'Risk', DIAGNOSIS: 'Diagnosis', ORDER: 'Order', RESULT: 'Result', CARE: 'Care due' };

export const RULE_BOOK: Record<string, RuleInfo> = {
  ALLERGY_MEDICINE: {
    label: 'Medicine matches a recorded allergy', step: 'RISK', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1',
    checks: 'A current or ordered medicine whose name contains a substance on the person\'s allergy or intolerance list.',
    expects: 'Check with the prescriber and the person, then stop or change the medicine, or record why it is safe to give.',
    outcomes: { CHANGED: { label: 'Medicine stopped or changed', closes: false }, SAFE: { label: 'Checked: safe to continue', closes: true } },
  },
  INSULIN_NO_BGL: {
    label: 'On insulin or diabetes on the problem list, with no blood glucose monitoring', step: 'DIAGNOSIS', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1',
    checks: 'A current insulin, or diabetes on the problem list, and no current blood glucose monitoring plan in this service.',
    expects: 'Set up blood glucose monitoring, or record why it is not needed here.',
    outcomes: { PLANNED: { label: 'Monitoring plan set up', closes: false }, NOT_NEEDED: { label: 'Not needed here', closes: true } },
  },
  RESULT_ABNORMAL: {
    label: 'Flagged result not yet reviewed', step: 'RESULT', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1',
    checks: 'A result the laboratory flagged as abnormal that no one has reviewed.', expects: 'Review the result. Reviewing it closes the alert.',
  },
  KIDNEY_DOSE: {
    label: 'Medicine dose and kidney function', step: 'ORDER', version: 0, status: 'AWAITING_APPROVAL', source: 'RR-RULES-001',
    checks: 'Medicines that need a lower dose when kidney function is reduced.', expects: 'Check the dose against kidney function.',
    waiting: 'Needs approved kidney function thresholds and a dosing table. It does not run until they are approved.',
  },
  WOUND_REVIEW_OVERDUE: { label: 'Wound review overdue', step: 'CARE', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'A wound whose review date has passed.', expects: 'Review the wound.' },
  CAREPLAN_REVIEW_OVERDUE: { label: 'Care plan review overdue', step: 'CARE', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'A care plan item whose review date has passed.', expects: 'Review the care plan item.' },
  MONITORING_OVERDUE: { label: 'Monitoring overdue', step: 'CARE', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'A monitoring plan with nothing recorded since it was due.', expects: 'Record the monitoring.' },
  RESTRICTION_REVIEW_OVERDUE: { label: 'Restriction review overdue', step: 'CARE', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'A restriction whose review date has passed.', expects: 'Review the restriction.' },
  SWALLOW_CONCERN: { label: 'Coughing or choking since the diet was reviewed', step: 'RISK', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'Coughing or choking recorded at a meal since the diet was last reviewed.', expects: 'Review the diet.' },
  CAPACITY_REASSESS_DUE: { label: 'Capacity reassessment due', step: 'CARE', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'A capacity assessment whose reassessment date has passed.', expects: 'Reassess capacity.' },
  LEAVE_OVERDUE: { label: 'Not back from leave', step: 'RISK', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'A person due back from leave who is not recorded as back.', expects: 'Find out where they are, or record their return.' },
  EQUIPMENT_SERVICE_OVERDUE: { label: 'Equipment past its service date', step: 'CARE', version: 1, status: 'ACTIVE', source: 'ORG-SYN-001 v1', checks: 'Equipment in use on a patient past its planned service date.', expects: 'Swap the equipment.' },
};
