import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { matches } from './http.js';
import { tokenHash } from './enrollment.js';

const derive = promisify(scrypt);
export const inviteLifetime = 24 * 60 * 60 * 1000;

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || !password.trim()) {
    throw new Error('Choose a password between 12 and 128 characters.');
  }
}

export async function passwordRecord(password) {
  checkPassword(password);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32);
  return { salt, key: key.toString('hex') };
}

export async function verifyPassword(password, account) {
  if (!account || typeof password !== 'string' || !password || password.length > 1024) return false;
  if (account.password) {
    const key = await derive(password, account.password.salt, 32);
    return matches(key.toString('hex'), account.password.key);
  }
  return typeof account.hash === 'string' && matches(tokenHash(password), account.hash);
}

export function invitationMatches(account, code, now = Date.now()) {
  return !!account && typeof code === 'string' && code.length <= 128 &&
    typeof account.inviteHash === 'string' && account.inviteUntil > now && matches(tokenHash(code), account.inviteHash);
}
