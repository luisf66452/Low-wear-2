// Low Wear — cria uma sessão de checkout Stripe real a partir do carrinho.
//
// Porquê isto existe: o site (HTML/CSS/JS estático, hoje no GitHub Pages)
// não tem servidor próprio. Antes, o "carrinho" e o checkout eram feitos
// através da Storefront API de uma loja Shopify — essa loja Shopify foi
// apagada, por isso o checkout deixou de funcionar. Esta função Vercel
// substitui esse papel: recebe os itens do carrinho, calcula o preço real
// a partir do catálogo do SERVIDOR (nunca confia no preço vindo do
// browser, que podia ser alterado por alguém), aplica a promoção "escolha
// 6, pague 3" se estiver ativa, e cria uma Stripe Checkout Session.
//
// Variáveis de ambiente necessárias (definir no painel da Vercel, nunca
// aqui no código):
//   STRIPE_SECRET_KEY  — a chave secreta da sua conta Stripe (sk_live_... ou sk_test_...)
//   SITE_URL           — o domínio público do site, ex: https://lowwear.shop

const Stripe = require('stripe');
const { PRODUCTS, PROMO_CONFIG, TIER_CONFIG } = require('./_catalog');

const ALLOWED_SIZES = ['S', 'M', 'L', 'XL'];
const CUSTOM_NAME_SURCHARGE = 8; // € — mesmo valor que o site já cobrava por personalização

function isPromoActive(now) {
  if (!PROMO_CONFIG.promotionEnabled) return false;
  const start = new Date(PROMO_CONFIG.promotionStart).getTime();
  const end = new Date(PROMO_CONFIG.promotionEnd).getTime();
  return now >= start && now <= end;
}

// Escalão mais alto atingido por "quantity" unidades elegíveis da
// promoção "quanto mais levas, mais poupas" (TIER_CONFIG), ou null.
function bestTierFor(quantity) {
  if (!TIER_CONFIG.enabled) return null;
  let best = null;
  for (const t of TIER_CONFIG.tiers) {
    if (quantity >= t.threshold) best = t;
  }
  return best;
}

module.exports = async (req, res) => {
  // CORS: liberta para qualquer origem por simplicidade. Se quiser
  // restringir só ao seu site, troque '*' por 'https://lowwear.shop'.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'stripe_not_configured', message: 'Falta configurar STRIPE_SECRET_KEY nas variáveis de ambiente da Vercel.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const lines = body && Array.isArray(body.lines) ? body.lines : null;
  if (!lines || !lines.length) return res.status(400).json({ error: 'empty_cart' });

  // Expande cada linha (produto + tamanho + quantidade) em unidades
  // individuais, para poder aplicar a promoção "6 por 3" às unidades mais
  // baratas — exatamente como o Shopify fazia antes.
  const units = [];
  for (const line of lines) {
    const product = PRODUCTS.find((p) => p.id === line.productId);
    if (!product) return res.status(400).json({ error: 'invalid_product', productId: line.productId });
    const size = ALLOWED_SIZES.includes(line.size) ? line.size : null;
    if (!size || !product.sizes.includes(size)) {
      return res.status(400).json({ error: 'invalid_size', productId: line.productId, size: line.size });
    }
    const qty = Math.max(1, Math.min(10, parseInt(line.quantity, 10) || 1));
    const customName = typeof line.customName === 'string' ? line.customName.trim().slice(0, 40) : '';
    for (let i = 0; i < qty; i++) {
      units.push({ product, size, customName, unitPrice: product.price + (customName ? CUSTOM_NAME_SURCHARGE : 0) });
    }
  }

  // Duas promoções podem, em teoria, aplicar-se ao mesmo carrinho:
  //   1) "Escolha 6, pague 3" — sazonal, com prazo (PROMO_CONFIG).
  //   2) "Quanto mais levas, mais poupas" — permanente, por escalões
  //      (TIER_CONFIG), mostrada na página de produto.
  // Regra de segurança: NUNCA acumular as duas. Calcula-se o desconto de
  // cada uma de forma independente e aplica-se sempre o MAIOR dos dois
  // (nunca a soma), usando o conjunto de unidades elegíveis dessa mesma
  // promoção para escolher quais unidades ficam grátis.
  function eligibleUnits(list) {
    return units
      .map((u, idx) => ({ idx, price: u.unitPrice, ok: !list.length || list.includes(u.product.id) }))
      .filter((u) => u.ok);
  }

  let seasonalFree = 0;
  let seasonalPool = [];
  if (isPromoActive(Date.now())) {
    seasonalPool = eligibleUnits(PROMO_CONFIG.eligibleProducts || []);
    if (seasonalPool.length >= PROMO_CONFIG.requiredQuantity) {
      seasonalFree = PROMO_CONFIG.freeQuantity;
    }
  }

  let tierFree = 0;
  let tierPool = [];
  if (TIER_CONFIG.enabled) {
    tierPool = eligibleUnits(TIER_CONFIG.eligibleProducts || []);
    const tier = bestTierFor(tierPool.length);
    if (tier) tierFree = tier.threshold - tier.pay;
  }

  const freeIndexes = new Set();
  if (seasonalFree > 0 || tierFree > 0) {
    const useSeasonal = seasonalFree >= tierFree;
    const pool = useSeasonal ? seasonalPool : tierPool;
    const freeCount = useSeasonal ? seasonalFree : tierFree;
    pool.sort((a, b) => a.price - b.price);
    pool.slice(0, freeCount).forEach((u) => freeIndexes.add(u.idx));
  }

  const chargeable = units.filter((_, idx) => !freeIndexes.has(idx));
  if (!chargeable.length) return res.status(400).json({ error: 'nothing_to_charge' });

  const line_items = chargeable.map((u) => ({
    price_data: {
      currency: 'eur',
      unit_amount: Math.round(u.unitPrice * 100),
      product_data: {
        name: `${u.product.name} — Tam. ${u.size}${u.customName ? ` — "${u.customName}"` : ''}`,
      },
    },
    quantity: 1,
  }));

  const siteUrl = process.env.SITE_URL || 'https://lowwear.shop';

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      // A conta Stripe do cliente tem "Managed Payments" ativo por omissão,
      // uma funcionalidade da Stripe (Stripe age como "merchant of record")
      // que não é compatível com shipping_address_collection. Como aqui
      // queremos continuar a ser nós a gerir os envios (não a Stripe),
      // desativamos explicitamente essa funcionalidade nesta sessão.
      managed_payments: { enabled: false },
      phone_number_collection: { enabled: true },
      shipping_address_collection: {
        allowed_countries: ['PT', 'ES', 'FR', 'DE', 'IT', 'NL', 'BE', 'LU', 'IE', 'BR'],
      },
      success_url: `${siteUrl}/obrigado.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/index.html`,
    });
    return res.status(200).json({ url: session.url, freeUnits: freeIndexes.size });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: 'stripe_error', message: err.message });
  }
};
