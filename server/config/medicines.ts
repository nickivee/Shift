// Medicines in the Emergency Department, General Medicine and Residential Care (entry 11).
// What is built here follows the New Zealand law and national standards found for it (RR-MEDICINES-001,
// RR-MEDCHART-001, RR-CDREGISTER-001):
//   a prescription medicine is given only on an authorised prescriber's prescription (Medicines Act 1981,
//   Medicines Regulations 1984 regs 39 and 41), the chart carries the national chart fields and the
//   prescriber's PRN limits (HQSC Medication Charting Standard), and a controlled drug given in a ward is
//   entered in that ward's book straight after it is given, with a joint check every week and a
//   stocktake at 30 June and 31 December (Misuse of Drugs Regulations 1977 reg 44).
// What the law leaves open stays the organisation's own setting (ORG-SYN-001): the reasons for not giving
// a dose and whether a witness is used for a dose.
export const REFS = ['ORG-SYN-001 v1', 'RR-MEDICINES-001', 'RR-MEDCHART-001'];
export const CD_REFS = ['ORG-SYN-001 v1', 'RR-MEDICINES-001', 'RR-CDREGISTER-001'];

export const STATES: Record<string, string> = { ORDERED: 'Ordered', VERIFIED: 'Checked', ACTIVE: 'Current', HELD: 'Held', CEASED: 'Stopped' };
// Who may prescribe, the reasons a dose is not given, the weekly check and the stocktake dates are rules held as
// data (see ruleset.ts), so they can change and differ by jurisdiction.
