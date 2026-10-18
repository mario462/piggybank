import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';

// a fake API holding the server's state; no localStorage in node, so the store starts empty
function server(state = { categories: [], transactions: [] }) {
  return async (method, path, body) => {
    if (method === 'GET') return structuredClone(state);
    if (path === '/api/categories') state.categories.push(body);
    if (path === '/api/transactions') state.transactions.push(body);
    return { ok: true };
  };
}
const syncs = store => { const seen = []; store.on(ev => { if (ev.type === 'sync') seen.push(ev); }); return seen; };

test('a refresh that brings nothing new does not ask the screen to redraw', async () => {
  const store = createStore({ request: server({ categories: [{ id: 'cat0000001', name: 'A', color: '#7c9cff', goal: 0 }], transactions: [] }) });
  const seen = syncs(store);
  await store.flush();
  assert.equal(seen.length, 1, 'the first load redraws');
  await store.flush();
  await store.flush();
  assert.equal(seen.length, 1, 'later refreshes with the same data do not');
  assert.equal(store.status, 'synced');
});

test('a refresh redraws after sending changes, or when the server has something new', async () => {
  const state = { categories: [{ id: 'cat0000001', name: 'A', color: '#7c9cff', goal: 0 }], transactions: [] };
  const store = createStore({ request: server(state) });
  await store.flush();
  const seen = syncs(store);
  store.addTx({ type: 'add', cat: 'cat0000001', amount: 500 });
  await store.flush();
  assert.equal(seen.length, 1, 'sent a change: redraw so it no longer shows as pending');
  state.transactions.push({ id: 'fromphone2', type: 'add', cat: 'cat0000001', to: null, amount: 100, note: '', t: Date.now() });
  await store.flush();
  assert.equal(seen.length, 2, 'new data from elsewhere');
});
