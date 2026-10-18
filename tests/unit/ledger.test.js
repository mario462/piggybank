import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balances, total, borrowed, series, netSince, fmt, parseAmount, sortTxs, dropCategory, MAX_CENTS } from '../../public/js/ledger.js';
import { validateTransaction } from '../../server/validate.js';

const cats = [{ id: 'a' }, { id: 'b' }];
const txs = [
  { id: '1', t: 1, type: 'add', cat: 'a', amount: 10000 },
  { id: '2', t: 2, type: 'add', cat: 'b', amount: 5000 },
  { id: '3', t: 3, type: 'transfer', cat: 'a', to: 'b', amount: 2500 },
  { id: '4', t: 4, type: 'withdraw', cat: 'b', amount: 9000 },
];

test('balances replay adds, transfers and withdrawals', () => {
  assert.deepEqual(balances(cats, txs), { a: 7500, b: -1500 });
});
test('a category may go below zero and is counted as borrowed', () => {
  const b = balances(cats, txs);
  assert.equal(total(b), 6000);
  assert.equal(borrowed(b), -1500);
});
test('transfers never change the total', () => {
  const b = balances(cats, txs.slice(0, 3));
  assert.equal(total(b), 15000);
});
test('series tracks the total, and a single category including transfers', () => {
  assert.deepEqual(series(cats, txs).map(p => p.v), [10000, 15000, 15000, 6000]);
  assert.deepEqual(series(cats, txs, 'b').map(p => p.v), [5000, 7500, -1500]);
});
test('series sorts by time even if transactions arrive out of order', () => {
  assert.deepEqual(series(cats, [txs[1], txs[0]]).map(p => p.t), [1, 2]);
  assert.deepEqual(sortTxs([{ id: 'x', t: 5, seq: 2 }, { id: 'y', t: 5, seq: 1 }]).map(t => t.id), ['y', 'x']);
});
test('netSince ignores transfers', () => {
  assert.equal(netSince(txs, 2), 5000 - 9000);
});
test('fmt formats cents with sign', () => {
  assert.equal(fmt(123456), '$1,234.56');
  assert.equal(fmt(-6000), '−$60.00');
  assert.equal(fmt(500, { sign: true }), '+$5.00');
  assert.equal(fmt(45000, { whole: true }), '$450');
});
test('parseAmount is exact and rejects junk', () => {
  assert.equal(parseAmount('12'), 1200);
  assert.equal(parseAmount('0.1'), 10);
  assert.equal(parseAmount('19.99'), 1999);
  assert.equal(parseAmount('$1,250.75'), 125075);
  assert.equal(parseAmount('1.234'), 0);
  assert.equal(parseAmount('abc'), 0);
  assert.equal(parseAmount('-5'), 0);
  assert.equal(parseAmount(''), 0);
});

test('parseAmount reads a comma typed as the decimal point', () => {
  assert.equal(parseAmount('12,50'), 1250);
  assert.equal(parseAmount('12,5'), 1250);
  assert.equal(parseAmount('12,'), 1200);
  assert.equal(parseAmount('0,99'), 99);
  assert.equal(parseAmount('1.250,75'), 125075);
  // a thousands comma has three digits after it
  assert.equal(parseAmount('1,250'), 125000);
  assert.equal(parseAmount('12,345,678'), 1234567800);
});

test('deleting a category keeps the money it moved with the other categories', () => {
  const cs = [{ id: 'a', name: 'Japan trip' }, { id: 'b', name: 'Savings' }];
  const ts = [
    { id: '1', t: 1, type: 'add', cat: 'a', amount: 10000 },
    { id: '2', t: 2, type: 'transfer', cat: 'b', to: 'a', amount: 500, note: '' },
    { id: '3', t: 3, type: 'transfer', cat: 'a', to: 'b', amount: 2000, note: 'Leftover' },
    { id: '4', t: 4, type: 'withdraw', cat: 'a', amount: 8500, note: 'Goal done' },
    { id: '5', t: 5, type: 'add', cat: 'b', amount: 100 },
  ];
  const before = balances(cs, ts).b;
  const r = dropCategory(cs, ts, 'a');
  assert.deepEqual(r.cats, [{ id: 'b', name: 'Savings' }]);
  assert.deepEqual(r.txs.map(t => [t.id, t.type, t.cat, t.to, t.note]), [
    ['2', 'withdraw', 'b', null, 'To Japan trip'],
    ['3', 'add', 'b', null, 'Leftover · from Japan trip'],
    ['5', 'add', 'b', undefined, undefined],
  ]);
  assert.equal(balances(r.cats, r.txs).b, before);
});

test('the app caps amounts exactly where the server does', () => {
  const tx = amount => () => validateTransaction({ id: 'tx00000001', type: 'add', cat: 'cat0000001', amount });
  assert.doesNotThrow(tx(MAX_CENTS));
  assert.throws(tx(MAX_CENTS + 1));
});
