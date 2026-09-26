// All calls are same-origin JSON. Mutations carry the X-SHIFT-Request header the server
// requires, so a cross-site page cannot trigger them.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? 'Request failed');
    this.status = status;
    this.code = body?.error;
    this.detail = body?.detail;
  }
}

let onSignedOut = () => {};
export function setSignedOutHandler(fn) { onSignedOut = fn; }

export async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['X-SHIFT-Request'] = '1';
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, { error: 'OFFLINE', message: 'SHIFT cannot reach the server. Nothing was saved.' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') onSignedOut();
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export function requestKey() {
  return crypto.randomUUID();
}
