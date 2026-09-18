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
const { PRODUCTS, PROMO_CONFIG } = require('./_catalog');

const ALLOWED_SIZES = ['S', 'M', 'L', 'XL'];
const CUSTOM_NAME_SURCHARGE = 8; // € — mesmo valor que o site já cobrava por personalização

function isPromoActive(now) {
  if (!PROMO_CONFIG.promotionEnabled) return false;
  const start = new Date(PROMO_CONFIG.promotionStart).getTime();
  const end = new Date(PROMO_CONFIG.promotionEnd).getTime();
  return now >= start && now <= end;
}

module.exports = async (req, res) => {
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

  let freeIndexes = new Set();
  if (isPromoActive(Date.now())) {
    const eligibleList = PROMO_CONFIG.eligibleProducts || [];
    const eligibleIdx = units
      .map((u, idx) => ({ idx, price: u.unitPrice, ok: !eligibleList.length || eligibleList.includes(u.product.id) }))
      .filter((u) => u.ok);
    if (eligibleIdx.length >= PROMO_CONFIG.requiredQuantity) {
      eligibleIdx.sort((a, b) => a.price - b.price);
      eligibleIdx.slice(0, PROMO_CONFIG.freeQuantity).forEach((u) => freeIndexes.add(u.idx));
    }
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
