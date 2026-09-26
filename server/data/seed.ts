// Command-line loader: replaces the local database with a fresh synthetic data set.
import { resolve } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { openNodeStore } from '../db/node.ts';
import { randomSecret } from '../lib/platform.ts';
import { loadSynthetic, SYNTHETIC_USERS } from './synthetic.ts';

const root = resolve(import.meta.dirname, '../..');
const dbFile = process.env.SHIFT_DB ?? resolve(root, 'var/shift.db');
const reset = process.argv.includes('--reset');

if (existsSync(dbFile)) {
  if (!reset) {
    console.error(`${dbFile} already exists. Use \`npm run seed -- --reset\` to replace it with a fresh synthetic data set.`);
    process.exit(1);
  }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true });
}

const password = process.env.SHIFT_SEED_PASSWORD ?? randomSecret();
loadSynthetic(openNodeStore(dbFile), password);

console.log(`Synthetic data loaded into ${dbFile}`);
console.log(`Workforce usernames: ${SYNTHETIC_USERS.map((u) => u.username).join(', ')}`);
if (!process.env.SHIFT_SEED_PASSWORD) console.log(`Password for all synthetic workforce accounts (shown once): ${password}`);
