const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
const originalEnv = { ...process.env };
let stripeFactory;

function response() {
  return {
    headers: {}, code: 0, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  delete process.env.RESEND_API_KEY;
  delete process.env.ORDER_EMAIL_FROM;
  delete process.env.ORDER_EMAIL_TO;
  Module._load = function (request, parent, isMain) {
    if (request === 'stripe') return stripeFactory;
    return originalLoad.call(this, request, parent, isMain);
  };
});

afterEach(() => {
  Module._load = originalLoad;
  process.env = { ...originalEnv };
  for (const path of ['../api/order-status', '../api/stripe-webhook']) {
    try { delete require.cache[require.resolve(path)]; } catch {}
  }
});

test('order status returns a paid order without exposing the full email', async () => {
  stripeFactory = () => ({ checkout: { sessions: { retrieve: async () => ({
    id: 'cs_test_123', status: 'complete', payment_status: 'paid',
    client_reference_id: 'LW-TEST-1234', amount_total: 11980, currency: 'eur',
    customer_details: { name: 'Ana Silva', email: 'ana@example.com' },
    line_items: { data: [{ description: 'Camisola — Tam. M', quantity: 2, amount_total: 11980 }] },
  }) } } });
  const handler = require('../api/order-status');
  const res = response();
  await handler({ method: 'GET', query: { session_id: 'cs_test_123' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.paid, true);
  assert.equal(res.body.orderReference, 'LW-TEST-1234');
  assert.equal(res.body.amountTotal, 119.8);
  assert.equal(res.body.customerEmail, 'an***@example.com');
  assert.equal(res.body.items[0].quantity, 2);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
});

test('webhook verifies the signature and fulfils a paid checkout once', async () => {
  let retrieved = 0;
  stripeFactory = () => ({
    webhooks: { constructEvent: (body, signature, secret) => {
      assert.equal(signature, 'sig_test');
      assert.equal(secret, 'whsec_test');
      assert.equal(body.toString(), '{}');
      return { type: 'checkout.session.completed', data: { object: { id: 'cs_test_paid' } } };
    } },
    checkout: { sessions: { retrieve: async () => {
      retrieved += 1;
      return { id: 'cs_test_paid', payment_status: 'paid', client_reference_id: 'LW-PAID-1',
        amount_total: 5990, currency: 'eur', customer_details: { email: 'buyer@example.com', name: 'Buyer' },
        line_items: { data: [{ description: 'Camisola — Tam. M', quantity: 1, amount_total: 5990 }] } };
    } } },
  });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const handler = require('../api/stripe-webhook');
  const res = response();
  await handler({ method: 'POST', body: Buffer.from('{}'), headers: { 'stripe-signature': 'sig_test' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(retrieved, 1);
});

test('webhook rejects an invalid signature', async () => {
  stripeFactory = () => ({ webhooks: { constructEvent: () => { throw new Error('bad signature'); } } });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const handler = require('../api/stripe-webhook');
  const res = response();
  await handler({ method: 'POST', body: Buffer.from('{}'), headers: { 'stripe-signature': 'wrong' } }, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'webhook_failed');
});

