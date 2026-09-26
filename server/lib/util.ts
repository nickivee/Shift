import { randomUUID, randomBytes, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();
export const now = (): string => new Date().toISOString();
export const token = (): string => randomBytes(32).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function todayLocal(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
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
