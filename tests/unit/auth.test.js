// Security tests for the Cloudflare Access check: only tokens Cloudflare signed for
// this app, for this team, that are still valid, get through.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccess, resetKeyCache, AuthError, teamOrigin } from '../../server/auth.js';
import { handle } from '../../server/api.js';

const TEAM = 'myteam.cloudflareaccess.com';
const ISS = 'https://' + TEAM;
const AUD = 'aud-1234567890';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: 'me@example.com' };
const now = Date.UTC(2026, 9, 18, 12);
const sec = Math.floor(now / 1000);

const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
async function keypair(kid) {
  const k = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', k.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { ...k, jwk, kid };
}
async function sign(kp, payload, header = {}) {
  const head = enc({ alg: 'RS256', kid: kp.kid, typ: 'JWT', ...header });
  const body = enc(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(head + '.' + body));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const good = (o = {}) => ({ aud: [AUD], iss: ISS, email: 'me@example.com', sub: 'u1', iat: sec - 10, nbf: sec - 10, exp: sec + 3600, ...o });

let kp, other, fetchImpl, fetches;
beforeEach(async () => {
  resetKeyCache();
  kp ??= await keypair('k1');
  other ??= await keypair('k2');
  fetches = [];
  fetchImpl = async url => { fetches.push(url); return new Response(JSON.stringify({ keys: [kp.jwk] })); };
});
const req = (token, { host = 'piggybank.pages.dev', cookie, method = 'GET', headers = {} } = {}) => new Request(`https://${host}/api/state`, {
  method, headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
});
const check = (r, e = env) => verifyAccess(r, e, { fetchImpl, now });
const rejects = (p, status) => assert.rejects(p, e => e instanceof AuthError && (!status || e.status === status));

test('accepts a valid token and returns the email', async () => {
  const id = await check(req(await sign(kp, good())));
  assert.equal(id.email, 'me@example.com');
  assert.equal(fetches[0], ISS + '/cdn-cgi/access/certs');
});
test('accepts the token from the CF_Authorization cookie', async () => {
  const id = await check(req(null, { cookie: 'a=b; CF_Authorization=' + await sign(kp, good()) }));
  assert.equal(id.email, 'me@example.com');
});
test('rejects a missing token', () => rejects(check(req(null)), 401));
test('rejects garbage', () => rejects(check(req('not.a.token')), 401));
test('rejects a token signed by a different key', async () => {
  await rejects(check(req(await sign(other, good(), { kid: 'k1' }))), 401);
});
test('rejects an unknown key id', async () => rejects(check(req(await sign(other, good()))), 401));
test('rejects a tampered payload', async () => {
  const [h, , s] = (await sign(kp, good())).split('.');
  await rejects(check(req(`${h}.${enc(good({ email: 'attacker@example.com' }))}.${s}`)), 401);
});
test('rejects alg=none and HS256 tricks', async () => {
  const none = `${enc({ alg: 'none', kid: 'k1' })}.${enc(good())}.`;
  await rejects(check(req(none)), 401);
  await rejects(check(req(await sign(kp, good(), { alg: 'HS256' }))), 401);
});
test('rejects a token for another Access app', async () => rejects(check(req(await sign(kp, good({ aud: ['someone-else'] })))), 403));
test('rejects a token from another team', async () => rejects(check(req(await sign(kp, good({ iss: 'https://evil.cloudflareaccess.com' })))), 403));
test('rejects an expired token', async () => rejects(check(req(await sign(kp, good({ exp: sec - 1 })))), 401));
test('rejects a token that is not valid yet', async () => rejects(check(req(await sign(kp, good({ nbf: sec + 3600 })))), 401));
test('enforces the email allow-list when set', async () => {
  await rejects(check(req(await sign(kp, good({ email: 'friend@example.com' })))), 403);
  const id = await check(req(await sign(kp, good({ email: 'friend@example.com' }))), { ...env, ALLOWED_EMAILS: '' });
  assert.equal(id.email, 'friend@example.com');
});
test('fails closed when Access is not configured', async () => {
  const t = await sign(kp, good());
  await rejects(check(req(t), {}), 503);
  await rejects(check(req(t), { ACCESS_AUD: AUD }), 503);
  await rejects(check(req(t), { ACCESS_TEAM_DOMAIN: 'evil.example.com', ACCESS_AUD: AUD }), 503);
});
test('the dev bypass only works on localhost', async () => {
  const id = await check(req(null, { host: 'localhost:8788' }), { DEV_NO_AUTH: '1' });
  assert.equal(id.email, 'dev@localhost');
  await rejects(check(req(null), { DEV_NO_AUTH: '1' }), 503);
  await rejects(check(req(null), { ...env, DEV_NO_AUTH: '1' }), 401);
});
test('signing keys are cached between requests', async () => {
  const t = await sign(kp, good());
  await check(req(t)); await check(req(t));
  assert.equal(fetches.length, 1);
});
test('teamOrigin normalises input and rejects other hosts', () => {
  assert.equal(teamOrigin('https://MyTeam.cloudflareaccess.com/'), ISS);
  assert.equal(teamOrigin('myteam.cloudflareaccess.com'), ISS);
  assert.equal(teamOrigin('myteam.cloudflareaccess.com.evil.com'), null);
  assert.equal(teamOrigin(''), null);
});

test('API: unauthenticated requests get no data', async () => {
  const res = await handle(req(null), { ...env, DB: {} }, { fetchImpl, now });
  assert.equal(res.status, 401);
  assert.deepEqual(Object.keys(await res.json()), ['error']);
});
test('API: writes without the app header are refused (request forgery)', async () => {
  const t = await sign(kp, good());
  const res = await handle(req(t, { method: 'POST' }), { ...env, DB: {} }, { fetchImpl, now });
  assert.equal(res.status, 403);
});
test('API: unconfigured Access returns 503, never data', async () => {
  const res = await handle(req(null), { DB: {} }, { fetchImpl, now });
  assert.equal(res.status, 503);
});
