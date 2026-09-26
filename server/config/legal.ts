// Legal and requirement register. Categories are kept distinct (instructions §13):
// a LAW entry is never used to stand in for an organisational rule, and an open research
// question is recorded as UNRESOLVED rather than filled in.

export type RequirementClass =
  | 'LAW'
  | 'REGULATION/CODE'
  | 'PROFESSIONAL REQUIREMENT'
  | 'NATIONAL/SECTOR STANDARD'
  | 'ORGANISATIONAL CONFIGURATION'
  | 'SHIFT PRODUCT DESIGN';

export interface LegalSource {
  ref: string;
  title: string;
  category: RequirementClass;
  status: string;
  relevance: string;
  source: string;
  verifiedAsAt: string;
}

// Verified baseline from the Controlled Product Specification, register status date
// 11 September 2026. Current-version checks remain required at release.
export const LEGAL_REGISTER: LegalSource[] = [
  {
    ref: 'LAW-NZ-001',
    title: 'Privacy Act 2020',
    category: 'LAW',
    status: 'In force; current official version to be checked at release.',
    relevance: 'Privacy, access/correction, security, disclosure, breach and information governance.',
    source: 'https://www.legislation.govt.nz/act/public/2020/0031/latest/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-002',
    title: 'Health Information Privacy Code 2020',
    category: 'REGULATION/CODE',
    status: 'Current OPC version in force 1 May 2026; incorporates Amendment No 2 / Rule 3A.',
    relevance: 'Collection, notification, use, disclosure, access, correction, security, retention and unique identifiers.',
    source: 'https://www.privacy.org.nz/privacy-principles/codes-of-practice/hipc2020/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-003',
    title: 'Health Information Privacy Code Rule 3A',
    category: 'REGULATION/CODE',
    status: 'Effective 1 May 2026 through HIPC Amendment No 2.',
    relevance: 'Indirect collection notification and exception governance.',
    source: 'https://www.privacy.org.nz/resources-and-learning/a-z-topics/ipp3a/hipc-rule-3a/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-004',
    title: 'Health and Disability Commissioner Act 1994',
    category: 'LAW',
    status: 'In force; official version as at 10 July 2026 located.',
    relevance: 'Consumer-rights framework, Commissioner functions and Code authority.',
    source: 'https://www.legislation.govt.nz/act/public/1994/0088/latest/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-005',
    title: "Code of Health and Disability Services Consumers' Rights (Regulations 1996)",
    category: 'REGULATION/CODE',
    status: 'Regulation under the HDC Act.',
    relevance: 'Consumer rights and provider duties, including communication, information, consent and complaints.',
    source: 'https://www.hdc.org.nz/your-rights/about-the-code/code-of-health-and-disability-services-consumers-rights/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-006',
    title: 'Health (Retention of Health Information) Regulations 1996',
    category: 'REGULATION/CODE',
    status: 'In force; latest official version as at 10 July 2026 located.',
    relevance: 'Minimum retention obligations for covered providers.',
    source: 'https://www.legislation.govt.nz/regulation/public/1996/0343/latest/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-007',
    title: 'Health Practitioners Competence Assurance Act 2003',
    category: 'LAW',
    status: 'In force; official page notes amendments from Mental Health Act 2026 not yet incorporated.',
    relevance: 'Registration, scopes of practice, competence and regulated professional authority.',
    source: 'https://www.legislation.govt.nz/act/public/2003/0048/latest/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-008',
    title: 'Medicines Act 1981',
    category: 'LAW',
    status: 'In force; official version as at 10 July 2026 located.',
    relevance: 'Prescribing, supply and administration controls.',
    source: 'https://www.legislation.govt.nz/act/public/1981/0118/latest/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-009',
    title: 'Medicines Regulations 1984',
    category: 'REGULATION/CODE',
    status: 'In force; latest official version as at 10 July 2026 located.',
    relevance: 'Prescription, supply, administration and records requirements.',
    source: 'https://www.legislation.govt.nz/regulation/public/1984/0143/latest/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-010',
    title: 'Misuse of Drugs Act 1975',
    category: 'LAW',
    status: 'AUTHORITATIVE CURRENT-VERSION REVIEW REQUIRED before controlled requirements are populated.',
    relevance: 'Controlled-drug authority and restrictions.',
    source: 'https://www.legislation.govt.nz/act/public/1975/0116/latest/',
    verifiedAsAt: '2026-09-11',
  },
  {
    ref: 'LAW-NZ-011',
    title: 'Misuse of Drugs Regulations 1977',
    category: 'REGULATION/CODE',
    status: 'Consolidation as at 28 May 2026 records amendments not yet incorporated; current-version check mandatory.',
    relevance: 'Controlled-drug permissions, prescriptions, registers and records.',
    source: 'https://www.legislation.govt.nz/regulation/public/1977/0037/latest/',
    verifiedAsAt: '2026-09-11',
  },
];

// Research requirements: gaps SHIFT must not invent. Operations that depend on them
// return UNRESOLVED and fail closed until the entry is researched and versioned.
export interface ResearchRequirement {
  ref: string;
  question: string;
  blocks: string;
  category: RequirementClass;
}

export const RESEARCH_REQUIREMENTS: ResearchRequirement[] = [
  {
    ref: 'RR-EWS-001',
    question: 'Which NZ early-warning score, thresholds and escalation rules apply in each service?',
    blocks: 'Calculating or displaying an early-warning score or automatic escalation from observations.',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-MED-001',
    question: 'Detailed mapping of prescribing, supply and administration requirements (LAW-NZ-008/009) to each profession and setting.',
    blocks: 'Prescribing, verification and administration recording.',
    category: 'LAW',
  },
  {
    ref: 'RR-CD-001',
    question: 'Current-version review of controlled-drug requirements (LAW-NZ-010/011), including registers and witness rules.',
    blocks: 'Any controlled-drug operation.',
    category: 'LAW',
  },
  {
    ref: 'RR-DISC-001',
    question: 'HIPC rule 11 mapping for disclosure between agencies, by purpose and relationship.',
    blocks: 'Routing to a destination in another organisation (a disclosure). Routes within one organisation are unaffected.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-RESTRAINT-001',
    question: 'Restraint and restrictive-practice requirements in each setting (Ngā Paerewa restraint criteria, the Code of Rights, and any compulsory-care law), including who may approve, monitoring and reporting.',
    blocks: 'Recording restraint, seclusion or any restriction a person has not agreed to that limits their freedom of movement.',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-BLOOD-001',
    question: 'Requirements for blood and blood products in NZ: NZ Blood Service and national transfusion guidance, consent, bedside identity and product checks, and traceability.',
    blocks: 'Requesting, issuing, checking and giving blood or blood products (Shared Lifecycle Object 245).',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-LEAVE-001',
    question: 'Who may grant leave to a person under a legal order (for example the Mental Health Act, the Substance Addiction (Compulsory Assessment and Treatment) Act 2017, the Intellectual Disability (Compulsory Care and Rehabilitation) Act 2003, or a court or Corrections order), what conditions and paperwork apply, and what must happen if they do not return.',
    blocks: 'Approving leave for a person under a legal order. SHIFT records the request and it stays waiting.',
    category: 'LAW',
  },
  {
    ref: 'RR-ADVDIR-001',
    question: 'How advance directives and advance care plans (Code of Rights Right 7(5)) are recorded, checked for validity and applied in each setting, and who may rely on them.',
    blocks: 'Recording a preference as an advance directive, or as a refusal of treatment that staff must follow. Preferences are recorded and respected, but they are not consent or refusal.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-RET-001',
    question: 'Retention and disposal basis for Personal Notes and other non-clinical working information.',
    blocks: 'Permanent deletion of Personal Notes (dismiss hides instead).',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-MH-001',
    question: 'Transition from the Mental Health (Compulsory Assessment and Treatment) Act 1992 to the Mental Health Act 2026.',
    blocks: 'Compulsory-care workflows.',
    category: 'LAW',
  },
];

// Organisational rule pack for the synthetic organisations. These are ORGANISATIONAL
// CONFIGURATION, versioned and effective-dated, and never presented as law.
export const ORG_RULE_PACK = {
  ref: 'ORG-SYN-001',
  version: 1,
  effectiveFrom: '2026-01-01',
  category: 'ORGANISATIONAL CONFIGURATION' as RequirementClass,
};
