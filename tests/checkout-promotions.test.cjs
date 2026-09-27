const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const original = require('../api/_catalog');
const source = fs.readFileSync(path.join(root, 'api/create-checkout-session.js'), 'utf8');
const line = (quantity, productId = 'sel-principal-24', customName = '') =>
  ({ quantity, productId, size: 'M', customName });
async function checkout(lines, configure = () => {}, pairOn = false) {
  const catalog = structuredClone(original);
  // Preços fixos de teste (os testes verificam a lógica, não o preçário atual).
  for (const [id, price] of [['sel-principal-24', 59.9], ['sao-principal-24', 69.9], ['ben-principal-24', 49.9]])
    catalog.PRODUCTS.find(p => p.id === id).price = price;
  if (!pairOn) catalog.PAIR_CONFIG.enabled = false;
  configure(catalog);
  let request;
  const context = { module: { exports: {} }, console,
    process: { env: { STRIPE_SECRET_KEY: 'test-stub' } },
    Date: class extends Date { static now() { return Date.parse('2026-09-20T12:00:00Z'); } },
    require(name) {
      if (name === './_catalog') return catalog;
      if (name === 'stripe') return () => ({ checkout: { sessions: {
        create: async params => { request = params; return { url: 'https://checkout.stripe.com/test-stub' }; },
      } } });
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, context);
  const response = { setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
  await context.module.exports({ method: 'POST', body: { lines } }, response);
  return { response, request };
}
for (const [qty, free] of [[1,0],[2,0],[3,1],[4,1],[5,1],[6,3],[7,3],[8,3],[9,5],[10,5],[11,5],[12,7],[13,7],[14,7],[15,9],[16,9],[100,9]]) {
  test('quantity ' + qty + ': retains all units and charges ' + (qty-free), async () => {
    const { response, request } = await checkout([line(qty)]);
    assert.equal(response.code, 200);
    assert.equal(response.body.freeUnits, free);
    assert.equal(request.line_items.length, qty);
    assert.equal(request.line_items.filter(l => l.price_data.unit_amount === 0).length, free);
    assert.equal(request.line_items.reduce((s,l) => s+l.price_data.unit_amount*l.quantity,0), (qty-free)*5990);
    assert.equal(response.body.total, (qty-free)*5990/100);
    assert.equal(request.allow_promotion_codes, false);
    assert.equal(request.discounts, undefined);
  });
}
test('split lines and one quantity produce the same price', async () => {
  const a = await checkout([line(15)]);
  const b = await checkout(Array.from({length:15}, () => line(1)));
  assert.equal(a.response.body.total, b.response.body.total);
});
test('mixed prices: cheapest offer retains its size and personalization', async () => {
  const { request, response } = await checkout([line(1,'sao-principal-24'),line(1),line(1,'ben-principal-24','ANA')]);
  assert.equal(response.body.discount, 57.9);
  assert.equal(response.body.total, 129.8);
  const free = request.line_items.find(l => l.price_data.unit_amount === 0);
  assert.match(free.price_data.product_data.name, /Tam. M.*ANA.*OFERTA/);
});
test('seasonal can win by value despite fewer free units', async () => {
  const { response } = await checkout([line(3,'sao-principal-24'),line(3,'ben-principal-24')], c => {
    c.PRODUCTS.find(p => p.id === 'ben-principal-24').price = 1;
    c.PROMO_CONFIG.requiredQuantity = 3;
    c.PROMO_CONFIG.freeQuantity = 1;
    c.PROMO_CONFIG.eligibleProducts = ['sao-principal-24'];
  });
  assert.equal(response.body.discount, 69.9);
  assert.equal(response.body.freeUnits, 1);
});
test('expired campaign keeps permanent tiers', async () => {
  const { response } = await checkout([line(12)], c => { c.PROMO_CONFIG.promotionEnd = '2020-01-01'; });
  assert.equal(response.body.freeUnits, 7);
});
test('eligibility counts participating units only', async () => {
  const { response } = await checkout([line(2),line(4,'ben-principal-24')], c => {
    c.PROMO_CONFIG.promotionEnabled = false;
    c.TIER_CONFIG.eligibleProducts = ['sel-principal-24'];
  });
  assert.equal(response.body.freeUnits, 0);
});
test('disabled promotions charge full price', async () => {
  const { response } = await checkout([line(6)], c => {
    c.PROMO_CONFIG.promotionEnabled = false; c.TIER_CONFIG.enabled = false;
  });
  assert.equal(response.body.total, 359.4);
});
test('seasonal application limit is respected', async () => {
  const { response } = await checkout([line(12)], c => {
    c.TIER_CONFIG.enabled = false; c.PROMO_CONFIG.maximumApplicationsPerOrder = 2;
  });
  assert.equal(response.body.freeUnits, 6);
});
test('client prices and discounts are ignored', async () => {
  const { response } = await checkout([{ ...line(3), unitPrice: 0.01, price: 0, discount: 9999 }]);
  assert.equal(response.body.total, 119.8);
});
for (const qty of [0,-1,1.5,'3',101]) {
  test('rejects invalid or oversized quantity ' + qty, async () => {
    const { response, request } = await checkout([line(qty)]);
    assert.equal(response.code, 400);
    assert.equal(request, undefined);
  });
}
test('rejects more than 100 total units across lines', async () => {
  const { response } = await checkout([line(60),line(41)]);
  assert.equal(response.code, 400);
});
test('rejects unknown products and invalid sizes', async () => {
  for (const item of [line(3,'missing'), { ...line(3), size:'XXL' }, null]) {
    const { response, request } = await checkout([item]);
    assert.equal(response.code, 400);
    assert.equal(request, undefined);
  }
});

// ---------- "2 por 79 €" (PAIR_CONFIG) ----------
test('pair: 2 camisolas custam 79 € e as duas continuam no pedido', async () => {
  const { response, request } = await checkout([line(1), line(1, 'ben-principal-24')], undefined, true);
  assert.equal(response.body.total, 79);
  assert.equal(response.body.promotion, '2 por 79 €');
  assert.equal(response.body.freeUnits, 0);
  assert.equal(request.line_items.length, 2);
  assert.equal(request.line_items.reduce((s, l) => s + l.price_data.unit_amount, 0), 7900);
  assert.ok(request.line_items.every(l => /2 por 79/.test(l.price_data.product_data.name)));
});
test('pair: personalização é cobrada à parte', async () => {
  const { response } = await checkout([line(1, 'sel-principal-24', 'ANA'), line(1)], undefined, true);
  assert.equal(response.body.total, 87);
});
test('pair: nunca soma com as outras promoções (3, 4, 6 unidades mantêm o escalão)', async () => {
  for (const [qty, total] of [[3, 119.8], [4, 179.7], [6, 179.7]]) {
    const { response } = await checkout([line(qty)], undefined, true);
    assert.equal(response.body.total, total);
  }
});
test('pair: só 1 par por encomenda', async () => {
  const { response } = await checkout([line(2)], c => { c.TIER_CONFIG.enabled = false; c.PROMO_CONFIG.promotionEnabled = false; }, true);
  assert.equal(response.body.total, 79);
  const four = await checkout([line(4)], c => { c.TIER_CONFIG.enabled = false; c.PROMO_CONFIG.promotionEnabled = false; }, true);
  assert.equal(four.response.body.total, 79 + 2 * 59.9);
});
test('pair: casacos não entram', async () => {
  const { response } = await checkout([line(2, 'sel-casaco-perola')], undefined, true);
  assert.equal(response.body.total, 119.8);
});
test('pair: desligado cobra preço normal', async () => {
  const { response } = await checkout([line(2)], c => { c.PAIR_CONFIG.enabled = false; }, true);
  assert.equal(response.body.total, 119.8);
});
