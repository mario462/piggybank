import { balances, total, borrowed, series, netSince, fmt, parseAmount } from './ledger.js';
import { createStore } from './store.js';

const COLORS = ['#7C9CFF', '#5EC4B6', '#B79CFF', '#E0A458', '#E57A7A', '#D98BB5', '#8FBF7F', '#6FB7D9'];
const DAY = 864e5;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = createStore();
const $ = s => document.querySelector(s);

// ---- tiny DOM helper ----
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}
const svg = markup => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };

function money(el, c) {
  const s = fmt(c), i = s.lastIndexOf('.');
  el.replaceChildren(s.slice(0, i), h('small', {}, s.slice(i)));
}
function countUp(el, from, to) {
  if (reduced || from === to) return money(el, to);
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - k, 3);
    money(el, Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- chart: step line, since a balance holds until the next transaction ----
function chartSVG(points, w, hgt, color = 'var(--ink)') {
  if (points.length < 2) return '';
  const t0 = points[0].t, t1 = points.at(-1).t, vs = points.map(p => p.v);
  const min = Math.min(0, ...vs), max = Math.max(1, ...vs), pad = 2;
  const X = t => pad + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (w - pad * 2);
  const Y = v => hgt - pad - (v - min) / (max - min || 1) * (hgt - pad * 2);
  const pts = [];
  points.forEach((p, i) => { if (i) pts.push([X(p.t), Y(points[i - 1].v)]); pts.push([X(p.t), Y(p.v)]); });
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const area = `${line}L${pts.at(-1)[0].toFixed(1)} ${hgt - pad}L${pts[0][0].toFixed(1)} ${hgt - pad}Z`;
  const id = 'g' + Math.random().toString(36).slice(2, 7), last = pts.at(-1);
  return `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".14"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${min < 0 ? `<line x1="0" x2="${w}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--faint)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>` : ''}
    <path d="${area}" fill="url(#${id})"/>
    <path class="ln" d="${line}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="${color}"/></svg>`;
}
// full history, extended to today so the line reaches the right edge
const chartPoints = catId => {
  const s = series(store.cats, store.txs, catId);
  if (!s.length) return [];
  return [{ t: s[0].t, v: 0 }, ...s, { t: Math.max(Date.now(), s.at(-1).t + 1), v: s.at(-1).v }];
};
function drawLine(el) {
  const ln = el.querySelector('.ln'); if (!ln || reduced) return;
  const L = ln.getTotalLength(); ln.style.strokeDasharray = L; ln.style.strokeDashoffset = L;
  ln.getBoundingClientRect(); ln.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)'; ln.style.strokeDashoffset = 0;
}

// ---- history list ----
function dayLabel(t) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(t).setHours(0, 0, 0, 0)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: diff > 300 ? 'numeric' : undefined });
}
function renderHistory(el, { catId, type = 'all', limit } = {}) {
  let txs = store.txs.slice().reverse();
  if (catId) txs = txs.filter(t => t.cat === catId || t.to === catId);
  if (type !== 'all') txs = txs.filter(t => t.type === type);
  if (limit) txs = txs.slice(0, limit);
  el.replaceChildren();
  if (!txs.length) { el.append(h('p', { class: 'none' }, 'No transactions yet.')); return; }
  const pendingIds = new Set(store.pending ? pendingTxIds() : []);
  let last = '';
  for (const t of txs) {
    const lbl = dayLabel(t.t);
    if (lbl !== last) { el.append(h('div', { class: 'day' }, lbl)); last = lbl; }
    const a = store.cat(t.cat) || { name: 'Deleted', color: '#55555b' }, b = t.to && (store.cat(t.to) || { name: 'Deleted', color: '#55555b' });
    const incoming = t.type === 'add' || (t.type === 'transfer' && catId === t.to);
    const isMove = t.type === 'transfer' && !catId;
    const verb = { add: 'Deposit', withdraw: 'Withdrawal', transfer: 'Move' }[t.type];
    el.append(h('div', { class: 'tx' + (pendingIds.has(t.id) ? ' pending' : '') },
      h('span', { class: 'tx-ic', style: `--c:${(incoming && b) ? b.color : a.color}` }, t.type === 'transfer' ? '⇄' : a.name[0]),
      h('span', { class: 'tx-main' }, h('b', {}, t.type === 'transfer' ? `${a.name} → ${b.name}` : a.name), h('small', {}, verb + (t.note ? ' · ' + t.note : ''))),
      h('span', { class: 'tx-amt ' + (isMove ? 'move' : incoming ? 'in' : 'out') }, isMove ? fmt(t.amount) : (incoming ? '+' : '−') + fmt(t.amount))));
  }
}
function pendingTxIds() {
  try { return JSON.parse(localStorage.getItem('pb:outbox') || '[]').filter(o => o.kind === 'tx').map(o => o.body.id); } catch { return []; }
}

// ---- sheets ----
let openSheet = null;
function closeSheet() {
  if (!openSheet) return;
  const s = openSheet; openSheet = null;
  // while it animates out, hide the closing sheet from input and assistive tech, and free its ids for the next sheet
  s.inert = true; s.setAttribute('aria-hidden', 'true');
  s.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  s.classList.remove('open');
  setTimeout(() => s.remove(), 320);
}
function sheet(content, label) {
  closeSheet();
  const wrap = h('div', { class: 'sheet-wrap' },
    h('div', { class: 'backdrop', onclick: closeSheet }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, h('div', { class: 'grab' }), content));
  $('.app').append(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  openSheet = wrap;
  return wrap;
}
addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function openTx(type = 'add', o = {}) {
  if (!store.cats.length) return openCategory();
  const sel = { type, a: o.cat || null, b: o.to || null };
  const amt = h('input', { id: 'amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount' });
  const note = h('input', { id: 'note', class: 'field', placeholder: 'Note (optional)', autocomplete: 'off', maxlength: '200' });
  const seg = h('div', { class: 'seg', role: 'tablist' });
  const labA = h('div', { class: 'flabel' }), labB = h('div', { class: 'flabel' }, 'To');
  const rowA = h('div', { class: 'chips' }), rowB = h('div', { class: 'chips' });
  const hint = h('div', { class: 'hint' });
  const go = h('button', { class: 'go', id: 'go', onclick: submit });
  const size = () => { amt.style.width = Math.max(1, amt.value.length) + 0.6 + 'ch'; };
  const quick = h('div', { class: 'quick' }, [10, 25, 50, 100].map(v => h('button', {
    onclick: () => { amt.value = String((parseAmount(amt.value) + v * 100) / 100); size(); update(); },
  }, '+' + v)));
  const cents = () => parseAmount(amt.value);

  function chips(row, key, other) {
    const b = balances(store.cats, store.txs);
    row.replaceChildren(...store.cats.map(c => h('button', {
      class: 'chip' + (sel[key] === c.id ? ' on' : '') + (other === c.id ? ' dim' : ''), style: `--c:${c.color}`,
      onclick: () => { sel[key] = c.id; if (key === 'a' && sel.b === c.id) sel.b = null; update(); },
    }, h('i', { class: 'dot' }), h('span', { class: 'chip-t' }, h('b', {}, c.name), h('small', {}, fmt(b[c.id], { whole: true }))))));
    row.querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  function update() {
    seg.replaceChildren(...[['add', 'Add'], ['withdraw', 'Withdraw'], ['transfer', 'Move']].map(([k, l]) =>
      h('button', { class: sel.type === k ? 'on' : '', role: 'tab', 'aria-selected': String(sel.type === k), onclick: () => { sel.type = k; update(); } }, l)));
    labA.textContent = sel.type === 'add' ? 'Into' : 'From';
    chips(rowA, 'a', sel.type === 'transfer' ? sel.b : null);
    labB.hidden = rowB.hidden = sel.type !== 'transfer';
    if (sel.type === 'transfer') chips(rowB, 'b', sel.a);
    const c = cents(), A = sel.a && store.cat(sel.a), B = sel.b && store.cat(sel.b), b = balances(store.cats, store.txs);
    hint.textContent = ''; hint.className = 'hint';
    if (A && c && sel.type !== 'add' && b[A.id] - c < 0) {
      hint.textContent = `${A.name} will be at ${fmt(b[A.id] - c)}, borrowed from yourself.`; hint.className = 'hint warn';
    } else if (A && c && sel.type === 'add' && A.goal && b[A.id] < A.goal && b[A.id] + c >= A.goal) {
      hint.textContent = `This reaches the ${fmt(A.goal, { whole: true })} goal.`; hint.className = 'hint good';
    }
    const ok = c > 0 && A && (sel.type !== 'transfer' || (B && B.id !== A.id));
    go.disabled = !ok;
    go.textContent = !c ? 'Enter an amount' : !A ? 'Pick a category' : sel.type === 'transfer' && !B ? 'Pick where it goes'
      : sel.type === 'add' ? `Add ${fmt(c)} to ${A.name}` : sel.type === 'withdraw' ? `Withdraw ${fmt(c)} from ${A.name}` : `Move ${fmt(c)} to ${B.name}`;
  }
  function submit() {
    if (go.disabled) return;
    const tx = store.addTx({ type: sel.type, cat: sel.a, to: sel.b, amount: cents(), note: note.value.trim() });
    closeSheet();
    toast(describe(tx), () => store.undoTx(tx.id));
  }
  amt.addEventListener('input', () => { size(); update(); });
  amt.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  sheet(h('div', { class: 'form' }, seg, h('div', { class: 'amount' }, h('span', {}, '$'), amt), quick, labA, rowA, labB, rowB, note, hint, go), 'New transaction');
  update();
  setTimeout(() => amt.focus({ preventScroll: true }), 350);
}
function describe(t) {
  const a = store.cat(t.cat), b = t.to && store.cat(t.to);
  if (t.type === 'add') return `Added ${fmt(t.amount)} to ${a.name}`;
  if (t.type === 'withdraw') return `Withdrew ${fmt(t.amount)} from ${a.name}`;
  return `Moved ${fmt(t.amount)} to ${b.name}`;
}

function openCategory(id) {
  const existing = id && store.cat(id);
  let color = existing?.color || COLORS[store.cats.length % COLORS.length];
  const name = h('input', { id: 'cname', class: 'field', placeholder: 'What are you saving for?', autocomplete: 'off', maxlength: '60', value: existing?.name || '' });
  const goal = h('input', { id: 'cgoal', class: 'field', inputmode: 'decimal', placeholder: 'Goal, e.g. 450', autocomplete: 'off', value: existing?.goal ? String(existing.goal / 100) : '' });
  const swatches = h('div', { class: 'swatches' });
  const go = h('button', { class: 'go', id: 'csave' }, existing ? 'Save' : 'Create category');
  const draw = () => {
    swatches.replaceChildren(...COLORS.map(c => h('button', { class: 'sw' + (c === color ? ' on' : ''), style: `--c:${c}`, 'aria-label': 'Colour ' + c, onclick: () => { color = c; draw(); } })));
    go.disabled = !name.value.trim();
  };
  name.addEventListener('input', draw);
  go.addEventListener('click', () => {
    const fields = { name: name.value.trim().slice(0, 60), color, goal: parseAmount(goal.value) };
    if (!fields.name) return;
    if (existing) store.updateCategory(id, fields); else store.addCategory(fields);
    closeSheet();
  });
  const used = existing && store.txs.some(t => t.cat === id || t.to === id);
  const del = existing && !used ? h('button', { class: 'go danger', onclick: () => { store.deleteCategory(id); closeSheet(); } }, 'Delete category') : null;
  sheet(h('div', { class: 'form' }, h('h3', { class: 'sheet-title' }, existing ? 'Edit category' : 'New category'),
    name, goal, h('div', { class: 'flabel' }, 'Colour'), swatches, go, del,
    existing && used ? h('p', { class: 'hint' }, 'Categories with history can’t be deleted.') : null), existing ? 'Edit category' : 'New category');
  draw();
  setTimeout(() => name.focus({ preventScroll: true }), 350);
}

function openDetail(id) {
  const c = store.cat(id); if (!c) return;
  const v = balances(store.cats, store.txs)[id], pct = c.goal ? Math.max(0, Math.min(100, v / c.goal * 100)) : 0;
  const big = h('div', { class: 'total' + (v < 0 ? ' neg' : '') }); money(big, v);
  const chart = h('div', { class: 'chart' }); chart.innerHTML = chartSVG(chartPoints(id), 400, 70, c.color);
  const body = h('div', { class: 'det', style: `--c:${c.color}` },
    h('h3', {}, h('i'), c.name, h('button', { class: 'link', onclick: () => openCategory(id) }, 'Edit')), big,
    h('div', { class: 'meta' }, h('span', {}, v < 0 ? `${fmt(-v)} to pay back` : c.goal && v >= c.goal ? 'Goal reached' : c.goal ? `${fmt(c.goal - v)} to go` : 'No goal set')),
    chart,
    c.goal ? [h('div', { class: 'det-goal' }, h('span', {}, 'Goal ' + fmt(c.goal)), h('span', {}, Math.round(pct) + '%')),
      h('div', { class: 'det-line' }, h('i', { style: `width:${pct}%` }))] : null,
    h('div', { class: 'det-actions' },
      h('button', { onclick: () => openTx('add', { cat: id }) }, 'Add'),
      h('button', { onclick: () => openTx('withdraw', { cat: id }) }, 'Withdraw'),
      h('button', { onclick: () => openTx('transfer', { cat: id }) }, 'Move')),
    h('div', { class: 'label', style: 'margin-top:14px' }, 'History'), h('div', { id: 'dethist' }));
  sheet(body, c.name);
  renderHistory(body.querySelector('#dethist'), { catId: id });
  setTimeout(() => drawLine(chart), 250);
}

function openMenu() {
  sheet(h('div', { class: 'menu' },
    h('button', { onclick: () => { closeSheet(); setTimeout(() => openCategory(), 330); } }, 'New category', h('small', {}, 'Add something to save for')),
    h('button', { id: 'export', onclick: exportBackup }, 'Export backup', h('small', {}, 'Download all categories and transactions as JSON')),
    h('button', { onclick: () => { closeSheet(); store.flush(); } }, 'Sync now', h('small', {}, syncText()))), 'Menu');
}
function exportBackup() {
  const data = { exportedAt: new Date().toISOString(), categories: store.cats, transactions: store.txs };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `piggybank-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  closeSheet();
}

let toastTimer;
function toast(msg, undo, err = false) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast' + (err ? ' err' : ''), role: 'status' }, h('span', {}, msg),
    undo ? h('button', { onclick: () => { undo(); el.remove(); } }, 'Undo') : null);
  $('.app').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4500);
}

// ---- main views ----
function syncText() {
  const p = store.pending;
  switch (store.status) {
    case 'syncing': return 'Saving…';
    case 'synced': return 'Synced';
    case 'offline': return p ? `Offline · ${p} to sync` : 'Offline';
    case 'signin': return 'Sign in to sync';
    case 'config': return store.message || 'Server not set up';
    default: return p ? `${p} to sync` : '';
  }
}
function renderSync() {
  const el = $('#sync');
  el.dataset.s = store.status;
  el.replaceChildren(h('i'), syncText());
}

let shown = null, histFilter = 'all';
function render() {
  const b = balances(store.cats, store.txs), tot = total(b);
  const empty = store.cats.length === 0;
  $('#emptyState').hidden = !empty || !store.loaded && store.status === 'syncing';
  $('#overview').hidden = empty;
  if (empty) { renderActivity(); return; }

  const el = $('#total');
  el.classList.toggle('neg', tot < 0);
  if (shown == null) money(el, tot); else countUp(el, shown, tot);
  shown = tot;
  const wk = netSince(store.txs, Date.now() - 7 * DAY), owe = borrowed(b);
  $('#meta').replaceChildren(h('span', { class: wk >= 0 ? 'up' : 'down' }, `${fmt(wk, { sign: true })} this week`),
    owe ? h('span', {}, `${fmt(owe)} borrowed`) : '', h('span', {}, `${store.cats.length} ${store.cats.length === 1 ? 'category' : 'categories'}`));
  const chart = $('#chart'), html = chartSVG(chartPoints(), 400, 84);
  if (chart.dataset.html !== html) { chart.innerHTML = html; chart.dataset.html = html; drawLine(chart); }
  $('#alloc').replaceChildren(...store.cats.filter(c => b[c.id] > 0).map(c => h('i', { style: `--c:${c.color};flex-grow:${b[c.id]}`, title: c.name })));

  $('#cats').replaceChildren(...store.cats.map(c => {
    const v = b[c.id], pct = c.goal ? Math.max(0, Math.min(100, v / c.goal * 100)) : 0;
    const line = h('i', { style: `width:${pct}%` });
    return h('button', { class: 'cat', style: `--c:${c.color}`, onclick: () => openDetail(c.id), 'data-cat': c.id },
      h('span', { class: 'dot' }), h('b', {}, c.name), h('span', { class: 'amt' + (v < 0 ? ' neg' : '') }, fmt(v)),
      h('span', { class: 'prog' }, h('span', { class: 'line' }, line),
        h('small', {}, v < 0 ? 'borrowed' : c.goal ? `${Math.round(pct)}% of ${fmt(c.goal, { whole: true })}` : 'no goal')));
  }));
  renderHistory($('#recent'), { limit: 4 });
  renderActivity();
}
function renderActivity() {
  $('#filters').replaceChildren(...[['all', 'All'], ['add', 'In'], ['withdraw', 'Out'], ['transfer', 'Moves']].map(([k, l]) =>
    h('button', { class: histFilter === k ? 'on' : '', onclick: () => { histFilter = k; renderActivity(); } }, l)));
  renderHistory($('#hist'), { type: histFilter });
}
function go(to) {
  const act = to === 'activity';
  $('#home').classList.toggle('off-left', act);
  $('#activity').classList.toggle('off-right', !act);
}

store.on(ev => {
  if (ev.type === 'status') return renderSync();
  if (ev.type === 'error') toast(ev.message, null, true);
  render(); renderSync();
});
$('#bAdd').onclick = () => openTx('add');
$('#bOut').onclick = () => openTx('withdraw');
$('#bMove').onclick = () => openTx('transfer');
$('#menuBtn').onclick = openMenu;
$('#firstCat').onclick = () => openCategory();
$('#seeall').onclick = () => go('activity');
$('#back').onclick = () => go('home');
$('#sync').onclick = () => (store.status === 'signin' ? location.assign('/?signin=' + Date.now()) : store.flush());

render(); renderSync();
store.flush();
addEventListener('online', () => store.flush());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') store.flush(); });
setInterval(() => { if (document.visibilityState === 'visible' && store.status !== 'syncing') store.flush(); }, 60_000);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});

// for tests and debugging
window.piggy = { store, openDetail, openTx };
