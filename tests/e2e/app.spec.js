import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const shot = (page, name) => page.screenshot({ path: `test-results/screens/${name}.png` });

async function newCategory(page, name, goal) {
  await page.locator('#menuBtn').click();
  await page.getByRole('button', { name: /New category/ }).click();
  // the previous category sheet may still be animating out, so scope to the open one
  const sheet = page.getByRole('dialog', { name: 'New category' });
  await sheet.locator('#cname').fill(name);
  await sheet.locator('#cgoal').fill(goal);
  await sheet.locator('#csave').click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.cat', { hasText: name })).toBeVisible();
}
async function transaction(page, { type, amount, from, to, note }) {
  await page.locator('#bAdd').click();
  const sheet = page.getByRole('dialog', { name: 'New transaction' });
  await sheet.getByRole('tab', { name: type }).click();
  await page.locator('#amt').fill(String(amount));
  await sheet.locator('.chips').nth(0).locator('.chip', { hasText: from }).click();
  if (to) await sheet.locator('.chips').nth(1).locator('.chip', { hasText: to }).click();
  if (note) await page.locator('#note').fill(note);
  await page.locator('#go').click();
  await expect(sheet).toBeHidden();
}
const synced = page => expect(page.locator('#sync')).toHaveAttribute('data-s', 'synced');
const serverState = page => page.evaluate(() => fetch('/api/state').then(r => r.json()));

test('first launch shows an empty state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#emptyState')).toBeVisible();
  await synced(page);
  await shot(page, '01-empty');
});

test('create categories, add, move and withdraw', async ({ page }) => {
  await page.goto('/');
  await page.locator('#firstCat').click();
  await page.locator('#cname').fill('Japan trip');
  await page.locator('#cgoal').fill('2500');
  await page.locator('#csave').click();
  await newCategory(page, 'Nintendo Switch 2', '450');
  await newCategory(page, 'Concert', '180');

  await transaction(page, { type: 'Add', amount: '1200', from: 'Japan trip', note: 'Paycheck' });
  await expect(page.locator('#total')).toHaveText('$1,200.00');
  await transaction(page, { type: 'Move', amount: '300.50', from: 'Japan trip', to: 'Nintendo Switch 2' });
  await transaction(page, { type: 'Add', amount: '40', from: 'Concert' });

  // withdrawing more than a category holds is allowed (borrowing from yourself)
  await page.locator('#bAdd').click();
  await page.getByRole('tab', { name: 'Withdraw' }).click();
  await page.locator('#amt').fill('100');
  await page.locator('.chips').nth(0).locator('.chip', { hasText: 'Concert' }).click();
  await expect(page.locator('.hint')).toContainText('−$60.00');
  await shot(page, '02-withdraw-sheet');
  await page.locator('#go').click();

  await expect(page.locator('#total')).toHaveText('$1,140.00');
  await expect(page.locator('.cat', { hasText: 'Concert' }).locator('.amt')).toHaveText('−$60.00');
  await expect(page.locator('.cat', { hasText: 'Japan trip' }).locator('.amt')).toHaveText('$899.50');
  await expect(page.locator('.cat', { hasText: 'Nintendo' }).locator('.amt')).toHaveText('$300.50');
  await expect(page.locator('#meta')).toContainText('−$60.00 borrowed');
  await synced(page);
  await page.waitForTimeout(1300); // let the chart draw
  await shot(page, '03-overview');

  const s = await serverState(page);
  expect(s.categories).toHaveLength(3);
  expect(s.transactions.map(t => t.type)).toEqual(['add', 'transfer', 'add', 'withdraw']);
  expect(s.transactions[1].amount).toBe(30050);
});

test('opening on a new phone waits for the data instead of showing the welcome', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.route('**/api/state', async r => { await new Promise(res => setTimeout(res, 1500)); await r.continue(); });
  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.locator('#emptyState')).toBeHidden();
  await expect(page.locator('#overview')).toBeHidden();
  await expect(page.locator('#sync')).toHaveText('Loading…');
  await expect(page.locator('#bAdd')).toBeDisabled();
  await expect(page.locator('#overview')).toBeVisible();
  await expect(page.locator('#bAdd')).toBeEnabled();
  await expect(page.locator('.cat')).toHaveCount(3);
  await page.unroute('**/api/state');
});
test('with no copy on the phone and no connection, the welcome shows once the load fails', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.route('**/api/state', r => r.abort());
  await page.reload();
  await expect(page.locator('#sync')).toHaveAttribute('data-s', 'offline');
  await expect(page.locator('#emptyState')).toBeVisible();
  await page.unroute('**/api/state');
});

test('data survives a reload with an empty cache (server is the source of truth)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#total')).toHaveText('$1,140.00');
  await expect(page.locator('.cat')).toHaveCount(3);
});

test('a background sync with nothing new leaves the overview chart alone', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  await page.waitForTimeout(1300); // let the line finish drawing in
  const kept = await page.evaluate(async () => {
    const line = document.querySelector('#chart .ln');
    await window.piggy.store.flush();
    await new Promise(r => requestAnimationFrame(r));
    const now = document.querySelector('#chart .ln');
    return { same: now === line, offset: getComputedStyle(now).strokeDashoffset };
  });
  expect(kept).toEqual({ same: true, offset: '0px' });
});

test('undo removes the transaction everywhere', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  await transaction(page, { type: 'Add', amount: '5', from: 'Concert' });
  await expect(page.locator('#total')).toHaveText('$1,145.00');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('#total')).toHaveText('$1,140.00');
  await synced(page);
  await expect.poll(async () => (await serverState(page)).transactions.length).toBe(4);
});

test('the balance counts smoothly through a sync and an undo, never jumping', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  // read the number on every frame: up while the deposit counts in (the sync lands meanwhile), then straight down after Undo
  const seen = await page.evaluate(async () => {
    const out = [], read = () => Number(document.querySelector('#total').textContent.replace(/[^0-9.]/g, ''));
    let on = true; const frame = () => { out.push(read()); if (on) requestAnimationFrame(frame); }; frame();
    const s = window.piggy.store, tx = s.addTx({ type: 'add', cat: s.cats[0].id, amount: 50000, note: 'count' });
    await new Promise(r => setTimeout(r, 250));
    const undoAt = out.length; s.undoTx(tx.id);
    await new Promise(r => setTimeout(r, 900)); on = false;
    return { up: out.slice(0, undoAt), down: out.slice(undoAt) };
  });
  // one rise and one fall, turning where Undo was tapped (samples trail the screen by a frame), and back where it began
  const all = [...seen.up, ...seen.down], top = all.indexOf(Math.max(...all));
  const rising = all.slice(0, top + 1).every((v, i, a) => i === 0 || v >= a[i - 1]);
  const falling = all.slice(top).every((v, i, a) => i === 0 || v <= a[i - 1]);
  const turnsAtUndo = Math.max(...all) === Math.max(...seen.up, seen.down[0]);
  expect({ rising, falling, turnsAtUndo, end: all.at(-1) }).toEqual({ rising: true, falling: true, turnsAtUndo: true, end: all[0] });
  await synced(page);
});

test('category detail shows balance, goal and its own history', async ({ page }) => {
  await page.goto('/');
  await page.locator('.cat', { hasText: 'Nintendo' }).click();
  const d = page.getByRole('dialog', { name: 'Nintendo Switch 2' });
  await expect(d.locator('.total')).toHaveText('$300.50');
  await expect(d).toContainText('$149.50 to go');
  await expect(d.locator('.tx')).toHaveCount(1);
  await expect(d.locator('.tx-amt')).toHaveText('+$300.50');
  await page.waitForTimeout(800);
  await shot(page, '04-detail');
});

test('opening the money sheet from a category keeps the screen still and shows the picked category', async ({ page }) => {
  await page.goto('/');
  await page.locator('.cat', { hasText: 'Concert' }).click();
  const d = page.getByRole('dialog', { name: 'Concert' });
  await page.waitForTimeout(400);
  // the app itself must never scroll: watch its offset on every frame while the detail sheet hands over to the money sheet
  const offsets = await d.evaluate(d => new Promise(done => {
    const app = document.querySelector('.app'), seen = new Set(), t0 = performance.now();
    [...d.querySelectorAll('button')].find(b => b.textContent === 'Withdraw').click();
    const frame = () => { seen.add(app.scrollTop); if (performance.now() - t0 < 700) requestAnimationFrame(frame); else done([...seen]); };
    frame();
  }));
  expect(offsets).toEqual([0]);
  // the picked chip is scrolled into view within its own row
  const sheet = page.getByRole('dialog', { name: 'New transaction' });
  const inRow = await sheet.locator('.chip.on').evaluate(c => {
    const a = c.getBoundingClientRect(), r = c.parentNode.getBoundingClientRect();
    return a.left >= r.left - 1 && a.right <= r.right + 1;
  });
  expect(inRow).toBe(true);
  await page.keyboard.press('Escape');
});

test('edit a category goal', async ({ page }) => {
  await page.goto('/');
  await page.locator('.cat', { hasText: 'Concert' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#cgoal').fill('200');
  await page.locator('#csave').click();
  await synced(page);
  await expect.poll(async () => (await serverState(page)).categories.find(c => c.name === 'Concert').goal).toBe(20000);
});

test('activity lists everything and filters by type', async ({ page }) => {
  await page.goto('/');
  await page.locator('#seeall').click();
  await expect(page.locator('#hist .tx')).toHaveCount(4);
  await page.locator('#filters').getByRole('button', { name: 'Moves' }).click();
  await expect(page.locator('#hist .tx')).toHaveCount(1);
  await expect(page.locator('#hist .tx')).toContainText('Japan trip → Nintendo Switch 2');
  await shot(page, '05-activity');
});

test('Activity slides in opaque over the overview and back out, never showing both at once', async ({ page }) => {
  await page.goto('/');
  // the screen sliding in or out stays fully opaque on every frame, so the overview never shows through it
  const watch = (button, ms = 500) => page.evaluate(([button, ms]) => new Promise(done => {
    const act = document.querySelector('#activity'), seen = new Set(), t0 = performance.now();
    document.querySelector(button).click();
    const frame = () => { seen.add(getComputedStyle(act).opacity); if (performance.now() - t0 < ms) requestAnimationFrame(frame); else done([...seen]); };
    frame();
  }), [button, ms]);
  expect(await watch('#seeall')).toEqual(['1']);
  await expect(page.locator('#activity')).toHaveCSS('transform', 'none');
  expect(await watch('#back')).toEqual(['1']);
  await expect(page.locator('#home')).toHaveCSS('opacity', '1');
});

test('works offline and syncs when back online', async ({ page, context }) => {
  await page.goto('/');
  await synced(page);
  await context.setOffline(true);
  await transaction(page, { type: 'Add', amount: '25', from: 'Japan trip', note: 'offline' });
  await expect(page.locator('#total')).toHaveText('$1,165.00');
  await expect(page.locator('#sync')).toHaveAttribute('data-s', 'offline');
  await expect(page.locator('#sync')).toContainText('1 to sync');
  await shot(page, '06-offline');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await synced(page);
  const s = await serverState(page);
  expect(s.transactions.find(t => t.note === 'offline')?.amount).toBe(2500);
});

test('the API refuses writes without the app header and rejects bad input', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const post = (body, headers = { 'X-Piggybank': '1' }) => fetch('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(x => x.status);
    const s = await fetch('/api/state').then(x => x.json());
    const cat = s.categories[0].id;
    return {
      noHeader: await post({ id: 'zzzzzzzzzz', type: 'add', cat, amount: 100 }, {}),
      negative: await post({ id: 'zzzzzzzzzz', type: 'add', cat, amount: -100 }),
      unknownCat: await post({ id: 'zzzzzzzzzz', type: 'add', cat: 'nosuchcat1', amount: 100 }),
      ok: await post({ id: 'zzzzzzzzzz', type: 'add', cat, amount: 100 }),
      replay: await post({ id: 'zzzzzzzzzz', type: 'add', cat, amount: 100 }),
    };
  });
  expect(r).toEqual({ noHeader: 403, negative: 422, unknownCat: 422, ok: 201, replay: 200 });
});

test('the money sheet opens with the amount focused, inside the tap', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  // iOS only shows the keyboard for a focus() made synchronously in the tap, so check focus right after the click, before any timer runs
  const focused = await page.evaluate(() => { document.querySelector('#bAdd').click(); return document.activeElement?.id; });
  expect(focused).toBe('amt');
  await page.keyboard.press('Escape');
  await page.locator('.cat', { hasText: 'Concert' }).click();
  const detail = page.getByRole('dialog', { name: 'Concert' });
  const fromDetail = await detail.evaluate(d => { [...d.querySelectorAll('button')].find(b => b.textContent === 'Withdraw').click(); return document.activeElement?.id; });
  expect(fromDetail).toBe('amt');
});

test('a comma typed as the decimal point means cents, as iOS types it in many regions', async ({ page }) => {
  await page.goto('/');
  await page.locator('#bAdd').click();
  await page.locator('#amt').fill('12,50');
  await page.locator('.sheet-wrap.open .chip', { hasText: 'Concert' }).click();
  await expect(page.locator('#go')).toHaveText('Add $12.50 to Concert');
  await page.keyboard.press('Escape');
});

test('long amounts are never clipped in the money sheet', async ({ page }) => {
  await page.goto('/');
  await page.locator('#bAdd').click();
  const amt = page.locator('#amt');
  for (const v of ['8', '1234.56', '123456789.99']) {
    await amt.fill(v);
    const m = await amt.evaluate(el => {
      const r = el.getBoundingClientRect(), s = el.closest('.sheet').getBoundingClientRect();
      const a = el.closest('.amount').getBoundingClientRect(), cur = el.parentNode.previousElementSibling.getBoundingClientRect();
      return { fits: el.scrollWidth <= el.clientWidth + 1, inside: r.left >= s.left && r.right <= s.right,
        centred: Math.abs((cur.left + r.right) / 2 - (a.left + a.right) / 2) < 30 };
    });
    expect(m, v).toEqual({ fits: true, inside: true, centred: true });
    await shot(page, `07-amount-${v.length}`);
  }
  await page.keyboard.press('Escape');
});

// a real finger drag down from the top of the open sheet, through the browser's touch input
async function swipeDown(page, distance) {
  const box = await page.locator('.sheet-wrap.open .grab').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, dy) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: y + dy }] });
  await touch('touchStart', 0);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', distance * i / 10); await page.waitForTimeout(16); }
  await touch('touchEnd', distance);
  await cdp.detach();
}

test('swiping the money sheet down dismisses it and the keyboard', async ({ page }) => {
  await page.goto('/');
  await page.locator('#bAdd').click();
  const sheet = page.getByRole('dialog', { name: 'New transaction' });
  await expect(page.locator('#amt')).toBeFocused();
  await page.waitForTimeout(400); // let it finish sliding in
  // a short drag springs back and keeps the amount focused
  await swipeDown(page, 40);
  await expect(sheet).toBeVisible();
  await expect(page.locator('#amt')).toBeFocused();
  await expect.poll(() => sheet.evaluate(d => d.style.transform)).toBe('');
  // a long drag closes the sheet and blurs the amount, which puts the iOS keyboard away
  await swipeDown(page, 260);
  await expect(sheet).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
});

test('with the keyboard up, a dismissed sheet slides off the bottom of the screen', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  // stand in for the iOS keyboard: the visible area (what visualViewport reports) is 300px shorter than the screen
  const screen = await page.evaluate(() => innerHeight);
  await page.evaluate(h => document.documentElement.style.setProperty('--vv-h', h + 'px'), screen - 300);
  await page.locator('#bAdd').click();
  await page.waitForTimeout(400);
  const height = await page.locator('.sheet-wrap.open .sheet').evaluate(s => s.offsetHeight);
  await swipeDown(page, 120);
  // part-way through the slide, before the viewport reports the keyboard has gone, the sheet must already be past the
  // old keyboard edge, at its own size, rather than parked above the keyboard waiting to vanish
  const mid = await page.evaluate(() => new Promise(r => setTimeout(() => {
    const s = document.querySelector('.sheet-wrap .sheet');
    r(s && { top: s.getBoundingClientRect().top, height: s.offsetHeight });
  }, 220)));
  expect(mid.top).toBeGreaterThan(screen - 300);
  expect(mid.height).toBe(height);
  await expect(page.locator('.sheet-wrap')).toHaveCount(0);
  await page.evaluate(() => document.documentElement.style.removeProperty('--vv-h'));
});

// a real finger drag left across a row, through the browser's touch input
async function swipeLeft(page, row, distance = 160) {
  const box = await row.boundingBox();
  const x = box.x + box.width - 40, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, dx) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: x - dx, y }] });
  await touch('touchStart', 0);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', distance * i / 10); await page.waitForTimeout(16); }
  await touch('touchEnd', distance);
  await cdp.detach();
  await page.waitForTimeout(350); // let it settle open
}
const balanceOf = (s, id) => s.transactions.reduce((a, t) =>
  a + (t.to === id ? t.amount : t.cat === id ? (t.type === 'add' ? t.amount : -t.amount) : 0), 0);

test('a reached goal can be marked done: leftover moves, the rest is withdrawn, the category is archived', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  await transaction(page, { type: 'Add', amount: '160', from: 'Nintendo' });
  const row = page.locator('#cats .cat', { hasText: 'Nintendo' });
  await expect(row).toContainText('Goal reached · $11 over');
  const japanBefore = balanceOf(await serverState(page), (await serverState(page)).categories.find(c => c.name === 'Japan trip').id);
  await row.getByRole('button', { name: 'Mark done' }).click();
  const full = page.getByRole('dialog', { name: 'Close out Nintendo Switch 2' });
  await expect(full).toBeVisible();
  await full.getByRole('button', { name: /The goal amount/ }).click();
  await expect(full).toContainText('The other $10.50 goes to');
  await full.locator('.chip', { hasText: 'Japan trip' }).click();
  await page.waitForTimeout(400);
  await shot(page, '08-close-out');
  await expect(page.locator('#closeGo')).toHaveText('Withdraw $450.00 and archive');
  await page.locator('#closeGo').click();
  await expect(full).toBeHidden();
  await expect(page.locator('.toast')).toContainText('Nintendo Switch 2 archived');
  await expect(page.locator('#cats .cat', { hasText: 'Nintendo' })).toHaveCount(0);
  await expect(page.locator('#meta')).toContainText('2 categories');
  await synced(page);
  const s = await serverState(page);
  const n = s.categories.find(c => c.name === 'Nintendo Switch 2'), j = s.categories.find(c => c.name === 'Japan trip');
  expect(n.archived).toBeGreaterThan(0);
  expect(balanceOf(s, n.id)).toBe(0);
  expect(balanceOf(s, j.id)).toBe(japanBefore + 1050);
  expect(s.transactions.slice(-2).map(t => [t.type, t.amount, t.note])).toEqual([['transfer', 1050, 'Leftover'], ['withdraw', 45000, 'Goal done']]);
});

test('closing out with the keyboard up: the amount stays in view, and Cancel slides the screen off the bottom', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  const screen = await page.evaluate(() => innerHeight);
  await page.locator('#cats .cat', { hasText: 'Japan trip' }).click();
  await page.getByRole('dialog', { name: 'Japan trip' }).getByRole('button', { name: 'Mark goal done' }).click();
  const full = page.getByRole('dialog', { name: 'Close out Japan trip' });
  await page.waitForTimeout(450);
  await full.getByRole('button', { name: /A different amount/ }).click();
  await expect(page.locator('#spent')).toBeFocused();
  // the keyboard comes up after the focus, shrinking the visible area (see the sheet test above)
  await page.evaluate(h => document.documentElement.style.setProperty('--vv-h', h + 'px'), screen - 300);
  await expect.poll(() => page.locator('#spent').evaluate(f => {
    const r = f.getBoundingClientRect(), body = f.closest('.full-body').getBoundingClientRect();
    return r.top >= body.top && r.bottom <= body.bottom;
  })).toBe(true);
  const height = await full.evaluate(f => f.offsetHeight);
  await full.getByRole('button', { name: 'Cancel' }).click();
  // part-way out, before the viewport reports the keyboard gone, it is already below the old keyboard edge, at its own size
  const mid = await page.evaluate(() => new Promise(r => setTimeout(() => {
    const f = document.querySelector('.full');
    r(f && { top: f.getBoundingClientRect().top, height: f.offsetHeight });
  }, 220)));
  expect(mid.top).toBeGreaterThan(screen - 300);
  expect(mid.height).toBe(height);
  await expect(page.locator('.full')).toHaveCount(0);
  await page.evaluate(() => document.documentElement.style.removeProperty('--vv-h'));
});

test('swiping a category left reveals Mark done; a category below zero must be topped up first', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('#cats .cat', { hasText: 'Concert' });
  await swipeLeft(page, row);
  expect(await row.evaluate(r => getComputedStyle(r).transform)).toBe('matrix(1, 0, 0, 1, -104, 0)');
  await shot(page, '09-swiped');
  await page.locator('#cats .swipe', { hasText: 'Concert' }).getByRole('button', { name: 'Mark done' }).click();
  const full = page.getByRole('dialog', { name: 'Close out Concert' });
  await expect(full).toContainText('Concert is at −$60.00');
  await full.getByRole('button', { name: 'Cancel' }).click();
  await expect(full).toBeHidden();
});

test('a row swiped open stays open through a background sync, on the overview and in the menu', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  const open = 'matrix(1, 0, 0, 1, -104, 0)';
  const row = page.locator('#cats .cat', { hasText: 'Japan trip' });
  await swipeLeft(page, row);
  await page.evaluate(() => window.piggy.store.flush());
  await synced(page);
  expect(await row.evaluate(r => getComputedStyle(r).transform)).toBe(open);
  await row.click(); // a tap shuts it
  await page.locator('#menuBtn').click();
  await page.waitForTimeout(400);
  const arch = page.getByRole('navigation', { name: 'Menu' }).locator('.cat.arch').first();
  await swipeLeft(page, arch);
  await page.evaluate(() => window.piggy.store.flush());
  await synced(page);
  expect(await arch.evaluate(r => getComputedStyle(r).transform)).toBe(open);
  await page.keyboard.press('Escape');
});

test('archived categories are listed in the menu and can be restored', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  await page.locator('#menuBtn').click();
  const menu = page.getByRole('navigation', { name: 'Menu' });
  await expect(menu.locator('.cat.arch')).toHaveCount(1);
  await expect(menu.locator('.cat.arch')).toContainText('Nintendo Switch 2');
  await page.waitForTimeout(400);
  await shot(page, '10-menu');
  await menu.locator('.cat.arch').click();
  const d = page.getByRole('dialog', { name: 'Nintendo Switch 2' });
  await expect(d.locator('.total')).toHaveText('$450.00');
  await d.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#cats .cat', { hasText: 'Nintendo' })).toContainText('$0.00');
  await synced(page);
  expect((await serverState(page)).categories.find(c => c.name === 'Nintendo Switch 2').archived).toBeNull();
  // an empty category archives without withdrawing anything
  await page.locator('#cats .cat', { hasText: 'Nintendo' }).click();
  await page.getByRole('dialog', { name: 'Nintendo Switch 2' }).getByRole('button', { name: 'Mark goal done' }).click();
  await page.locator('#closeGo').click();
  await expect(page.locator('#cats .cat', { hasText: 'Nintendo' })).toHaveCount(0);
});

test('an archived category is deleted with a swipe and a confirmation, keeping other balances', async ({ page }) => {
  await page.goto('/');
  await synced(page);
  const before = await serverState(page), japan = before.categories.find(c => c.name === 'Japan trip').id;
  await page.locator('#menuBtn').click();
  const menu = page.getByRole('navigation', { name: 'Menu' });
  await page.waitForTimeout(400);
  const row = menu.locator('.cat.arch', { hasText: 'Nintendo' });
  await swipeLeft(page, row);
  await menu.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete category' });
  await expect(confirm).toContainText('Delete Nintendo Switch 2?');
  await expect(confirm).toContainText('Money it moved to or from other categories stays with them.');
  await page.waitForTimeout(400);
  await shot(page, '11-confirm-delete');
  // cancelling keeps it
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(menu.locator('.cat.arch', { hasText: 'Nintendo' })).toHaveCount(1);
  await swipeLeft(page, row);
  await menu.getByRole('button', { name: 'Delete' }).click();
  await page.locator('#confirmDelete').click();
  await expect(menu.locator('.cat.arch')).toHaveCount(0);
  await synced(page);
  const s = await serverState(page);
  expect(s.categories.map(c => c.name)).toEqual(['Japan trip', 'Concert']);
  expect(balanceOf(s, japan)).toBe(balanceOf(before, japan));
  expect(s.transactions.find(t => t.note === 'To Nintendo Switch 2')).toMatchObject({ type: 'withdraw', cat: japan, amount: 30050, to: null });
  expect(s.transactions.find(t => t.note === 'Leftover · from Nintendo Switch 2')).toMatchObject({ type: 'add', cat: japan, amount: 1050 });
  const total = s.transactions.reduce((a, t) => a + (t.type === 'add' ? t.amount : t.type === 'withdraw' ? -t.amount : 0), 0);
  await expect(page.locator('#total')).toHaveText(fmtCents(total));
});
const fmtCents = c => (c < 0 ? '−' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

test('no horizontal scrolling at iPhone width', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
