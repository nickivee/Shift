import { send } from './transport.js';
export { localInfo, resetDevice } from './transport.js';

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
  let res;
  try {
    res = await send(method, path, body);
  } catch {
    throw new ApiError(0, { error: 'OFFLINE', message: 'SHIFT could not be reached. Nothing was saved.' });
  }
  if (res.status >= 400) {
    if (res.status === 401 && path !== '/api/auth/login') onSignedOut();
    throw new ApiError(res.status, res.body);
  }
  return res.body;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export function requestKey() {
  return crypto.randomUUID();
}
