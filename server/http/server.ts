import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { HttpError } from '../lib/util.ts';
import { dispatch, type Router } from './router.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'TOO_LARGE', 'Request too large.');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON_ONLY', 'Send JSON.');
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'Malformed request.');
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}

export function startServer(opts: { router: Router; clientDir: string; port: number; host: string; trustProxy: boolean }) {
  const root = resolve(opts.clientDir);

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) file = join(root, 'index.html');
    let st = await stat(file).catch(() => null);
    if (!st || st.isDirectory()) {
      file = join(root, 'index.html');
      st = await stat(file);
    }
    const data = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'METHOD', 'Method not allowed.');
        await serveStatic(url.pathname, res);
        return;
      }
      // Cross-site request protection: every state-changing call must carry this header,
      // which a browser will not attach cross-origin without a CORS preflight we never grant.
      if (method !== 'GET' && req.headers['x-shift-request'] !== '1') throw new HttpError(403, 'CSRF', 'Request refused.');
      const secure = opts.trustProxy ? req.headers['x-forwarded-proto'] === 'https' : false;
      const out = await dispatch(opts.router, {
        method, path: url.pathname, query: url.searchParams,
        body: method === 'GET' ? {} : await readBody(req), cookies: parseCookies(req.headers.cookie), secure,
      });
      send(res, out.status, out.body, out.cookies.length ? { 'Set-Cookie': out.cookies } : {});
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, message: err.message, detail: err.detail ?? null });
      } else {
        console.error(err);
        send(res, 500, { error: 'SERVER_ERROR', message: 'Something went wrong. Nothing partial was saved.' });
      }
    }
  });
  server.listen(opts.port, opts.host);
  return server;
}
