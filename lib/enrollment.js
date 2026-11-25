import { createHash, randomBytes } from 'node:crypto';
import { matches } from './http.js';

export function newCredential() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function kioskAuthorized(authorization, device, demoToken) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  if (device?.credential) {
    const { hash } = device.credential;
    return typeof hash === 'string' && matches(tokenHash(authorization.slice(7)), hash);
  }
  return !!demoToken && matches(authorization, `Bearer ${demoToken}`);
}

export function enrollmentState(device) {
  if (!device.credential) return 'shared';
  return device.credential.hash ? 'enrolled' : 'revoked';
}

export function recordEvent(state, action, kioskId, actor = 'admin') {
  state.events.push({ action, kioskId: kioskId ?? null, actor, at: Date.now() });
  state.events = state.events.slice(-100);
}
