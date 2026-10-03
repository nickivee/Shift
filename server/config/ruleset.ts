// The rules an organisation can set, and what shape each value takes. A rule's value is data held in
// the database with its source, start date and version (see domain/ruleset.ts), so it can change when
// the law, a standard or the organisation's own policy changes, and a different country, state or
// health system can set its own on the same core. This list says which values the program knows how to
// apply; it holds no values. Where a jurisdiction has no value for a rule, nothing is assumed: the
// screen that needs it says the rule has not been set.
export type RuleKind = 'int' | 'professions' | 'dates' | 'reasons';

export interface RuleKey {
  key: string;
  label: string;
  group: string;
  kind: RuleKind;
  min?: number;
  max?: number;
  unit?: string;
  category: 'LAW' | 'REGULATION/CODE' | 'PROFESSIONAL REQUIREMENT' | 'NATIONAL/SECTOR STANDARD' | 'ORGANISATIONAL CONFIGURATION';
  what: string;          // what changes on the screens when the value changes
  waiting?: string;      // for a rule with no value yet: what is still needed (RR-*)
  ref: string;           // the research requirement it belongs to
}

export const RULE_KEYS: RuleKey[] = [
  {
    key: 'medicine.prescribers', label: 'Who may prescribe', group: 'Medicines', kind: 'professions', category: 'LAW', ref: 'RR-MEDICINES-001',
    what: 'The professions whose members can write a medicine order. Everyone else sees the medicines but cannot order them.',
  },
  {
    key: 'medicine.not_given_reasons', label: 'Reasons a dose is not given', group: 'Medicines', kind: 'reasons', category: 'ORGANISATIONAL CONFIGURATION', ref: 'ORG-SYN-001 v1',
    what: 'The list a nurse chooses from when a dose is not given.',
  },
  {
    key: 'visit.not_done_reasons', label: 'Reasons a visit is not done', group: 'Visits', kind: 'reasons', category: 'ORGANISATIONAL CONFIGURATION', ref: 'ORG-SYN-001 v1',
    what: 'The list a nurse chooses from when a planned visit could not be done.',
  },
  {
    key: 'cd.check_interval_days', label: 'Controlled drug book: joint check every', group: 'Controlled drugs', kind: 'int', min: 1, max: 31, unit: 'days', category: 'LAW', ref: 'RR-CDREGISTER-001',
    what: 'How often each page of the ward book is checked with a colleague before it shows as due.',
  },
  {
    key: 'cd.stocktake_dates', label: 'Controlled drug stocktake dates each year', group: 'Controlled drugs', kind: 'dates', category: 'LAW', ref: 'RR-CDREGISTER-001',
    what: 'The dates stock is counted as at. Each shows as due once it has passed.',
  },
  {
    key: 'privacy.response_days', label: 'Time to answer a request for health information', group: 'Privacy', kind: 'int', min: 1, max: 365, unit: 'days', category: 'LAW', ref: 'RR-PRIVACY-001',
    what: 'When set, a new privacy request gets its due date from this.',
    waiting: 'Not set. The time limit has not been confirmed from a public official source.',
  },
  {
    key: 'retention.minimum_years', label: 'Minimum time to keep a health record', group: 'Records', kind: 'int', min: 1, max: 100, unit: 'years', category: 'REGULATION/CODE', ref: 'RR-RETENTION-001',
    what: 'When set, it is shown on the record retention screen for the privacy officer to decide against.',
    waiting: 'Not set. The retention period has not been confirmed from a public official source.',
  },
];
export const RULE_KEY = new Map(RULE_KEYS.map((k) => [k.key, k]));
export const JURISDICTION_KINDS: Record<string, string> = { COUNTRY: 'Country', STATE: 'State or region', HEALTH_SYSTEM: 'Health system' };
export const STATUS: Record<string, string> = { PROPOSED: 'Waiting for approval', ACTIVE: 'Approved', REJECTED: 'Not approved' };
export const REFS = ['ORG-SYN-001 v1', 'SHIFT-DESIGN-RULESET-001'];
