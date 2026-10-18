import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTransaction, validateCategory, ValidationError } from '../../server/validate.js';

const now = Date.UTC(2026, 9, 18);
const tx = { id: 'abcdefgh12', type: 'add', cat: 'cat0000001', amount: 1500, note: ' paycheck ', t: now - 1000 };

test('accepts a valid deposit and trims the note', () => {
  assert.deepEqual(validateTransaction(tx, now), { ...tx, to: null, note: 'paycheck' });
});
test('rejects bad amounts', () => {
  for (const amount of [0, -1, 1.5, '100', 1e13, NaN, null]) {
    assert.throws(() => validateTransaction({ ...tx, amount }, now), ValidationError, String(amount));
  }
});
test('rejects unknown types and odd ids', () => {
  assert.throws(() => validateTransaction({ ...tx, type: 'steal' }, now), ValidationError);
  assert.throws(() => validateTransaction({ ...tx, id: "x'; DROP TABLE--" }, now), ValidationError);
  assert.throws(() => validateTransaction({ ...tx, cat: 'short' }, now), ValidationError);
});
test('transfers need a different destination; others must not have one', () => {
  assert.throws(() => validateTransaction({ ...tx, type: 'transfer' }, now), ValidationError);
  assert.throws(() => validateTransaction({ ...tx, type: 'transfer', to: tx.cat }, now), ValidationError);
  assert.equal(validateTransaction({ ...tx, type: 'transfer', to: 'cat0000002' }, now).to, 'cat0000002');
  assert.throws(() => validateTransaction({ ...tx, to: 'cat0000002' }, now), ValidationError);
});
test('rejects timestamps far in the future or before 2000', () => {
  assert.throws(() => validateTransaction({ ...tx, t: now + 3 * 864e5 }, now), ValidationError);
  assert.throws(() => validateTransaction({ ...tx, t: 1000 }, now), ValidationError);
});
test('limits note length and strips control characters', () => {
  assert.throws(() => validateTransaction({ ...tx, note: 'x'.repeat(201) }, now), ValidationError);
  assert.equal(validateTransaction({ ...tx, note: 'a\u0000b\nc' }, now).note, 'a b c');
});
test('categories: full and partial', () => {
  assert.deepEqual(validateCategory({ id: 'cat0000001', name: ' Japan ', color: '#7C9CFF', goal: 250000 }),
    { id: 'cat0000001', name: 'Japan', color: '#7c9cff', goal: 250000 });
  assert.deepEqual(validateCategory({ goal: 0 }, { partial: true }), { goal: 0 });
  assert.throws(() => validateCategory({ id: 'cat0000001', name: '', color: '#7C9CFF', goal: 1 }), ValidationError);
  assert.throws(() => validateCategory({ id: 'cat0000001', name: 'x', color: 'red', goal: 1 }), ValidationError);
  assert.throws(() => validateCategory({}, { partial: true }), ValidationError);
  assert.throws(() => validateCategory({ name: 'x'.repeat(61) }, { partial: true }), ValidationError);
});
