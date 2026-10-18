// Pure ledger math. Shared by the app and the unit tests; no DOM, no I/O.
// Money is always integer cents. Balances are derived by replaying transactions.

export const TYPES = ['add', 'withdraw', 'transfer'];

export function sortTxs(txs) {
  return txs.slice().sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function applyTx(b, t) {
  if (t.type === 'add') b[t.cat] = (b[t.cat] ?? 0) + t.amount;
  else if (t.type === 'withdraw') b[t.cat] = (b[t.cat] ?? 0) - t.amount;
  else if (t.type === 'transfer') {
    b[t.cat] = (b[t.cat] ?? 0) - t.amount;
    b[t.to] = (b[t.to] ?? 0) + t.amount;
  }
}

export function balances(cats, txs) {
  const b = Object.fromEntries(cats.map(c => [c.id, 0]));
  for (const t of txs) applyTx(b, t);
  return b;
}

// Remove a category and its history. Moves between it and other categories become deposits to or withdrawals
// from those categories, so their balances stay the same. Mirrors deleteCategory() in server/db.js.
export function dropCategory(cats, txs, id) {
  const name = cats.find(c => c.id === id)?.name ?? 'a deleted category';
  const tag = (note, s) => (note ? `${note} · ${s.toLowerCase()} ${name}` : `${s} ${name}`).slice(0, 200);
  return {
    cats: cats.filter(c => c.id !== id),
    txs: txs.flatMap(t => t.type === 'transfer' && t.cat === id ? [{ ...t, type: 'add', cat: t.to, to: null, note: tag(t.note, 'From') }]
      : t.type === 'transfer' && t.to === id ? [{ ...t, type: 'withdraw', to: null, note: tag(t.note, 'To') }]
      : t.cat === id ? [] : [t]),
  };
}

export const total = b => Object.values(b).reduce((a, v) => a + v, 0);
export const borrowed = b => Object.values(b).reduce((a, v) => a + Math.min(0, v), 0);

// Balance after each transaction, for the whole bank or one category.
export function series(cats, txs, catId) {
  const b = Object.fromEntries(cats.map(c => [c.id, 0]));
  const out = [];
  for (const t of sortTxs(txs)) {
    applyTx(b, t);
    if (!catId) out.push({ t: t.t, v: total(b) });
    else if (t.cat === catId || t.to === catId) out.push({ t: t.t, v: b[catId] ?? 0 });
  }
  return out;
}

// Net money in/out over a window (transfers are internal, so they do not count).
export function netSince(txs, since) {
  return txs.filter(t => t.t >= since)
    .reduce((a, t) => a + (t.type === 'add' ? t.amount : t.type === 'withdraw' ? -t.amount : 0), 0);
}

export function fmt(c, opts = {}) {
  const n = Math.abs(c) / 100;
  const digits = opts.whole ? 0 : 2;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (c < 0 ? '−' : opts.sign && c > 0 ? '+' : '') + '$' + s;
}

// "12", "12.5", "1,250.75", "$40" -> cents. Returns 0 for anything unusable.
// A comma with at most two digits after it, at the end, is a decimal point: "12,50" is 12.50. iOS's decimal keypad types
// a comma there in regions that write decimals that way. A thousands comma always has three digits after it ("1,250").
export function parseAmount(str) {
  let s = String(str ?? '').replace(/[$\s]/g, '');
  if (/,\d{0,2}$/.test(s)) s = s.replace(/\./g, '').replace(/,(?=\d{0,2}$)/, '.');
  s = s.replace(/,/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return 0;
  const [whole, frac = ''] = s.split('.');
  return Number(whole || 0) * 100 + Number((frac + '00').slice(0, 2));
}

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
