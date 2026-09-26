import { resolve } from 'node:path';
import { openNodeStore } from './db/node.ts';
import { buildApi } from './http/api.ts';
import { startServer } from './http/server.ts';
import { audit, verifyChain } from './domain/audit.ts';

const root = resolve(import.meta.dirname, '..');
const dbFile = process.env.SHIFT_DB ?? resolve(root, 'var/shift.db');
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';

const store = openNodeStore(dbFile);
const chain = verifyChain(store);
if (!chain.ok) {
  console.error(`Audit chain integrity failure at entry ${chain.brokenAt}. Refusing to start.`);
  process.exit(1);
}
if (!store.get('SELECT 1 FROM workforce_person LIMIT 1')) {
  console.log('No workforce is loaded yet. Run `npm run seed` to load the synthetic data set.');
}
audit(store, { space: 'SYSTEM', operation: 'START', outcome: 'COMMITTED', reason: `audit entries verified: ${chain.entries}` });

const server = startServer({
  router: buildApi(store),
  clientDir: resolve(root, 'client'),
  port,
  host,
  trustProxy: process.env.SHIFT_TRUST_PROXY === '1',
});
server.on('listening', () => console.log(`SHIFT is running at http://${host}:${port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
