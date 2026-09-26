// Builds the in-browser edition of SHIFT into dist/: the client plus the server's domain
// code, authority service, audit and API, running over SQLite (sql.js) on the device.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const swap = {
  name: 'in-browser',
  setup(b) {
    b.onResolve({ filter: /\/transport\.js$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace('transport.js', 'transport.local.js')) }));
    b.onResolve({ filter: /\/platform\.ts$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace('platform.ts', 'platform.browser.ts')) }));
  },
};

await build({
  entryPoints: [resolve(root, 'client/app.js')],
  outfile: resolve(dist, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  plugins: [swap],
  // sql.js checks for Node modules it never uses in a browser.
  external: ['fs', 'path', 'crypto'],
  logLevel: 'info',
});

for (const f of ['index.html', 'styles.css', 'icon.svg']) cpSync(resolve(root, 'client', f), resolve(dist, f));
cpSync(resolve(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), resolve(dist, 'sql-wasm.wasm'));
