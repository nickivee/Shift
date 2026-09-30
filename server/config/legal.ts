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
    ref: 'RR-SURV-001',
    question: 'Which New Zealand clinicians may decide to continue, change or stop a surveillance plan (for example potassium checks after starting spironolactone, or lithium levels), how quickly a concerning surveillance result must be reviewed, and who is accountable when a check is missed.',
    blocks: 'Leaving a missed check or a concerning result unreviewed. SHIFT records every check, its result or why it was not done, and who reviewed it and decided what next.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-SCREEN-001',
    question: 'How a New Zealand service\'s own screening (for example memory, mood or hearing screens in aged residential care) relates to the national screening programmes (bowel, breast, cervical, diabetic retinal), what information and consent an offer of screening needs, and who must tell a person an abnormal result.',
    blocks: 'Acting as a national screening register, and closing an abnormal screen without further tests or referral. SHIFT records the offer, the person\'s decision in their words, the result, the review, and how they were told.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-INF-001',
    question: 'Which infections a New Zealand hospital or rest home must notify to the Medical Officer of Health under the Health Act 1956, and how a resistant organism (MRSA, ESBL, VRE, CPE) must be flagged and shared with the next provider when a person moves between services.',
    blocks: 'Sending any notification from SHIFT. SHIFT records the infection, the organism and its resistance, shows resistant organisms on the record, and leaves notification to people.',
    category: 'LAW',
  },
  {
    ref: 'RR-AMS-001',
    question: 'Which New Zealand antimicrobial stewardship rules apply to a hospital or rest home: local guideline adherence, approval for restricted antimicrobials, the 48 to 72 hour review, and who may authorise an IV to oral switch or a change of agent.',
    blocks: 'Prescribing or approving restricted antimicrobials in SHIFT. SHIFT references the medication order, records reviews, changes and the outcome, and shows courses overdue for review.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-SITE-001',
    question: 'Which New Zealand requirements apply to verifying the site and side of a procedure outside the operating theatre (ward and emergency procedures, rest home procedures): which procedures need a site mark and a team time-out, which documents count as a source, and how a wrong-site procedure must be reported.',
    blocks: 'Treating SHIFT\'s site check as the formal surgical safety checklist. SHIFT records the planned site and side, each check, any mismatch and how it was resolved, and links the done procedure.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-READY-001',
    question: 'Who may decide in each New Zealand setting that a person is ready for a procedure, discharge, a transfer between services, mobilising or therapy (medical, nursing and allied health scopes of practice), and what must be recorded when someone is ready only with conditions.',
    blocks: 'Treating SHIFT\'s readiness decision as clinical sign-off beyond the synthetic organisation\'s own list of who may decide. SHIFT records what must be done first, who decided, the conditions, and when to reassess.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-VAR-001',
    question: 'Which variances from charted care, protocols or pathways in a New Zealand hospital or rest home must also be reported as incidents (including to HQSC or the Ministry of Health), and who may authorise an alternative to a charted medicine or protocol step.',
    blocks: 'Treating a variance in SHIFT as an incident report or as authority to change a medicine order. SHIFT records what was expected, what happened, why, the decision, and the follow-up, and flags mistakes to report as incidents.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-DECLINE-001',
    question: 'When a New Zealand enduring power of attorney or welfare guardian may decline care on someone\'s behalf, what must be documented when a person declines care that could cause them serious harm, and when a refusal must be escalated or reported.',
    blocks: 'Treating a representative\'s refusal recorded in SHIFT as legally valid without checking their authority. SHIFT records what was offered and explained, who declined, the reason, the risk, the plan, escalation and re-offers.',
    category: 'LAW',
  },
  {
    ref: 'RR-TRIAGE-001',
    question: 'Which triage or priority scale each New Zealand setting must use (the Australasian Triage Scale in emergency departments, and any national scale for ward review, rest home GP review or allied health waiting lists), the current ACEM timeframes, and who may assign or lower a priority.',
    blocks: 'Using SHIFT\'s ward, rest home and physiotherapy scales as national standards. They are the synthetic organisation\'s own. SHIFT records the evidence, the priority a clinician assigned, reassessments and whether the timeframe was met; it never assigns a priority itself.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-IDENT-001',
    question: 'The New Zealand rules for identifying a person on arrival: searching the National Health Index, how many identifiers must agree, naming and managing unidentified people, recording an NHI that has not been verified, and who may merge or unmerge records.',
    blocks: 'Treating SHIFT\'s matching rule (the NHI, or date of birth with full name) as a national standard, and updating the National Health Index. SHIFT records what was stated and where it came from, shows the evidence for each possible match, and keeps every merge reversible; a clinician makes every match.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-DUP-001',
    question: 'The New Zealand process for duplicate health records: who may merge or unmerge local records, how duplicate NHIs are reported and resolved nationally, and what must be kept of a merged record.',
    blocks: 'Merging two records that each have an NHI, and changing the National Health Index. SHIFT merges only local duplicates, keeps the record with the NHI, keeps the merged record marked as merged, gives every affected service a task to check its entries, and can undo the merge.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-BREAKGLASS-001',
    question: 'The New Zealand rules for break-glass access to health information: when a clinician outside the care team may open a record, what must be recorded, how long access may last, who reviews each use and what happens when a use was not appropriate.',
    blocks: 'Treating SHIFT\'s pathways (emergency, the person present, or a senior\'s approval), time limits and review outcomes as a national standard. SHIFT records the reason and agreement, closes access on its own, lists everything opened under it, and a senior clinician in the service reviews every use.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-DELEG-001',
    question: 'The New Zealand rules for delegating care: Nursing Council guidance on direction and delegation to enrolled nurses and health care assistants, Medical Council guidance on delegating to nurses and others, which activities may be delegated in each setting, and what supervision each needs.',
    blocks: 'Treating SHIFT\'s list of delegable activities, who may take them on and which need checking as a national standard. SHIFT lets only the listed roles delegate and receive each activity, records the delegator\'s check of competence, needs the delegate to accept, and keeps the delegator responsible for the person throughout.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-RULES-001',
    question: 'Clinical decision support content for New Zealand settings: which medicine, allergy, diagnosis and result rules an organisation should run, the thresholds and dosing tables they need (for example kidney function and medicine doses), who approves and owns each rule, and how rules are validated and kept up to date.',
    blocks: 'Running any rule that needs a clinical threshold or dosing table. SHIFT runs only rules built on recorded facts (a medicine that names a recorded allergy, insulin or diabetes without blood glucose monitoring, a result the laboratory flagged), shows the facts behind every alert, and lists rules awaiting approval without running them.',
    category: 'NATIONAL/SECTOR STANDARD',
  },
  {
    ref: 'RR-QUEUE-001',
    question: 'What New Zealand settings require when work is missed: who must be told when a task is not accepted or not done by its due time, how quickly, and who is accountable at each step (for example a caregiver to the registered nurse on duty, a nurse to the doctor).',
    blocks: 'Treating SHIFT\'s escalation ladders and waiting times as a standard. SHIFT sends missed work one step up the service\'s ladder, needs the next person to acknowledge it and record what they did, sends it further up if no one does, and never reassigns work silently.',
    category: 'ORGANISATIONAL CONFIGURATION',
  },
  {
    ref: 'RR-DEVICE-001',
    question: 'What New Zealand requires for lines, tubes and catheters in each setting: who may insert each kind (including rest home nurses and caregivers), how a nasogastric tube or central line position must be confirmed before use, how often sites must be checked and what with, how long each may stay in (dwell time), how line-related bloodstream infections and catheter-associated urinary infections must be monitored and reported (Health Quality & Safety Commission programmes), and who may remove them.',
    blocks: 'Required check intervals, dwell limits and position-confirmation methods, and reporting of line or catheter infections. SHIFT records what was put in, where, why and by whom, the position check where the organisation asks for one, site checks by the organisation\'s usual interval, whether it is still needed and why, problems reported, and removal, including whether it came out whole.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-COMPLAINT-001',
    question: 'What the Code of Rights (Right 10) and the Health and Disability Commissioner require of a provider\'s complaints process: the timeframes for acknowledging, deciding and replying, what must be in writing, what the person must be told about the advocacy service and the Commissioner, how complaints must be recorded and kept, and what aged residential care must report for certification (Ngā Paerewa).',
    blocks: 'Deadlines for acknowledging and replying to a complaint, and any reporting of complaints. SHIFT records the complaint in their words, who took it in, acknowledgement, whether they were told about advocacy, the reply date the handler gave them, what was looked into, the response, whether they were satisfied, and what is changing.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-ARC-001',
    question: 'What the aged residential care agreement and Health New Zealand require for rest home stays: the levels of care and how each is named, who may assess or reassess a person\'s level (needs assessment services, interRAI), what must happen when needs change beyond the level a rest home provides, respite and short stays, and how long a room is held and funded while a resident is in hospital.',
    blocks: 'Deciding a level of care, deciding that a room is no longer held, and funding or charging. SHIFT records the place offered and taken, the level a needs assessment gave and where it came from, reassessment asked for and why, hospital stays and when they came back, and why they left.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-SAFE-001',
    question: 'What New Zealand requires when a health or rest home worker learns of family violence, elder abuse or neglect, or a child who may be unsafe: routine screening questions (for example family violence screening in emergency departments), when a report must or may be made to Police or Oranga Tamariki, when information may be shared without the person\'s agreement (Family Violence Act 2018, Oranga Tamariki Act 1989, HIPC 2020 rule 11), and who in a service must be told.',
    blocks: 'Asking screening questions, deciding that a report must be made, and deciding that information may be shared without agreement. SHIFT records the concern privately, what was done to keep the person safe, the risk as judged, their wishes and agreement to sharing, who was told and who decided, the safety plan and follow-up.',
    category: 'LAW',
  },
  {
    ref: 'RR-EOL-001',
    question: 'What New Zealand requires and recommends for palliative and end-of-life care in hospitals and rest homes: national last-days-of-life guidance (Te Ara Whakapiri), how resuscitation and treatment-limitation decisions are made and recorded, anticipatory (just-in-case) prescribing, advance care planning, and what the End of Life Choice Act 2019 requires of services and staff.',
    blocks: 'Recording resuscitation or treatment-limitation decisions, prescribing anticipatory medicines, and any part of assisted dying. SHIFT records who recognised the need for palliative care and who agreed, the person\'s and whānau wishes in their words, reviews, recognition of the last days of life, comfort checks, and whānau follow-up after a death.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-CONSENT-001',
    question: 'What New Zealand requires for informed consent (Code of Rights Rights 5, 6 and 7): who may seek consent for each kind of procedure or treatment, when consent must be in writing (Right 7(6)), what information must be given and how it is recorded, how long consent lasts before it must be checked again, and how a refusal or withdrawal must be recorded and respected.',
    blocks: 'Deciding who may take consent for what, requiring or waiving written consent, and letting consent expire. SHIFT records the person\'s own decision, what they were told, how understanding was checked and whether it was verbal or written, and shows every "no" or withdrawal on the record.',
    category: 'REGULATION/CODE',
  },
  {
    ref: 'RR-ALLERGY-001',
    question: 'What New Zealand requires when recording allergies and adverse reactions: how a reaction is classified (allergy, intolerance, side effect), who may confirm or rule one out and on what evidence, whether a caregiver report may stand as a suspected allergy until checked, and when a reaction must be reported to the Centre for Adverse Reactions Monitoring (CARM) or Medsafe.',
    blocks: 'Classifying a reaction automatically, ruling one out without a named clinician and reason, and sending any report to CARM. SHIFT records what was reported or seen, shows it at once on the record and in medicine checks, asks a nurse to check caregiver reports, and keeps every ended entry with who ended it and why.',
    category: 'LAW',
  },
  {
    ref: 'RR-IPC-001',
    question: 'What New Zealand requires for isolation and outbreaks in hospitals and rest homes: which precautions each infection or organism needs and for how long, how precautions are cleared, how an outbreak is defined and declared, who must be told (public health, Te Whatu Ora, families), and the Infection Prevention and Control Standard (NZS 8134) criteria a service is audited against.',
    blocks: 'Suggesting a precaution from an organism, stopping precautions automatically, and sending any outbreak notification. SHIFT records the precautions a clinician chooses, shows them to everyone who opens the record, keeps them under review, and records outbreak cases, contacts and what the service did.',
    category: 'LAW',
  },
  {
    ref: 'RR-RECONCILE-001',
    question: 'What New Zealand requires when information from another provider differs from a person\'s record: how medicines reconciliation must be done and by whom at admission, transfer and discharge, whether an allergy reported by another provider may be recorded before it is confirmed with the person, and how the sender must be told about a difference.',
    blocks: 'Changing a medicine from another provider\'s list, and removing an allergy because a sender did not list it. SHIFT compares what they list with the record, adds or changes an allergy only on a clinician\'s decision with where it came from, sends every medicine difference to a prescriber, and will not let the information be signed off until every difference is decided.',
    category: 'ORGANISATIONAL CONFIGURATION',
  },
  {
    ref: 'RR-DOWNTIME-001',
    question: 'What New Zealand requires when an electronic health record is unavailable: the continuity processes a service must have, how records made on paper during downtime are brought back into the electronic record, how long the paper originals must be kept (Health (Retention of Health Information) Regulations 1996), and who may enter them.',
    blocks: 'Treating the synthetic organisation\'s paper processes as a standard, and any advice to destroy paper originals. SHIFT shows the organisation\'s process for each function that is down, enters each paper record at the time the care happened with who wrote it and the sheet it came from, and closes a downtime only when everyone in the service has been checked.',
    category: 'ORGANISATIONAL CONFIGURATION',
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
