const Stripe = require('stripe');
const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function purchaseProducts(stripe, sessionId) {
  const quantities = new Map();
  let startingAfter;
  let complete = true;
  do {
    // retrieve(session) only includes a few lines; read every page explicitly.
    const page = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      expand: ['data.price.product'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const line of page.data) {
      const id = line.price?.product?.metadata?.lowwear_product_id;
      const quantity = line.quantity;
      if (typeof id !== 'string' || !id.trim() || !Number.isInteger(quantity) || quantity < 1) {
        complete = false;
        continue;
      }
      quantities.set(id, (quantities.get(id) || 0) + quantity);
    }
    if (!page.has_more) break;
    const next = page.data.at(-1)?.id;
    if (!next || next === startingAfter) throw new Error('Invalid Stripe line item pagination');
    startingAfter = next;
  } while (true);

  // Older sessions have no catalog IDs. Never substitute Stripe prod_* IDs,
  // guess from descriptions, or report a partially matched basket.
  if (!complete || !quantities.size) {
    console.warn('[meta.purchase.products] Catalog IDs unavailable for session', sessionId);
    return {};
  }
  const contents = Array.from(quantities, ([id, quantity]) => ({ id, quantity }));
  return {
    content_ids: contents.map(item => item.id),
    content_type: 'product',
    contents,
    num_items: contents.reduce((sum, item) => sum + item.quantity, 0),
  };
}

async function sendMetaPurchase(stripe, session, reference) {
  const pixelId = process.env.META_PIXEL_ID || '1074220551792024';
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v26.0';
  if (!accessToken) {
    console.log('[meta.capi] META_CAPI_ACCESS_TOKEN não configurado');
    return { skipped: true };
  }

  const products = await purchaseProducts(stripe, session.id);

  const email = normalizeEmail(session.customer_details?.email || session.customer_email);
  const phone = normalizePhone(session.customer_details?.phone);
  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (phone) userData.ph = [sha256(phone)];
  if (session.metadata?.meta_fbp) userData.fbp = session.metadata.meta_fbp;
  if (session.metadata?.meta_fbc) userData.fbc = session.metadata.meta_fbc;
  if (session.metadata?.client_ip) userData.client_ip_address = session.metadata.client_ip;
  if (session.metadata?.client_user_agent) {
    userData.client_user_agent = session.metadata.client_user_agent;
  }

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: `stripe_${session.id}`,
      action_source: 'website',
      event_source_url: process.env.SITE_URL || 'https://lowwear.shop',
      user_data: userData,
      custom_data: {
        currency: String(session.currency || 'eur').toUpperCase(),
        value: Number(session.amount_total || 0) / 100,
        order_id: reference,
        ...products,
      },
    }],
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  const response = await fetch(
    `https://graph.facebook.com/${apiVersion}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Meta CAPI ${response.status}: ${responseText}`);
  console.log('[meta.purchase]', responseText);
  return { sent: true };
}

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function money(cents, currency = 'eur') {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: currency.toUpperCase() }).format((cents || 0) / 100);
}

function addressHtml(details) {
  const address = details?.address;
  if (!address) return '';
  const parts = [address.line1, address.line2, [address.postal_code, address.city].filter(Boolean).join(' '), address.state, address.country].filter(Boolean);
  return parts.map(esc).join('<br>');
}

async function sendEmail({ to, subject, html, idempotencyKey }) {
  if (!process.env.RESEND_API_KEY || !process.env.ORDER_EMAIL_FROM || !to) return { skipped: true };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from: process.env.ORDER_EMAIL_FROM, to: [to], subject, html }),
  });
  if (!response.ok) throw new Error('Resend ' + response.status + ': ' + await response.text());
  return response.json();
}

function emailShell(title, intro, itemsHtml, total, footer) {
  return `<!doctype html><html><body style="margin:0;background:#f2f2ed;color:#111;font-family:Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;padding:32px 18px"><div style="background:#111;color:#fff;padding:18px 22px;font-weight:800;letter-spacing:3px">LOW WEAR</div>
    <div style="background:#fff;padding:28px 22px"><h1 style="font-size:26px;margin:0 0 12px">${esc(title)}</h1><p style="line-height:1.6;color:#555">${intro}</p>
    <div style="border-top:1px solid #ddd;border-bottom:1px solid #ddd;margin:22px 0">${itemsHtml}</div>
    <p style="font-size:18px"><strong>Total: ${esc(total)}</strong></p><p style="line-height:1.6;color:#555">${footer}</p></div></div></body></html>`;
}

async function fulfillPaidSession(stripe, session) {
  const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
  if (full.payment_status !== 'paid' && full.payment_status !== 'no_payment_required') return;
  const reference = full.client_reference_id || full.metadata?.order_reference || full.id.slice(-12).toUpperCase();
  try {
    await sendMetaPurchase(stripe, full, reference);
  } catch (error) {
    console.error('[meta.capi.purchase]', error);
  }
  const items = full.line_items?.data || [];
  const itemsHtml = items.map((line) => `<div style="padding:14px 0;border-bottom:1px solid #eee"><strong>${esc(line.description || 'Artigo Low Wear')}</strong><br><span style="color:#666">Quantidade: ${line.quantity || 1} · ${esc(money(line.amount_total, full.currency))}</span></div>`).join('');
  const total = money(full.amount_total, full.currency);
  const customerEmail = full.customer_details?.email || full.customer_email;
  const customerName = full.customer_details?.name || 'cliente';
  const intro = `Olá ${esc(customerName)}, recebemos o pagamento da encomenda <strong>${esc(reference)}</strong>. A equipa Low Wear vai agora preparar as suas peças.`;
  await sendEmail({
    to: customerEmail,
    subject: `Pagamento confirmado — ${reference}`,
    html: emailShell('Pagamento confirmado', intro, itemsHtml, total, 'Quando a encomenda for expedida, receberá a informação de acompanhamento no contacto indicado.'),
    idempotencyKey: `lowwear-${full.id}-customer`,
  });

  const storeEmail = process.env.ORDER_EMAIL_TO || process.env.STORE_EMAIL;
  const shipping = full.shipping_details || full.customer_details;
  await sendEmail({
    to: storeEmail,
    subject: `Nova encomenda paga — ${reference}`,
    html: emailShell('Nova encomenda paga', `Encomenda <strong>${esc(reference)}</strong> de ${esc(customerName)} (${esc(customerEmail || '')}).`, itemsHtml, total,
      `Telefone: ${esc(full.customer_details?.phone || 'não indicado')}<br>Entrega:<br>${addressHtml(shipping) || 'morada disponível na Stripe'}`),
    idempotencyKey: `lowwear-${full.id}-store`,
  });
  console.log('[order.paid]', JSON.stringify({ sessionId: full.id, reference, amountTotal: full.amount_total, items: items.length }));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'webhook_not_configured' });
  }
  const signature = req.headers['stripe-signature'];
  if (!signature) return res.status(400).json({ error: 'missing_signature' });

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(await rawBody(req), signature, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await fulfillPaidSession(stripe, event.data.object);
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[stripe-webhook]', error);
    return res.status(400).json({ error: 'webhook_failed', message: error.message });
  }
};

// Vercel precisa entregar os bytes originais para a assinatura da Stripe
// poder ser verificada antes de qualquer processamento do pedido.
module.exports.config = { api: { bodyParser: false } };
