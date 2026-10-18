import { verifyAccess, AuthError } from './auth.js';
import { validateTransaction, validateCategory, validId, ValidationError } from './validate.js';
import * as store from './db.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const error = (status, message) => json({ error: message }, status);

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) throw new ValidationError('send JSON');
  const text = await request.text();
  if (text.length > 10_000) throw new ValidationError('request too large');
  try { return JSON.parse(text); } catch { throw new ValidationError('invalid JSON'); }
}

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  try {
    await verifyAccess(request, env, deps);
    // Writes must come from the app itself: a custom header cannot be sent by a plain
    // cross-site form or link, which blocks request forgery against the Access cookie.
    if (method !== 'GET' && request.headers.get('X-Piggybank') !== '1') return error(403, 'missing app header');
    if (!env.DB) return error(503, 'database is not connected');
    const db = env.DB;
    await store.ensureSchema(db);

    if (path === '/api/state' && method === 'GET') return json(await store.getState(db));

    if (path === '/api/transactions' && method === 'POST') {
      const tx = validateTransaction(await readJson(request));
      const known = await store.categoryIds(db, [tx.cat, tx.to].filter(Boolean));
      if (!known.has(tx.cat) || (tx.to && !known.has(tx.to))) return error(422, 'unknown category');
      const created = await store.insertTransaction(db, tx);
      return json({ ok: true, created }, created ? 201 : 200);
    }

    let m = path.match(/^\/api\/transactions\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const deleted = await store.deleteTransaction(db, validId(m[1]));
      return json({ ok: true, deleted });
    }

    if (path === '/api/categories' && method === 'POST') {
      const c = validateCategory(await readJson(request));
      const created = await store.insertCategory(db, c);
      return json({ ok: true, created }, created ? 201 : 200);
    }

    m = path.match(/^\/api\/categories\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const fields = validateCategory(await readJson(request), { partial: true });
      const updated = await store.updateCategory(db, validId(m[1]), fields);
      return updated ? json({ ok: true }) : error(404, 'category not found');
    }
    if (m && method === 'DELETE') {
      const r = await store.deleteCategory(db, validId(m[1]));
      if (r === 'in-use') return error(409, 'category has transactions');
      return r === 'deleted' ? json({ ok: true }) : error(404, 'category not found');
    }

    return error(404, 'not found');
  } catch (e) {
    if (e instanceof AuthError) return error(e.status, e.message);
    if (e instanceof ValidationError) return error(422, e.message);
    console.error(e);
    return error(500, 'server error');
  }
}
