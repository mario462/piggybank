// Cloudflare Access verification.
//
// Access already blocks anyone who is not signed in before a request reaches the app.
// This is the second lock: every API call must carry a valid Access token issued for
// this app (right audience, right team, not expired, signed by Cloudflare). If Access is
// not configured yet, the API refuses everything (fails closed).

const JWKS_TTL = 60 * 60 * 1000;
let jwksCache = { url: '', at: 0, keys: [] };

export class AuthError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

export function teamOrigin(domain) {
  const host = String(domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(host)) return null;
  return 'https://' + host.toLowerCase();
}

const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function getKeys(origin, fetchImpl, now) {
  const url = origin + '/cdn-cgi/access/certs';
  if (jwksCache.url === url && now - jwksCache.at < JWKS_TTL) return jwksCache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new AuthError('could not load Access signing keys', 503);
  const { keys = [] } = await res.json();
  jwksCache = { url, at: now, keys };
  return keys;
}

export function resetKeyCache() { jwksCache = { url: '', at: 0, keys: [] }; }

function readToken(request) {
  const h = request.headers.get('Cf-Access-Jwt-Assertion');
  if (h) return h;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

function isLocal(request) {
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Returns the verified identity ({ email, sub }) or throws AuthError.
 * env: ACCESS_TEAM_DOMAIN, ACCESS_AUD, optional ALLOWED_EMAILS (comma separated),
 *      DEV_NO_AUTH="1" only honoured for requests to localhost (local development and tests).
 */
export async function verifyAccess(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (env.DEV_NO_AUTH === '1' && isLocal(request)) return { email: 'dev@localhost', sub: 'dev' };

  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN);
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!origin || !aud) throw new AuthError('Access is not configured for this app', 503);

  const token = readToken(request);
  if (!token) throw new AuthError('not signed in', 401);
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token', 401);

  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch { throw new AuthError('malformed token', 401); }
  if (header.alg !== 'RS256') throw new AuthError('unexpected token algorithm', 401);

  const keys = await getKeys(origin, fetchImpl, now);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new AuthError('unknown signing key', 401);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new AuthError('bad token signature', 401);

  const sec = Math.floor(now / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new AuthError('token is for a different app', 403);
  if (payload.iss !== origin) throw new AuthError('token is from a different team', 403);
  if (typeof payload.exp !== 'number' || payload.exp < sec) throw new AuthError('session expired', 401);
  if (typeof payload.nbf === 'number' && payload.nbf > sec + 60) throw new AuthError('token not valid yet', 401);

  const allowed = String(env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const email = String(payload.email || '').toLowerCase();
  if (allowed.length && !allowed.includes(email)) throw new AuthError('this account is not allowed', 403);

  return { email, sub: payload.sub };
}
