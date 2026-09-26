// Browser implementation of platform.ts (same exports), used when SHIFT runs entirely in
// the browser. Hashing is synchronous so the domain code is identical on both platforms.
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { scrypt } from '@noble/hashes/scrypt';

const bytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

export const newId = (): string => crypto.randomUUID();
export const token = (): string => b64(bytes(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomSecret = (): string => token().slice(0, 12);
export const sha256 = (s: string): string => hex(nobleSha256(new TextEncoder().encode(s)));

// Lower cost than the server so sign-in stays quick on phones; the cost is stored with
// each hash, so either platform can verify the other's hashes.
const N = 4096;

export function hashPassword(password: string): string {
  const salt = bytes(16);
  const hash = scrypt(password, salt, { N, r: 8, p: 1, dkLen: 64 });
  return `scrypt$${N}$${b64(salt)}$${b64(hash)}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = unb64(hash);
  const actual = scrypt(password, unb64(salt), { N: Number(n), r: 8, p: 1, dkLen: expected.length });
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0 && actual.length === expected.length;
}
