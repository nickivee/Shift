// SHIFT running entirely inside the browser: the same domain code, authority service,
// audit and API router as the server, over SQLite compiled to WebAssembly. The database is
// kept in this browser's IndexedDB, so each device holds its own copy of the synthetic data.
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { openSqlJsStore } from './db/sqljs.ts';
import { buildApi } from './http/api.ts';
import { dispatch, type Router } from './http/router.ts';
import { audit, verifyChain } from './domain/audit.ts';
import { loadSynthetic, SYNTHETIC_USERS } from './data/synthetic.ts';

export const LOCAL_PASSWORD = 'kowhai';
const IDB = { name: 'shift', store: 'db', key: 'main' };
const TOKEN_KEY = 'shift_session';

let booted: Promise<{ db: Database; router: Router }> | null = null;

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB.name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB.store);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(IDB.store, mode);
      const req = fn(tx.objectStore(IDB.store));
      tx.oncomplete = () => { open.result.close(); resolve(req.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}

async function boot() {
  const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
  const saved = await idb<Uint8Array | undefined>('readonly', (s) => s.get(IDB.key)).catch(() => undefined);
  const db = saved ? new SQL.Database(saved) : new SQL.Database();
  const store = openSqlJsStore(db);
  if (!store.get('SELECT 1 FROM workforce_person LIMIT 1')) loadSynthetic(store, LOCAL_PASSWORD);
  const chain = verifyChain(store);
  if (!chain.ok) throw new Error(`Audit chain integrity failure at entry ${chain.brokenAt}.`);
  audit(store, { space: 'SYSTEM', operation: 'START', outcome: 'COMMITTED', reason: `in-browser; audit entries verified: ${chain.entries}` });
  await save(db);
  return { db, router: buildApi(store) };
}

async function save(db: Database): Promise<void> {
  const bytes = db.export();
  db.exec('PRAGMA foreign_keys = ON;');
  await idb('readwrite', (s) => s.put(bytes, IDB.key));
}

function readToken(): string | undefined {
  try { return localStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; }
}

function applyCookies(cookies: string[]): void {
  for (const c of cookies) {
    const m = /^shift_session=([^;]*);.*Max-Age=(\d+)/.exec(c);
    if (!m) continue;
    try {
      if (m[1] && m[2] !== '0') localStorage.setItem(TOKEN_KEY, m[1]);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* storage unavailable: session lasts for this page only */ }
  }
}

// Requests are handled one at a time so every change is saved before the next begins.
let queue: Promise<unknown> = Promise.resolve();

export function handle(method: string, url: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
  const run = async () => {
    booted ??= boot();
    const { db, router } = await booted;
    const u = new URL(url, 'http://local');
    const out = await dispatch(router, {
      method, path: u.pathname, query: u.searchParams, body, cookies: { shift_session: readToken() ?? '' }, secure: false,
    });
    applyCookies(out.cookies);
    await save(db);
    return { status: out.status, body: out.body };
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export async function resetDevice(): Promise<void> {
  await queue;
  booted = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  await idb('readwrite', (s) => s.delete(IDB.key));
}

export const localInfo = { password: LOCAL_PASSWORD, users: SYNTHETIC_USERS };
