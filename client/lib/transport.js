// Server transport: same-origin JSON over HTTP. The in-browser build replaces this file
// with transport.local.js, which answers the same requests without a network.
export const localInfo = null;
export async function resetDevice() {}

export async function send(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['X-SHIFT-Request'] = '1';
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}
