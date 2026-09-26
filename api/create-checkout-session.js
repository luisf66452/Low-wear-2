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
const ALLOWED_VERSIONS = ['Adepto', 'Jogador'];
const ALLOWED_BADGES = ['', 'Mundial 2026'];
const CUSTOM_NAME_SURCHARGE = 8; // € — mesmo valor que o site já cobrava por personalização
const BADGE_SURCHARGE = 2.9;

function isPromoActive(now) {
  if (!PROMO_CONFIG.promotionEnabled) return false;
  const start = new Date(PROMO_CONFIG.promotionStart).getTime();
  const end = new Date(PROMO_CONFIG.promotionEnd).getTime();
  return now >= start && now <= end;
}

// Devolve o escalão mais alto atingido por "quantity" unidades elegíveis,
// ou null se nenhum escalão for atingido. Mesma lógica que bestTierFor em
// js/data.js — mantida em espelho para o desconto bater certo dos dois lados.
function bestTierFor(quantity) {
  if (!TIER_CONFIG.enabled) return null;
  let best = null;
  for (const t of TIER_CONFIG.tiers) {
    if (quantity >= t.threshold && (!best || t.threshold > best.threshold)) best = t;
  }
  return best;
}

// Mantido em espelho no frontend/backend; os testes verificam a paridade.
function calculatePromotion(units, now = Date.now()) {
  const empty = () => ({ freeIndexes: new Set(), value: 0, label: '' });
  const eligible = (config) => units.map((u, idx) => ({
    idx, price: Math.round(u.unitPrice * 100), productId: u.product.id,
  })).filter(u => !config.eligibleProducts?.length || config.eligibleProducts.includes(u.productId))
    .sort((a, b) => a.price - b.price);
  const candidate = (items, count, label) => {
    const free = items.slice(0, count);
    return { freeIndexes: new Set(free.map(u => u.idx)),
      value: free.reduce((sum, u) => sum + u.price, 0), label: free.length ? label : '' };
  };
  let seasonal = empty();
  if (isPromoActive(now)) {
    const items = eligible(PROMO_CONFIG);
    const applications = Math.min(Math.floor(items.length / PROMO_CONFIG.requiredQuantity),
      PROMO_CONFIG.maximumApplicationsPerOrder);
    seasonal = candidate(items, applications * PROMO_CONFIG.freeQuantity,
      'Escolha ' + PROMO_CONFIG.requiredQuantity + ', pague ' + (PROMO_CONFIG.requiredQuantity - PROMO_CONFIG.freeQuantity));
  }
  const items = eligible(TIER_CONFIG);
  const tier = bestTierFor(items.length);
  const quantity = tier ? candidate(items, tier.threshold - tier.pay,
    'Leva ' + tier.threshold + ', paga ' + tier.pay) : empty();
  // Compara valores monetários, nunca soma as ofertas. Em empate, mostra o escalão.
  return quantity.value >= seasonal.value ? quantity : seasonal;
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
  const meta = body && body.meta && typeof body.meta === 'object' ? body.meta : {};
  const fbp = typeof meta.fbp === 'string' ? meta.fbp.slice(0, 200) : '';
  const fbc = typeof meta.fbc === 'string' ? meta.fbc.slice(0, 200) : '';
  const externalId = typeof meta.external_id === 'string' ? meta.external_id.slice(0, 100) : '';
  const forwardedFor = req.headers?.['x-forwarded-for'];
  const clientIp = String(Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor || '')
    .split(',')[0].trim().slice(0, 100);
  const clientUserAgent = String(req.headers?.['user-agent'] || '').slice(0, 500);
  const trackingMetadata = {};
  if (fbp) trackingMetadata.meta_fbp = fbp;
  if (fbc) trackingMetadata.meta_fbc = fbc;
  if (externalId) trackingMetadata.meta_external_id = externalId;
  if (clientIp) trackingMetadata.client_ip = clientIp;
  if (clientUserAgent) trackingMetadata.client_user_agent = clientUserAgent;

  const lines = body && Array.isArray(body.lines) ? body.lines : null;
  if (!lines || !lines.length) return res.status(400).json({ error: 'empty_cart' });

  // Expande cada linha (produto + tamanho + quantidade) em unidades
  // individuais, para poder aplicar a promoção "6 por 3" às unidades mais
  // baratas — exatamente como o Shopify fazia antes.
  const units = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') return res.status(400).json({ error: 'invalid_line' });
    const product = PRODUCTS.find((p) => p.id === line.productId);
    if (!product) return res.status(400).json({ error: 'invalid_product', productId: line.productId });
    const size = ALLOWED_SIZES.includes(line.size) ? line.size : null;
    if (!size || !product.sizes.includes(size)) {
      return res.status(400).json({ error: 'invalid_size', productId: line.productId, size: line.size });
    }
    const qty = line.quantity === undefined ? 1 : line.quantity;
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'invalid_quantity' });
    // Uma linha Stripe por unidade, incluindo ofertas; nunca truncar o pedido.
    if (units.length + qty > 100) return res.status(400).json({ error: 'cart_too_large', message: 'O limite é de 100 camisolas por encomenda.' });
    const customName = typeof line.customName === 'string' ? line.customName.trim().slice(0, 40) : '';
    const version = ALLOWED_VERSIONS.includes(line.version) ? line.version : 'Adepto';
    const badge = ALLOWED_BADGES.includes(line.badge) ? line.badge : '';
    for (let i = 0; i < qty; i++) {
      units.push({ product, size, customName, version, badge,
        unitPrice: product.price + (customName ? CUSTOM_NAME_SURCHARGE : 0) + (badge ? BADGE_SURCHARGE : 0) });
    }
  }

  // Duas promoções podem aplicar ao mesmo carrinho:
  //  - "Escolha 6, pague 3" (sazonal, com prazo) — PROMO_CONFIG
  //  - "Quanto mais levas, mais poupas" (permanente, por escalões) — TIER_CONFIG
  // Nunca se somam: calcula-se o valor de cada uma separadamente e aplica-se
  // só a que der mais desconto ao cliente (max()), exatamente como descrito
  // na página de produto.
  const promotion = calculatePromotion(units);
  const { freeIndexes } = promotion;
  const subtotalCents = units.reduce((sum, u) => sum + Math.round(u.unitPrice * 100), 0);

  // As ofertas continuam no pedido, com tamanho/personalização e valor zero.
  // Não ativar cupões adicionais: o maior desconto já está incluído nos preços.
  const line_items = units.map((u, idx) => ({
    price_data: {
      currency: 'eur',
      unit_amount: freeIndexes.has(idx) ? 0 : Math.round(u.unitPrice * 100),
      product_data: {
        metadata: { lowwear_product_id: u.product.id },
        name: u.product.name + ' — Tam. ' + u.size + ' — ' + u.version
          + (u.customName ? ' — "' + u.customName + '"' : '')
          + (u.badge ? ' — ' + u.badge : '')
          + (freeIndexes.has(idx) ? ' — OFERTA' : ''),
      },
    },
    quantity: 1,
  }));

  const siteUrl = process.env.SITE_URL || 'https://lowwear.shop';
  const orderReference = 'LW-' + Date.now().toString(36).toUpperCase()
    + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'pt',
      customer_creation: 'always',
      client_reference_id: orderReference,
      allow_promotion_codes: false,
      metadata: {
        order_reference: orderReference,
        promotion: promotion.label || 'none',
        free_units: String(freeIndexes.size),
        discount_cents: String(promotion.value),
        ...trackingMetadata,
      },
      payment_intent_data: {
        description: 'Encomenda ' + orderReference + ' — Low Wear',
        metadata: {
          order_reference: orderReference,
          promotion: promotion.label || 'none',
        },
      },
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
    return res.status(200).json({ url: session.url, orderReference, freeUnits: freeIndexes.size,
      subtotal: subtotalCents / 100, discount: promotion.value / 100,
      total: (subtotalCents - promotion.value) / 100, promotion: promotion.label });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: 'stripe_error', message: err.message });
  }
};
