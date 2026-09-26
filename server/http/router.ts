import { HttpError } from '../lib/util.ts';

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  cookies: Record<string, string>;
  secure: boolean;
}

// Handlers return plain data. A handler that needs to set cookies or a status returns a Reply.
export class Reply {
  readonly body: unknown;
  readonly status: number;
  readonly cookies: string[];
  constructor(body: unknown, opts: { status?: number; cookies?: string[] } = {}) {
    this.body = body;
    this.status = opts.status ?? 200;
    this.cookies = opts.cookies ?? [];
  }
}

export type Handler = (req: Request) => unknown;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; }) + '$',
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null | 'METHOD' {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'METHOD' : null;
  }
}

export interface Outcome {
  status: number;
  body: unknown;
  cookies: string[];
}

// Runs one API request through the router. Shared by the HTTP server and the in-browser
// build, so both give identical answers, errors and audit.
export async function dispatch(router: Router, req: Omit<Request, 'params'>): Promise<Outcome> {
  try {
    const found = router.match(req.method, req.path);
    if (found === null) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    if (found === 'METHOD') throw new HttpError(405, 'METHOD', 'Method not allowed.');
    const out = await found.handler({ ...req, params: found.params });
    const reply = out instanceof Reply ? out : new Reply(out);
    return { status: reply.status, body: reply.body === undefined ? { ok: true } : reply.body, cookies: reply.cookies };
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: err.code, message: err.message, detail: err.detail ?? null }, cookies: [] };
    }
    console.error(err);
    return { status: 500, body: { error: 'SERVER_ERROR', message: 'Something went wrong. Nothing partial was saved.' }, cookies: [] };
  }
}
