// In-browser transport: requests go to SHIFT's own domain code running on this device.
import { handle, localInfo as info, resetDevice as reset } from '../../server/browser.ts';

export const localInfo = info;
export const resetDevice = reset;
export const send = (method, path, body) => handle(method, path, body ?? {});
