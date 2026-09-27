// Patient allocation settings (Shared Lifecycle Object 266): the shifts allocation is planned
// for, which roles take patients in each service, and the number of patients above which SHIFT
// warns. These are the synthetic organisation's own settings (ORG-SYN-001). Safe staffing
// levels are set locally (for example through Care Capacity Demand Management in Te Whatu Ora
// hospitals); SHIFT warns and never blocks on numbers.

export interface Period { id: string; label: string; start: string; end: string }
export const PERIODS: Period[] = [
  { id: 'AM', label: 'Morning', start: '07:00', end: '15:30' },
  { id: 'PM', label: 'Afternoon', start: '14:30', end: '23:00' },
  { id: 'NIGHT', label: 'Night', start: '22:45', end: '07:15' },
];
export const PERIOD_BY_ID = new Map(PERIODS.map((p) => [p.id, p]));

// Which shift a roster start time belongs to.
export function periodOf(startTime: string): string {
  const h = Number(startTime.slice(0, 2));
  return h >= 5 && h < 12 ? 'AM' : h >= 12 && h < 20 ? 'PM' : 'NIGHT';
}

// The shift running at a moment (local time), and its date (a night shift belongs to the date it starts).
export function currentPeriod(at = new Date()): { date: string; period: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const mins = at.getHours() * 60 + at.getMinutes();
  if (mins >= 7 * 60 && mins < 15 * 60) return { date: day(at), period: 'AM' };
  if (mins >= 15 * 60 && mins < 23 * 60) return { date: day(at), period: 'PM' };
  if (mins >= 23 * 60) return { date: day(at), period: 'NIGHT' };
  return { date: day(new Date(at.getTime() - 24 * 3600_000)), period: 'NIGHT' };
}

// The shift after this one.
export function nextPeriod(date: string, period: string) {
  const i = PERIODS.findIndex((p) => p.id === period);
  if (i < PERIODS.length - 1) return { date, period: PERIODS[i + 1].id };
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, period: PERIODS[0].id };
}

export const STAFF_ROLES: Record<string, { roles: string[]; warnAbove: Record<string, number> }> = {
  'svc-genmed': { roles: ['genmed-rn'], warnAbove: { 'genmed-rn': 5 } },
  'svc-arc': { roles: ['arc-rn', 'arc-caregiver'], warnAbove: { 'arc-rn': 20, 'arc-caregiver': 8 } },
  'svc-ed': { roles: ['ed-rn'], warnAbove: { 'ed-rn': 4 } },
};
