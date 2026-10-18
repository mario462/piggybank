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

test('data survives a reload with an empty cache (server is the source of truth)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#total')).toHaveText('$1,140.00');
  await expect(page.locator('.cat')).toHaveCount(3);
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

test('no horizontal scrolling at iPhone width', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
