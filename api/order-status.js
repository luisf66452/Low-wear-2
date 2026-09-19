const Stripe = require('stripe');

function maskEmail(value) {
  if (!value || !value.includes('@')) return '';
  const [name, domain] = value.split('@');
  return name.slice(0, 2) + '***@' + domain;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://lowwear.shop');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'stripe_not_configured' });

  const sessionId = typeof req.query?.session_id === 'string' ? req.query.session_id.trim() : '';
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255) {
    return res.status(400).json({ error: 'invalid_session' });
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });
    const items = (session.line_items?.data || []).map((line) => ({
      name: line.description || 'Artigo Low Wear',
      quantity: line.quantity || 1,
      amount: typeof line.amount_total === 'number' ? line.amount_total / 100 : null,
    }));
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    return res.status(paid ? 200 : 202).json({
      paid,
      status: session.status,
      paymentStatus: session.payment_status,
      orderReference: session.client_reference_id || session.metadata?.order_reference || session.id.slice(-12).toUpperCase(),
      amountTotal: typeof session.amount_total === 'number' ? session.amount_total / 100 : null,
      currency: (session.currency || 'eur').toUpperCase(),
      customerName: session.customer_details?.name || '',
      customerEmail: maskEmail(session.customer_details?.email || session.customer_email || ''),
      items,
      confirmationEmailEnabled: Boolean(process.env.RESEND_API_KEY && process.env.ORDER_EMAIL_FROM),
    });
  } catch (error) {
    if (error?.code === 'resource_missing') return res.status(404).json({ error: 'order_not_found' });
    console.error('[order-status]', error);
    return res.status(500).json({ error: 'order_lookup_failed' });
  }
};

