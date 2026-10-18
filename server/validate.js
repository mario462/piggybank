// Input validation for the API. Everything from the client is untrusted.

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_CENTS = 10_000_000_000; // $100M, far above any real piggy bank
const EARLIEST = Date.UTC(2000, 0, 1);

export class ValidationError extends Error {}

const fail = msg => { throw new ValidationError(msg); };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export function cleanText(v, max, field, { required = false } = {}) {
  if (v == null || v === '') return required ? fail(`${field} is required`) : '';
  if (typeof v !== 'string') fail(`${field} must be text`);
  // strip control characters, collapse whitespace
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !s) fail(`${field} is required`);
  if (s.length > max) fail(`${field} must be at most ${max} characters`);
  return s;
}

export function validId(v, field = 'id') {
  if (typeof v !== 'string' || !ID.test(v)) fail(`${field} is invalid`);
  return v;
}

function cents(v, field, { min = 1 } = {}) {
  if (!Number.isSafeInteger(v) || v < min || v > MAX_CENTS) fail(`${field} must be a whole number of cents between ${min} and ${MAX_CENTS}`);
  return v;
}

export function validateTransaction(body, now = Date.now()) {
  if (!isObj(body)) fail('body must be an object');
  const type = body.type;
  if (!['add', 'withdraw', 'transfer'].includes(type)) fail('type must be add, withdraw or transfer');
  const tx = {
    id: validId(body.id),
    type,
    cat: validId(body.cat, 'cat'),
    to: null,
    amount: cents(body.amount, 'amount'),
    note: cleanText(body.note, 200, 'note'),
    t: body.t == null ? now : body.t,
  };
  if (!Number.isSafeInteger(tx.t) || tx.t < EARLIEST || tx.t > now + 864e5) fail('t must be a timestamp in milliseconds');
  if (type === 'transfer') {
    tx.to = validId(body.to, 'to');
    if (tx.to === tx.cat) fail('cannot move money to the same category');
  } else if (body.to != null) fail('to is only allowed for transfers');
  return tx;
}

export function validateCategory(body, { partial = false } = {}, now = Date.now()) {
  if (!isObj(body)) fail('body must be an object');
  const out = {};
  if (!partial) out.id = validId(body.id);
  if (!partial || 'name' in body) out.name = cleanText(body.name, 60, 'name', { required: true });
  if (!partial || 'color' in body) {
    if (typeof body.color !== 'string' || !COLOR.test(body.color)) fail('color must look like #12abef');
    out.color = body.color.toLowerCase();
  }
  if (!partial || 'goal' in body) out.goal = cents(body.goal, 'goal', { min: 0 });
  // when the category was archived (a finished goal), or null to bring it back; only set by an update
  if (partial && 'archived' in body) {
    const a = body.archived;
    if (a !== null && (!Number.isSafeInteger(a) || a < EARLIEST || a > now + 864e5)) fail('archived must be a timestamp in milliseconds or null');
    out.archived = a;
  }
  if (partial && !Object.keys(out).length) fail('nothing to update');
  return out;
}
