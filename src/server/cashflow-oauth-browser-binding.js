import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { unauthorized } from './cashflow-user-utils.js';

const hash = value => createHash('sha256').update(value).digest('hex');
export const oauthCookieName = (state, secure = false) => `${secure ? "__Host-" : ""}cashflow_oauth_${hash(state).slice(0, 32)}`;
export const newOAuthBrowserSecret = () => randomBytes(32).toString('base64url');

/** The state stored with PKCE commits to a browser-held secret. A linking
 * commitment additionally includes the exact initiating browser session token.
 * No process-local key or schema migration is needed across server replicas. */
export function browserBoundOAuthState({ secret, session = '', linking = false } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret || '') || (linking && !session)) throw unauthorized('Browser authentication transaction required');
  return `${linking ? 'link' : 'login'}.${hash(`${secret}:${linking ? session : ''}`)}.${newOAuthBrowserSecret()}`;
}

export function verifyOAuthBrowserBinding(state, { secret, session = '' } = {}) {
  const parts = String(state).split('.');
  if (parts.length !== 3 || !['login', 'link'].includes(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])
    || !/^[A-Za-z0-9_-]{43}$/.test(secret || '') || (parts[0] === 'link' && !session)) throw unauthorized('Browser authentication transaction required');
  const expected = hash(`${secret}:${parts[0] === 'link' ? session : ''}`);
  if (!timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) throw unauthorized('Browser authentication transaction does not match');
}
