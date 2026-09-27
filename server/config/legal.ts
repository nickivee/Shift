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
    ref: 'RR-CAP-001',
    question: 'What follows in law from a finding that a person lacks capacity for a decision (Code of Rights Right 7(4), the Protection of Personal and Property Rights Act 1988, enduring powers of attorney and welfare guardians): who may then decide, what certificate is needed, and how that is recorded.',
    blocks: 'Recording who decides for a person, activating an enduring power of attorney, or treating a capacity finding as consent. SHIFT records the assessment only.',
    category: 'LAW',
  },
  {
    ref: 'RR-WHANAU-001',
    question: 'When health information may be shared with whānau, family or support people who the person has not agreed to, or when the person cannot say (HIPC 2020 rule 11 and the Code of Rights), and how that decision is recorded.',
    blocks: 'Recording health information as shared with someone the person has not agreed to. SHIFT lets staff record a contact with them only as "no health information shared".',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-ACU-001',
    question: 'Which acuity or patient-dependency tools New Zealand services use (for example under Care Capacity Demand Management), how they are calculated and licensed, and how their results should change staffing and escalation.',
    blocks: 'Calculating an acuity or workload score. SHIFT records a clinician\'s judgement of clinical status only.',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-INC-001',
    question: 'How New Zealand services must rate and report adverse events: the Health Quality & Safety Commission national adverse events policy (severity rating and the always report and review list), notifications to HealthCERT, WorkSafe and the coroner, and what applies in each setting.',
    blocks: 'Rating an incident on the national scale or deciding that it must be notified. SHIFT records the reviewer\'s decision only.',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-DTH-001',
    question: 'Who may verify that a person has died in each New Zealand setting (hospital, aged residential care, community), what must be checked and recorded, and any Ministry of Health or professional guidance on verification of death.',
    blocks: 'Deciding who is allowed to verify a death. SHIFT lets the synthetic organisation\'s nurses and doctors record verification (ORG-SYN-001) and records what they checked.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-DTH-002',
    question: 'Who may complete a medical certificate of cause of death, which deaths must be reported to the coroner (Coroners Act 2006) and how, what the Burial and Cremation Act requires before release, and how organ and tissue donation is raised.',
    blocks: 'Issuing a certificate, deciding that a death must go to the coroner, or authorising release. SHIFT records references to what was done only.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-INT-001',
    question: 'Which clinical interventions New Zealand law, regulators or national standards require to be authorised before they start (for example devices, procedures and restraint under NZS 8134 Ngā paerewa), who may authorise each, and what must be recorded.',
    blocks: 'Deciding which interventions need authorising and by whom. SHIFT uses the synthetic organisation\'s own rule (devices and procedures need a doctor) and does not offer restraint.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-TP-001',
    question: 'Who may agree to a treatment plan for a person who cannot agree themselves (Code of Health and Disability Services Consumers\' Rights, Right 7(4); Protection of Personal and Property Rights Act 1988 EPOA and welfare guardian powers), and what must be recorded when treatment is given in their best interests.',
    blocks: 'Treating a best-interests decision as consent. SHIFT records who agreed and why, and does not decide whether that agreement is lawful.',
    category: 'LAW',
  },
  {
    ref: 'RR-TP-002',
    question: 'Which clinicians may authorise a treatment plan in each New Zealand setting (for example a general practitioner or nurse practitioner for aged residential care residents), and whether a plan must name a responsible clinician.',
    blocks: 'Authorising plans in services with no doctor or therapist. SHIFT uses the synthetic organisation\'s rule (a doctor or physiotherapist agrees the plan), so residential care plans wait.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-PW-001',
    question: 'Which clinical pathways and protocols New Zealand services must or should follow (for example Health Quality & Safety Commission falls and sepsis guidance, and delirium standards), their eligibility criteria, steps and time frames, and who owns and approves each.',
    blocks: 'Using real clinical pathways. SHIFT\'s three pathways are the synthetic organisation\'s own, are not clinically validated, and only track what was done against their steps.',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-CHK-001',
    question: 'Which checklists New Zealand law, regulators or national programmes require in each setting (for example the surgical safety checklist, admission and transfer checks, and environmental safety checks under Ngā paerewa), their required items, and how completion must be evidenced.',
    blocks: 'Using mandated checklists. SHIFT\'s three checklists are the synthetic organisation\'s own and only record what was checked.',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-REC-001',
    question: 'Whether a recommendation from one health profession binds another in New Zealand (for example a physiotherapist\'s mobility recommendation to nursing staff), who is accountable when one is declined or not implemented, and what must be documented.',
    blocks: 'Treating a recommendation as an order. SHIFT records who recommended what, the response and the outcome, and leaves the decision with the recipient.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-REQ-001',
    question: 'Who in a New Zealand health service is accountable for a care requirement that is deferred, cancelled or never done, how long a deferral may run before it must be escalated, and what must be recorded when one is closed without being met.',
    blocks: 'Automatic escalation or closure of requirements. SHIFT records who took each requirement on, what was done or why not, and the outcome, and leaves escalation to people.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-DUE-001',
    question: 'How late regular care (such as pressure-area repositioning, cannula checks or catheter care) may be in a New Zealand health or aged residential care service before it must be escalated or reported, and whether the Ngā Paerewa Health and Disability Services Standard sets any interval.',
    blocks: 'Automatic escalation or reporting of late care. SHIFT shows how late care is and who moved or stopped it, and leaves escalation to people.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-RECALL-001',
    question: 'How a service\'s own recall (for example an annual influenza vaccine in aged residential care) relates to national immunisation and screening programme recall in New Zealand, and what consent or authority is needed to contact a person, or their whānau or representative, about a recall.',
    blocks: 'Linking SHIFT recalls to national programme registers, and contacting anyone other than the person without a recorded reason. SHIFT records who was contacted, how, and the outcome.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-FU-001',
    question: 'Who in New Zealand stays accountable for a follow-up that a hospital service asks a GP or another outside provider to do (for example a repeat blood test after discharge), what must be sent to them, and what the hospital must do if it does not happen.',
    blocks: 'Treating a follow-up as handed over just because it is in a letter. SHIFT records who took responsibility, how they were told, and whether it happened.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-INSTR-001',
    question: 'Which assessment instruments each New Zealand setting must or should use (for example interRAI in aged residential care), their licensing terms, and checking the text of free-to-use instruments against the publishers\' current versions.',
    blocks: 'Using licensed instruments such as interRAI. SHIFT includes only instruments whose publishers allow free use (PHQ-9 and 4AT), and their text must be checked before clinical use.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-CODE-001',
    question: 'Which classifications and editions must be used to code hospital events in New Zealand (for example ICD-10-AM, ACHI and the SNOMED CT NZ Edition), where the licensed code tables come from, and what must be reported to national collections and by when.',
    blocks: 'Checking codes against the official code tables and sending coded events to national collections. SHIFT checks the form of each code only.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-IMPORT-001',
    question: 'What must be done with clinical information received for someone who is not a patient of the service, or whose identity cannot be confirmed: return, forward, destroy or keep, and how that is recorded (HIPC 2020 rules 5 and 11).',
    blocks: 'Returning, forwarding or destroying misdirected information. SHIFT marks it "not ours", keeps it out of every record, and holds it.',
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
