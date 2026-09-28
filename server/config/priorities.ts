// Clinical priority settings (Shared Lifecycle Object 300). The emergency department uses the
// Australasian Triage Scale (ATS), with the ACEM performance thresholds as timeframes. The ward,
// rest home and physiotherapy scales and their timeframes are the synthetic organisation's own
// (ORG-SYN-001). Which scale each New Zealand setting must use, and the current ATS guidance, is a
// research requirement (RR-TRIAGE-001).

// [code, label, minutes to be seen or acted on]; most urgent first.
export const SCALES: Record<string, { label: string; levels: [string, string, number][] }> = {
  ATS: { label: 'Australasian Triage Scale', levels: [['ATS 1', 'ATS 1: immediately', 0], ['ATS 2', 'ATS 2: within 10 minutes', 10],
    ['ATS 3', 'ATS 3: within 30 minutes', 30], ['ATS 4', 'ATS 4: within 60 minutes', 60], ['ATS 5', 'ATS 5: within 120 minutes', 120]] },
  WARD: { label: 'Ward review priority', levels: [['IMMEDIATE', 'Immediate: within 15 minutes', 15], ['URGENT', 'Urgent: within 1 hour', 60],
    ['SOON', 'Soon: within 4 hours', 240], ['ROUTINE', 'Routine: within 24 hours', 1440]] },
  ARC: { label: 'Rest home review priority', levels: [['NOW', 'Now: within 1 hour', 60], ['TODAY', 'Today: within 8 hours', 480],
    ['SOON', 'Soon: within 3 days', 4320], ['ROUTINE', 'Routine: next GP visit, within 2 weeks', 20160]] },
  PHYSIO: { label: 'Physiotherapy priority', levels: [['P1', 'P1: today', 480], ['P2', 'P2: within 2 days', 2880], ['P3', 'P3: within a week', 10080]] },
};

export const SERVICE_SCALE: Record<string, string> = { 'svc-ed': 'ATS', 'svc-genmed': 'WARD', 'svc-arc': 'ARC', 'svc-physio': 'PHYSIO' };

export const SOURCES: Record<string, string> = {
  PRESENTATION: 'Arrived or presented', REQUEST: 'Asked for a review', REFERRAL: 'Referral', CHANGE: 'Change in condition',
};
