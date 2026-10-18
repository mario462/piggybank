import { balances, total, borrowed, series, netSince, fmt, parseAmount, MAX_CENTS } from './ledger.js';
import { createStore } from './store.js';

const COLORS = ['#7C9CFF', '#5EC4B6', '#B79CFF', '#E0A458', '#E57A7A', '#D98BB5', '#8FBF7F', '#6FB7D9'];
const DAY = 864e5;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = createStore();
const $ = s => document.querySelector(s);
// archived categories are finished goals: kept for their history, out of the overview and the money sheet
const active = () => store.cats.filter(c => !c.archived);
const archived = () => store.cats.filter(c => c.archived).sort((a, b) => b.archived - a.archived);

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
const ICONS = {
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};
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
  // blurring the focused field is what puts the iOS keyboard away
  if (s.contains(document.activeElement)) document.activeElement.blur();
  // The layer is pinned to the area above the keyboard, which grows back while the keyboard slides away. Slide out
  // past the bottom of the whole screen instead, starting from exactly where the sheet is now and at its current size,
  // so it doesn't stall above the old keyboard edge and then vanish when the viewport catches up.
  const card = s.querySelector('.sheet'), from = card.getBoundingClientRect();
  card.style.transition = 'none'; card.style.height = from.height + 'px'; card.style.maxHeight = 'none';
  s.classList.add('closing'); card.style.transform = 'none';
  card.style.transform = `translateY(${from.top - card.getBoundingClientRect().top}px)`;
  card.getBoundingClientRect(); // commit that start position before animating from it
  card.style.transform = card.style.transition = ''; s.querySelector('.backdrop').style.opacity = '';
  // while it animates out, hide the closing sheet from input and assistive tech, and free its ids for the next sheet
  s.inert = true; s.setAttribute('aria-hidden', 'true');
  s.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  s.classList.remove('open');
  card.addEventListener('transitionend', e => { if (e.target === card) s.remove(); });
  setTimeout(() => s.remove(), 500);
}
function sheet(content, label) {
  closeSheet();
  const wrap = h('div', { class: 'sheet-wrap' },
    h('div', { class: 'backdrop', onclick: closeSheet }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, h('div', { class: 'grab' }), content));
  $('.app').append(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  openSheet = wrap;
  swipeToClose(wrap);
  return wrap;
}
// drag a sheet down to dismiss it (and the keyboard with it); a short drag springs back
function swipeToClose(wrap) {
  const card = wrap.querySelector('.sheet'), backdrop = wrap.querySelector('.backdrop');
  let start = null, dy = 0, dragging = false;
  const reset = () => { card.style.transform = card.style.transition = backdrop.style.opacity = ''; };
  card.addEventListener('touchstart', e => {
    start = e.touches.length === 1 && card.scrollTop <= 0 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp } : null;
    dy = 0; dragging = false;
  }, { passive: true });
  card.addEventListener('touchmove', e => {
    if (!start) return;
    const x = e.touches[0].clientX - start.x, y = e.touches[0].clientY - start.y;
    if (!dragging) {
      if (Math.abs(x) > 8 && Math.abs(x) > Math.abs(y)) { start = null; return; } // sideways: let the chips scroll
      if (y < 8 || y < Math.abs(x)) return;
      dragging = true; card.style.transition = 'none'; backdrop.style.transition = 'none';
    }
    e.preventDefault();
    dy = Math.max(0, y);
    card.style.transform = `translateY(${dy}px)`;
    backdrop.style.opacity = String(1 - Math.min(1, dy / card.offsetHeight));
  }, { passive: false });
  const end = e => {
    if (!dragging) { start = null; return; }
    const fast = dy > 30 && dy / Math.max(1, e.timeStamp - start.t) > 0.5;
    start = null; dragging = false; backdrop.style.transition = '';
    if (wrap === openSheet && (dy > Math.min(120, card.offsetHeight / 3) || fast)) closeSheet();
    else reset();
  };
  card.addEventListener('touchend', end);
  card.addEventListener('touchcancel', end);
}
addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (openSheet) closeSheet(); else if (full) closeFull(); else closeMenu(); });
// keep sheets above the iOS keyboard: pin the sheet layer to the part of the page that is actually visible
if (window.visualViewport) {
  const vv = visualViewport, fit = () => {
    document.documentElement.style.setProperty('--vv-top', vv.pageTop + 'px');
    document.documentElement.style.setProperty('--vv-h', vv.height + 'px');
  };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
}

function openTx(type = 'add', o = {}) {
  if (!active().length) return openCategory();
  const sel = { type, a: o.cat || null, b: o.to || null };
  const amt = h('input', { id: 'amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', maxlength: '12', size: '1', 'aria-label': 'Amount' });
  const field = h('span', { class: 'amount-field' }, amt);
  const note = h('input', { id: 'note', class: 'field', placeholder: 'Note (optional)', autocomplete: 'off', maxlength: '200' });
  const seg = h('div', { class: 'seg', role: 'tablist' });
  const labA = h('div', { class: 'flabel' }), labB = h('div', { class: 'flabel' }, 'To');
  const rowA = h('div', { class: 'chips' }), rowB = h('div', { class: 'chips' });
  const hint = h('div', { class: 'hint' });
  const go = h('button', { class: 'go', id: 'go', onclick: submit });
  // the input sizes to a hidden copy of its text (see .amount-field), so it never clips; long amounts shrink the type
  const size = () => { field.dataset.v = amt.value || amt.placeholder; field.parentNode?.style.setProperty('--len', Math.max(7, amt.value.length)); };
  const quick = h('div', { class: 'quick' }, [10, 25, 50, 100].map(v => h('button', {
    onclick: () => { amt.value = String((parseAmount(amt.value) + v * 100) / 100); size(); update(); },
  }, '+' + v)));
  const cents = () => parseAmount(amt.value);

  function chips(row, key, other) {
    const b = balances(store.cats, store.txs);
    row.replaceChildren(...active().map(c => h('button', {
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
    // the server refuses more than this, so the change would show for a moment and then vanish with an error
    const tooBig = c > MAX_CENTS;
    if (tooBig) {
      hint.textContent = `One entry can be at most ${fmt(MAX_CENTS, { whole: true })}.`; hint.className = 'hint warn';
    } else if (A && c && sel.type !== 'add' && b[A.id] - c < 0) {
      hint.textContent = `${A.name} will be at ${fmt(b[A.id] - c)}, borrowed from yourself.`; hint.className = 'hint warn';
    } else if (A && c && sel.type === 'add' && A.goal && b[A.id] < A.goal && b[A.id] + c >= A.goal) {
      hint.textContent = `This reaches the ${fmt(A.goal, { whole: true })} goal.`; hint.className = 'hint good';
    }
    const ok = c > 0 && !tooBig && A && (sel.type !== 'transfer' || (B && B.id !== A.id));
    go.disabled = !ok;
    go.textContent = !c ? 'Enter an amount' : tooBig ? 'Amount too large' : !A ? 'Pick a category' : sel.type === 'transfer' && !B ? 'Pick where it goes'
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
  sheet(h('div', { class: 'form' }, seg, h('div', { class: 'amount' }, h('span', {}, '$'), field), quick, labA, rowA, labB, rowB, note, hint, go), 'New transaction');
  size(); update();
  // focus now, inside the tap that opened the sheet: iOS only raises the keyboard for a focus() made synchronously in a user gesture
  amt.focus({ preventScroll: true });
  amt.select();
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
  const go = h('button', { class: 'go', id: 'csave' });
  const draw = () => {
    swatches.replaceChildren(...COLORS.map(c => h('button', { class: 'sw' + (c === color ? ' on' : ''), style: `--c:${c}`, 'aria-label': 'Colour ' + c, onclick: () => { color = c; draw(); } })));
    const tooBig = parseAmount(goal.value) > MAX_CENTS;
    go.disabled = !name.value.trim() || tooBig;
    go.textContent = tooBig ? `Goal can be at most ${fmt(MAX_CENTS, { whole: true })}` : existing ? 'Save' : 'Create category';
  };
  name.addEventListener('input', draw);
  goal.addEventListener('input', draw);
  go.addEventListener('click', () => {
    const fields = { name: name.value.trim().slice(0, 60), color, goal: parseAmount(goal.value) };
    if (go.disabled) return;
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
  if (c.archived) return openArchived(id);
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
    h('button', { class: 'link det-more', onclick: () => { closeSheet(); closeOut(id); } }, c.goal ? 'Mark goal done' : 'Close category'),
    h('div', { class: 'label', style: 'margin-top:14px' }, 'History'), h('div', { id: 'dethist' }));
  sheet(body, c.name);
  renderHistory(body.querySelector('#dethist'), { catId: id });
  setTimeout(() => drawLine(chart), 250);
}

// ---- side menu: categories, archived categories, and app actions ----
let drawer = null;
function openMenu() {
  closeSheet();
  drawer = h('div', { class: 'drawer-wrap' }, h('div', { class: 'backdrop', onclick: closeMenu }),
    h('nav', { class: 'drawer', 'aria-label': 'Menu' }));
  $('.app').append(drawer);
  renderMenu();
  requestAnimationFrame(() => requestAnimationFrame(() => drawer?.classList.add('open')));
}
function closeMenu(then) {
  if (!drawer) return typeof then === 'function' && then();
  const d = drawer; drawer = null;
  d.inert = true; d.classList.remove('open');
  setTimeout(() => d.remove(), 340);
  if (typeof then === 'function') setTimeout(then, 200);
}
function renderMenu() {
  if (!drawer) return;
  const b = balances(store.cats, store.txs), arch = archived();
  const count = n => h('span', { class: 'label count' }, n);
  drawer.querySelector('.drawer').replaceChildren(...[
    h('div', { class: 'bar' }, brand(), h('button', { class: 'icon-btn', 'aria-label': 'Close menu', onclick: closeMenu }, svg(ICONS.close))),
    h('div', { class: 'sec-h' }, h('span', { class: 'label' }, 'Categories'), count(active().length)),
    active().map(c => h('button', { class: 'drow', style: `--c:${c.color}`, onclick: () => closeMenu(() => openDetail(c.id)) },
      h('span', { class: 'dot' }), h('b', {}, c.name), h('span', { class: 'amt' + (b[c.id] < 0 ? ' neg' : '') }, fmt(b[c.id], { whole: true })))),
    h('div', { class: 'sec-h' }, h('span', { class: 'label' }, 'Archived'), count(arch.length)),
    arch.length ? [h('p', { class: 'swipe-hint' }, 'Swipe one left to delete it.'), byYear(arch)] : h('p', { class: 'swipe-hint' }, 'Goals you mark done end up here.'),
    h('div', { class: 'menu' },
      h('button', { onclick: () => closeMenu(() => openCategory()) }, 'New category', h('small', {}, 'Add something to save for')),
      h('button', { id: 'export', onclick: exportBackup }, 'Export backup', h('small', {}, 'Download all categories and transactions as JSON')),
      h('button', { onclick: () => { closeMenu(); store.flush(); } }, 'Sync now', h('small', {}, syncText()))),
  ].flat(2));
}
function byYear(list) {
  const out = []; let year = null;
  for (const c of list) {
    const y = new Date(c.archived).getFullYear();
    if (y !== year) { out.push(h('div', { class: 'day' }, String(y))); year = y; }
    out.push(swipeable(archivedRow(c), { label: 'Delete', danger: true, action: () => confirmDelete(c.id) }));
  }
  return out;
}
const spentFrom = id => store.txs.reduce((a, t) => a + (t.type === 'withdraw' && t.cat === id ? t.amount : 0), 0);
const shortDate = (t, year) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: year ? 'numeric' : undefined });
function archivedRow(c) {
  return h('div', { class: 'cat arch', style: `--c:${c.color}`, 'data-cat': c.id, onclick: () => closeMenu(() => openArchived(c.id)) },
    h('span', { class: 'dot' }), h('b', {}, c.name), h('span', { class: 'amt' }, fmt(spentFrom(c.id))),
    h('span', { class: 'prog' }, h('small', {}, (c.goal ? 'Done ' : 'Closed ') + shortDate(c.archived)), h('small', {}, c.goal ? `goal ${fmt(c.goal, { whole: true })}` : 'spent')));
}

// ---- swipe a row left to reveal one action ----
let openRow = null;
function swipeable(row, { label, action, danger = false }) {
  const W = 104; // the action's 92px plus a 12px gap from the row, like iOS list swipe actions
  row.setAttribute('role', 'button'); row.tabIndex = 0;
  row.addEventListener('keydown', e => { if (e.key === 'Enter') row.click(); });
  const wrap = h('div', { class: 'swipe' }, h('button', { class: 'act' + (danger ? ' danger' : ''), tabindex: '-1', onclick: () => { shut(); action(); } }, label), row);
  let x0 = null, y0 = 0, dx = 0, base = 0, drag = false, isOpen = false;
  const shut = () => { isOpen = false; row.style.transform = ''; if (openRow === shut) openRow = null; };
  // a tap on an open row closes it instead of opening the row
  row.addEventListener('click', e => { if (drag || isOpen) { e.stopImmediatePropagation(); if (!drag) shut(); } }, true);
  row.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; drag = false; base = dx = isOpen ? -W : 0; });
  row.addEventListener('pointermove', e => {
    if (x0 == null) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!drag) {
      if (Math.abs(my) > 8 && Math.abs(my) >= Math.abs(mx)) { x0 = null; return; } // scrolling the list
      if (Math.abs(mx) < 8) return;
      drag = true; row.setPointerCapture(e.pointerId); row.style.transition = 'none';
      if (openRow && openRow !== shut) openRow();
    }
    dx = Math.min(0, Math.max(-W * 1.5, base + mx));
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null; row.style.transition = '';
    if (!drag) return;
    isOpen = dx < -W / 2;
    row.style.transform = isOpen ? `translateX(${-W}px)` : '';
    if (isOpen) openRow = shut;
    setTimeout(() => { drag = false; }); // after the click this drag ends with
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
  return wrap;
}

// ---- mark a goal done: move any leftover, withdraw what was spent, archive ----
function markDone(id, spent, to) {
  const c = store.cat(id), left = balances(store.cats, store.txs)[id] - spent, txs = [];
  if (left > 0) txs.push(store.addTx({ type: 'transfer', cat: id, to, amount: left, note: 'Leftover' }));
  if (spent > 0) txs.push(store.addTx({ type: 'withdraw', cat: id, amount: spent, note: c.goal ? 'Goal done' : 'Closed' }));
  store.updateCategory(id, { archived: Date.now() });
  toast(`${c.name} archived`, () => {
    store.updateCategory(id, { archived: null });
    txs.reverse().forEach(t => store.undoTx(t.id));
  });
}
let full = null;
function closeFull() {
  if (!full) return;
  const f = full; full = null;
  if (f.contains(document.activeElement)) document.activeElement.blur();
  f.inert = true; f.classList.remove('open');
  setTimeout(() => f.remove(), 400);
}
function closeOut(id) {
  document.querySelector('.toast')?.remove();
  const c = store.cat(id), v = balances(store.cats, store.txs)[id];
  const opts = [{ k: 'all', t: 'All of it', s: 'Withdraw the full balance', amt: v }];
  if (c.goal && v > c.goal) opts.push({ k: 'goal', t: 'The goal amount', s: `${fmt(v - c.goal)} is left over`, amt: c.goal });
  opts.push({ k: 'other', t: 'A different amount', s: 'Type what it actually cost', amt: null });
  const sel = { k: 'all', to: active().find(o => o.id !== id)?.id };
  const field = h('input', { id: 'spent', class: 'field', inputmode: 'decimal', autocomplete: 'off', placeholder: '$0.00', maxlength: '12', 'aria-label': 'Amount spent' });
  const optsEl = h('div', { class: 'opts' }), leftLab = h('div', { class: 'flabel' }), leftRow = h('div', { class: 'chips' }), hint = h('div', { class: 'hint' });
  const go = h('button', { class: 'go', id: 'closeGo', onclick: submit });
  const big = h('div', { class: 'total' + (v < 0 ? ' neg' : '') }); money(big, v);
  const spent = () => sel.k === 'other' ? parseAmount(field.value) : opts.find(o => o.k === sel.k).amt;
  function update() {
    optsEl.replaceChildren(...opts.map(o => h('button', { class: 'opt' + (sel.k === o.k ? ' on' : ''), 'aria-pressed': String(sel.k === o.k),
      // focus inside the tap so iOS raises the keyboard
      onclick: () => { sel.k = o.k; update(); if (o.k === 'other') field.focus(); } },
      h('span', {}, o.t, h('small', {}, o.s)), o.amt != null ? h('span', { class: 'r' }, fmt(o.amt)) : null)));
    field.hidden = sel.k !== 'other';
    const s = spent(), left = v - s, b = balances(store.cats, store.txs);
    leftLab.hidden = leftRow.hidden = !(left > 0 && s > 0);
    leftLab.textContent = `The other ${fmt(left)} goes to`;
    leftRow.replaceChildren(...active().filter(o => o.id !== id).map(o => h('button', {
      class: 'chip' + (sel.to === o.id ? ' on' : ''), style: `--c:${o.color}`, onclick: () => { sel.to = o.id; update(); },
    }, h('i', { class: 'dot' }), h('span', { class: 'chip-t' }, h('b', {}, o.name), h('small', {}, fmt(b[o.id], { whole: true }))))));
    hint.className = 'hint' + (left < 0 ? ' warn' : '');
    hint.textContent = left < 0 ? `That's more than the ${fmt(v)} in ${c.name}.` : left > 0 && !sel.to ? 'Make another category for the rest first.' : '';
    go.disabled = !(s > 0) || left < 0 || (left > 0 && !sel.to);
    go.textContent = !(s > 0) ? 'Enter what you spent' : `Withdraw ${fmt(s)} and archive`;
  }
  function submit() {
    if (go.disabled) return;
    markDone(id, spent(), sel.to);
    closeFull();
  }
  let body, foot;
  if (v > 0) {
    body = [h('div', { class: 'flabel', style: 'margin-top:14px' }, 'How much did you spend?'), optsEl, field, leftLab, leftRow, hint];
    foot = go;
  } else if (v === 0) {
    body = h('p', { class: 'hint' }, `${c.name} is empty, so nothing is withdrawn.`);
    foot = h('button', { class: 'go', id: 'closeGo', onclick: () => { markDone(id, 0); closeFull(); } }, 'Archive');
  } else {
    body = h('p', { class: 'hint warn' }, `${c.name} is at ${fmt(v)}. Move money in to bring it to zero, then close it.`);
    foot = h('button', { class: 'go', onclick: () => { closeFull(); openTx('transfer', { to: id }); } }, `Move ${fmt(-v)} in`);
  }
  const pct = c.goal ? Math.max(0, Math.min(100, v / c.goal * 100)) : 0;
  full = h('div', { class: 'full', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Close out ' + c.name, style: `--c:${c.color}` },
    h('div', { class: 'full-bar' }, h('button', { class: 'link', onclick: closeFull }, 'Cancel'),
      h('span', { class: 'label' }, c.goal ? 'Close out goal' : 'Close category'), h('span', { class: 'full-spacer' })),
    h('div', { class: 'full-body' }, h('div', { class: 'full-name' }, h('i'), c.name), big,
      c.goal ? [h('div', { class: 'det-goal' }, h('span', {}, 'Goal ' + fmt(c.goal)), h('span', {}, Math.round(v / c.goal * 100) + '%')),
        h('div', { class: 'det-line' }, h('i', { style: `width:${pct}%` }))] : null,
      body),
    h('div', { class: 'full-foot' }, foot, h('p', { class: 'hint' }, 'It moves to Archived in the menu. Its history stays.')));
  field.addEventListener('input', update);
  field.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $('.app').append(full);
  requestAnimationFrame(() => requestAnimationFrame(() => full?.classList.add('open')));
  if (v > 0) update();
}

// ---- archived categories ----
function openArchived(id) {
  const c = store.cat(id); if (!c) return;
  const first = store.txs.find(t => t.cat === id || t.to === id);
  const months = first ? Math.max(1, Math.round((c.archived - first.t) / (30.4 * DAY))) : 0;
  const big = h('div', { class: 'total' }); money(big, spentFrom(id));
  const chart = h('div', { class: 'chart' }); chart.innerHTML = chartSVG(chartPoints(id), 400, 70, c.color);
  const body = h('div', { class: 'det', style: `--c:${c.color}` },
    h('h3', { class: 'arch' }, h('i'), c.name, h('span', { class: 'tag' }, 'Archived')),
    h('div', { class: 'label', style: 'margin-top:14px' }, 'Spent'), big,
    h('div', { class: 'meta' }, c.goal ? h('span', {}, 'Goal ' + fmt(c.goal, { whole: true })) : null,
      h('span', {}, (c.goal ? 'Done ' : 'Closed ') + shortDate(c.archived, true)),
      months ? h('span', {}, `Saved over ${months} ${months === 1 ? 'month' : 'months'}`) : null),
    chart,
    h('div', { class: 'row2', style: 'margin:20px 0 8px' },
      h('button', { class: 'go ghost', onclick: () => { closeSheet(); restore(id); } }, 'Restore'),
      h('button', { class: 'go danger', onclick: () => confirmDelete(id) }, 'Delete')),
    h('div', { class: 'label', style: 'margin-top:14px' }, 'History'), h('div', { id: 'dethist' }));
  sheet(body, c.name);
  renderHistory(body.querySelector('#dethist'), { catId: id });
  setTimeout(() => drawLine(chart), 250);
}
function restore(id) {
  const c = store.cat(id), at = c.archived;
  store.updateCategory(id, { archived: null });
  toast(`${c.name} is back in your categories`, () => store.updateCategory(id, { archived: at }));
}
function confirmDelete(id) {
  const c = store.cat(id); if (!c) return;
  const n = store.txs.filter(t => t.cat === id || t.to === id).length;
  const moves = store.txs.some(t => t.type === 'transfer' && (t.cat === id || t.to === id));
  sheet(h('div', { class: 'form' }, h('h3', { class: 'sheet-title' }, `Delete ${c.name}?`),
    h('p', { class: 'sheet-p' }, `This removes ${c.name} and its ${n} ${n === 1 ? 'transaction' : 'transactions'} for good.` +
      (moves ? ' Money it moved to or from other categories stays with them.' : '')),
    h('button', { class: 'go danger', id: 'confirmDelete', onclick: () => { store.deleteCategory(id); closeSheet(); toast(`Deleted ${c.name}`); } }, 'Delete category'),
    h('button', { class: 'link', onclick: closeSheet }, 'Cancel')), 'Delete category');
}

function exportBackup() {
  const data = { exportedAt: new Date().toISOString(), categories: store.cats, transactions: store.txs };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `piggybank-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  closeSheet(); closeMenu();
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
  renderMenu();
}
const brand = () => $('#home .brand').cloneNode(true);

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
    owe ? h('span', {}, `${fmt(owe)} borrowed`) : '', h('span', {}, `${active().length} ${active().length === 1 ? 'category' : 'categories'}`));
  const chart = $('#chart'), html = chartSVG(chartPoints(), 400, 84);
  if (chart.dataset.html !== html) { chart.innerHTML = html; chart.dataset.html = html; drawLine(chart); }
  $('#alloc').replaceChildren(...active().filter(c => b[c.id] > 0).map(c => h('i', { style: `--c:${c.color};flex-grow:${b[c.id]}`, title: c.name })));

  openRow = null;
  const cats = active();
  $('#swipeHint').hidden = !cats.length;
  $('#cats').replaceChildren(...(cats.length ? cats.map(c => {
    const v = b[c.id], pct = c.goal ? Math.max(0, Math.min(100, v / c.goal * 100)) : 0;
    const reached = c.goal > 0 && v >= c.goal;
    const line = h('i', { style: `width:${pct}%` });
    const row = h('div', { class: 'cat', style: `--c:${c.color}`, onclick: () => openDetail(c.id), 'data-cat': c.id },
      h('span', { class: 'dot' }), h('b', {}, c.name), h('span', { class: 'amt' + (v < 0 ? ' neg' : '') }, fmt(v)),
      h('span', { class: 'prog' }, h('span', { class: 'line' }, line),
        h('small', { class: reached ? 'good' : '' }, v < 0 ? 'borrowed' : reached ? (v > c.goal ? `Goal reached · ${fmt(v - c.goal, { whole: true })} over` : 'Goal reached')
          : c.goal ? `${Math.round(pct)}% of ${fmt(c.goal, { whole: true })}` : 'no goal'),
        reached ? h('button', { class: 'pill', onclick: e => { e.stopPropagation(); closeOut(c.id); } }, 'Mark done') : null));
    return swipeable(row, { label: c.goal ? 'Mark done' : 'Close', action: () => closeOut(c.id) });
  }) : [h('p', { class: 'none' }, 'Everything is archived. Add a category to start saving again.')]));
  renderHistory($('#recent'), { limit: 4 });
  renderActivity();
  renderMenu();
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
