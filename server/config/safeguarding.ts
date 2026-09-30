// Safeguarding, family violence and elder abuse (entries 148, 149). A concern or disclosure is
// recorded privately, the person is made safe now, the risk is assessed, what the person wants and
// whether they agree to information being shared is recorded, referrals are made, a safety plan is
// agreed, and the concern is followed up until it is closed. Screening questions, when a report
// must be made, and when information may be shared without the person's agreement (Family
// Violence Act 2018, Oranga Tamariki Act 1989, HIPC 2020) are not held in SHIFT (RR-SAFE-001).

export const KINDS: Record<string, string> = {
  FAMILY_VIOLENCE: 'Family or partner violence',
  OLDER_ADULT: 'Abuse or neglect of an older or vulnerable adult',
  CHILD: 'A child may be unsafe',
  SELF_NEGLECT: 'Self-neglect',
  OTHER: 'Other',
};

export const HOW: Record<string, string> = {
  DISCLOSED: 'They told us',
  OBSERVED: 'We saw or heard something',
  REPORTED: 'Someone else told us',
};

export const SHARE: Record<string, string> = {
  AGREED: 'They agree to information being shared',
  DECLINED: 'They do not want information shared',
  NOT_SAFE: 'Not safe to ask yet',
  CANNOT: 'They cannot say',
};

export const STEPS: Record<string, string> = {
  SAFETY: 'Safe now',
  ASSESSED: 'Risk assessed',
  REFERRED: 'Referred or told',
  PLAN: 'Safety plan',
  FOLLOWUP: 'Followed up',
};

export const RISK: Record<string, string> = {
  IMMEDIATE: 'In danger now',
  HIGH: 'High risk',
  SOME: 'Some risk',
  UNCLEAR: 'Not clear yet',
};

export const TO: Record<string, string> = {
  POLICE: 'Police',
  ORANGA_TAMARIKI: 'Oranga Tamariki',
  ELDER_ABUSE: 'Elder abuse response service',
  FV_SERVICE: 'Family violence service',
  SOCIAL_WORK: 'Social worker',
  GP: 'Their GP',
  MANAGER: 'Service manager',
  OTHER: 'Other',
};

export const CLOSE: Record<string, string> = {
  SAFE: 'Safety plan in place, handed on',
  NOT_FOUND: 'Looked into: no abuse or neglect found',
  LEFT: 'Left our care, handed on',
  ERROR: 'Recorded in error',
};

export const FOLLOW_DAYS = [1, 3, 7, 14];

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-005', 'RR-SAFE-001'];
