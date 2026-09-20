const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const catalog = require('../api/_catalog');

function response() {
  return { setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
}

function handler(file, stripe, env, fetch) {
  const context = { module: { exports: {} }, Buffer, console: { log() {}, warn() {}, error() {} },
    process: { env }, fetch,
    require(name) {
      if (name === 'stripe') return () => stripe;
      if (name === './_catalog') return catalog;
      if (name === 'crypto') return require('node:crypto');
      throw new Error(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), context);
  return context.module.exports;
}

async function runPurchase({ pages, status = 'paid', type = 'checkout.session.completed',
  token = 'test-token', badSignature = false } = {}) {
  const requests = [];
  const pageRequests = [];
  const stripe = {
    webhooks: { constructEvent() {
      if (badSignature) throw new Error('bad signature');
      return { type, data: { object: { id: 'cs_test_catalog' } } };
    } },
    checkout: { sessions: {
      retrieve: async () => ({ id: 'cs_test_catalog', payment_status: status,
        amount_total: 9980, currency: 'eur', client_reference_id: 'LW-TEST',
        customer_details: { email: 'buyer@example.com' }, line_items: { data: [] } }),
      listLineItems: async (id, params) => {
        assert.equal(id, 'cs_test_catalog');
        assert.equal(params.limit, 100);
        assert.equal(params.expand[0], 'data.price.product');
        pageRequests.push(params);
        const page = pages[pageRequests.length - 1];
        assert.ok(page, 'unexpected extra page request');
        return page;
      },
    } },
  };
  const webhook = handler('stripe-webhook.js', stripe, {
    STRIPE_SECRET_KEY: 'test-stub', STRIPE_WEBHOOK_SECRET: 'whsec_stub',
    META_CAPI_ACCESS_TOKEN: token,
  }, async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, text: async () => '{"events_received":1}' };
  });
  const res = response();
  await webhook({ method: 'POST', body: Buffer.from('{}'), headers: { 'stripe-signature': 'sig' } }, res);
  return { res, requests, pageRequests };
}

const item = (id, quantity, index) => ({ id: `li_${index}`, quantity,
  price: { product: { id: `prod_${index}`, metadata: { lowwear_product_id: id } } } });

test('checkout to Purchase preserves catalog IDs, repeated sizes and free items', async () => {
  let checkoutParams;
  const checkout = handler('create-checkout-session.js', { checkout: { sessions: {
    create: async params => { checkoutParams = params; return { url: 'https://checkout.stripe.com/test' }; },
  } } }, { STRIPE_SECRET_KEY: 'test-stub' });
  const res = response();
  await checkout({ method: 'POST', body: { lines: [
    { productId: 'ben-principal-24', size: 'M', quantity: 2, content_id: 'forged-id' },
    { productId: 'ben-principal-24', size: 'L', quantity: 1 },
  ] } }, res);
  assert.equal(res.code, 200);
  assert.equal(checkoutParams.line_items.length, 3);
  assert.equal(checkoutParams.line_items.filter(l => l.price_data.unit_amount === 0).length, 1);
  const items = checkoutParams.line_items.map((line, i) => {
    assert.equal(line.price_data.product_data.metadata.lowwear_product_id, 'ben-principal-24');
    return { id: `li_${i}`, quantity: line.quantity, amount_total: line.price_data.unit_amount,
      price: { product: { metadata: line.price_data.product_data.metadata } } };
  });
  const result = await runPurchase({ pages: [{ data: items, has_more: false }] });
  assert.equal(result.res.code, 200);
  assert.equal(result.requests.length, 1);
  assert.match(result.requests[0].url, /\/1074220551792024\/events/);
  const event = result.requests[0].body.data[0];
  assert.equal(event.event_name, 'Purchase');
  assert.equal(event.event_id, 'stripe_cs_test_catalog');
  assert.deepEqual(event.custom_data, { currency: 'EUR', value: 99.8, order_id: 'LW-TEST',
    content_ids: ['ben-principal-24'], content_type: 'product',
    contents: [{ id: 'ben-principal-24', quantity: 3 }], num_items: 3 });
});

test('async payment success reads all pages and aggregates quantities', async () => {
  const result = await runPurchase({ type: 'checkout.session.async_payment_succeeded', pages: [
    { data: [item('ben-principal-24', 2, 1)], has_more: true },
    { data: [item('ben-principal-24', 1, 2), item('sel-principal-24', 1, 3)], has_more: false },
  ] });
  assert.equal(result.res.code, 200);
  assert.equal(result.pageRequests[1].starting_after, 'li_1');
  const data = result.requests[0].body.data[0].custom_data;
  assert.deepEqual(data.content_ids, ['ben-principal-24', 'sel-principal-24']);
  assert.deepEqual(data.contents, [{ id: 'ben-principal-24', quantity: 3 }, { id: 'sel-principal-24', quantity: 1 }]);
  assert.equal(data.num_items, 4);
});

test('legacy or partially identified carts never send Stripe IDs or incomplete contents', async () => {
  for (const missing of [{ id: 'li_old', quantity: 1, price: { product: 'prod_old' } },
    item('', 1, 2), item('ben-principal-24', 0, 2)]) {
    const result = await runPurchase({ pages: [{ data: [item('sel-principal-24', 1, 1), missing], has_more: false }] });
    assert.equal(result.res.code, 200);
    const data = result.requests[0].body.data[0].custom_data;
    assert.equal(data.value, 99.8);
    assert.equal(data.content_ids, undefined);
    assert.equal(data.contents, undefined);
  }
});

test('unpaid sessions, invalid signatures and absent token cannot send Purchase', async () => {
  for (const config of [{ status: 'unpaid' }, { badSignature: true }, { token: '' }]) {
    const result = await runPurchase(config);
    assert.equal(result.requests.length, 0);
    assert.equal(result.pageRequests.length, 0);
    assert.equal(result.res.code, config.badSignature ? 400 : 200);
  }
});
