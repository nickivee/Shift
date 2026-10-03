export { newId, token, sha256 } from './platform.ts';

export const now = (): string => new Date().toISOString();

export function todayLocal(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayLocal(d);
}

// A date this many weekdays on. Public holidays are not taken off, so the date can be a little earlier than the law's own count.
export function addWeekdays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return todayLocal(d);
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
