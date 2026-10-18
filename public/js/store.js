// Local-first state with an outbox that syncs to the API.
// Every change is applied on the phone immediately, saved to localStorage, and queued.
// The queue is sent in order whenever we are online; the server ignores duplicates by id.

import { sortTxs, newId, dropCategory } from './ledger.js';

const STATE_KEY = 'pb:state';
const OUTBOX_KEY = 'pb:outbox';

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

export class ApiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'X-Piggybank': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      redirect: 'manual', // an expired Access session answers with a redirect to the login page
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('offline', 'You are offline');
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || (res.status >= 300 && res.status < 400)) throw new ApiError('signin', 'Sign in again to sync');
  const data = await res.json().catch(() => ({}));
  if (res.status === 503) throw new ApiError('config', data.error || 'The server is not set up yet');
  if (res.status === 403) throw new ApiError('signin', data.error || 'Not allowed');
  if (res.status >= 500) throw new ApiError('offline', data.error || 'Server error, will retry');
  if (!res.ok) throw new ApiError('rejected', data.error || 'The server rejected a change');
  return data;
}

// Apply one queued operation to a state object (used both on change and to replay
// pending operations on top of fresh server data).
export function applyOp(state, op) {
  switch (op.kind) {
    case 'tx': if (!state.txs.some(t => t.id === op.body.id)) state.txs.push({ ...op.body }); break;
    case 'deltx': state.txs = state.txs.filter(t => t.id !== op.id); break;
    case 'cat': if (!state.cats.some(c => c.id === op.body.id)) state.cats.push({ ...op.body }); break;
    case 'patchcat': state.cats = state.cats.map(c => c.id === op.id ? { ...c, ...op.body } : c); break;
    case 'delcat': Object.assign(state, dropCategory(state.cats, state.txs, op.id)); break;
  }
  state.txs = sortTxs(state.txs);
  return state;
}

const REQUESTS = {
  tx: op => ['POST', '/api/transactions', op.body],
  deltx: op => ['DELETE', '/api/transactions/' + op.id],
  cat: op => ['POST', '/api/categories', op.body],
  patchcat: op => ['PATCH', '/api/categories/' + op.id, op.body],
  delcat: op => ['DELETE', '/api/categories/' + op.id],
};

export function createStore({ request = api } = {}) {
  const saved = read(STATE_KEY, null);
  const s = {
    cats: saved?.cats ?? [],
    txs: sortTxs(saved?.txs ?? []),
    loaded: !!saved,           // true once we have server data (or a cached copy of it)
    outbox: read(OUTBOX_KEY, []),
    status: 'idle',            // idle | syncing | synced | offline | signin | config
    message: '',
  };
  const listeners = new Set();
  const emit = ev => listeners.forEach(f => f(ev));
  const persist = () => { write(STATE_KEY, { cats: s.cats, txs: s.txs }); write(OUTBOX_KEY, s.outbox); };
  let flushing = null;

  function queue(op, ev) {
    applyOp(s, op);
    s.outbox.push(op);
    persist();
    emit(ev);
    flush();
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      setStatus('syncing');
      let rejected = null;
      try {
        while (s.outbox.length) {
          const op = s.outbox[0];
          try { await request(...REQUESTS[op.kind](op)); }
          catch (e) {
            if (e.kind !== 'rejected') throw e;
            rejected = e.message; // drop it; the refresh below restores the server's truth
          }
          s.outbox.shift();
          persist();
        }
        const data = await request('GET', '/api/state');
        const next = { cats: data.categories, txs: data.transactions };
        s.outbox.forEach(op => applyOp(next, op));
        s.cats = next.cats; s.txs = sortTxs(next.txs); s.loaded = true;
        persist();
        setStatus('synced');
        emit({ type: 'sync' });
        if (rejected) emit({ type: 'error', message: rejected });
      } catch (e) {
        setStatus(e.kind || 'offline', e.message);
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function setStatus(status, message = '') {
    if (s.status === status && s.message === message) return;
    s.status = status; s.message = message;
    emit({ type: 'status' });
  }

  return {
    get cats() { return s.cats; },
    get txs() { return s.txs; },
    get loaded() { return s.loaded; },
    get status() { return s.status; },
    get message() { return s.message; },
    get pending() { return s.outbox.length; },
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    flush,
    cat: id => s.cats.find(c => c.id === id),
    addTx({ type, cat, to = null, amount, note = '' }) {
      const tx = { id: newId(), type, cat, to: type === 'transfer' ? to : null, amount, note, t: Date.now() };
      queue({ kind: 'tx', body: tx }, { type: 'tx', tx });
      return tx;
    },
    undoTx(id) {
      // never sent? just drop it from the queue
      // (unless it is the one being sent right now)
      const i = s.outbox.findIndex(op => op.kind === 'tx' && op.body.id === id);
      if (i > 0 || (i === 0 && !flushing)) {
        s.outbox.splice(i, 1);
        applyOp(s, { kind: 'deltx', id });
        persist(); emit({ type: 'undo', id });
        return;
      }
      queue({ kind: 'deltx', id }, { type: 'undo', id });
    },
    addCategory({ name, color, goal }) {
      const c = { id: newId(), name, color, goal };
      queue({ kind: 'cat', body: c }, { type: 'cat', cat: c });
      return c;
    },
    updateCategory(id, body) { queue({ kind: 'patchcat', id, body }, { type: 'cat' }); },
    deleteCategory(id) { queue({ kind: 'delcat', id }, { type: 'cat' }); },
  };
}
