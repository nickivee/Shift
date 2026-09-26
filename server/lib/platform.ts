// Platform primitives for the Node server. The browser build swaps this file for
// platform.browser.ts, which provides the same functions with Web Crypto and @noble/hashes.
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export const newId = (): string => randomUUID();
export const token = (): string => randomBytes(32).toString('base64url');
export const randomSecret = (): string => randomBytes(9).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1, maxmem: 256 * Number(n) * 8 * 2 });
  return timingSafeEqual(actual, expected);
}
