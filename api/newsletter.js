// Low Wear — inscrição na newsletter.
//
// Antes, isto criava um "cliente" real na Shopify (visível em Shopify
// Admin → Clientes). Sem Shopify, esta versão simples só regista o email
// nos logs da função (Vercel → o seu projeto → aba "Logs"). Isso é
// suficiente para não perder nenhum email, mas não é uma lista de emails
// pronta a usar numa ferramenta de marketing.
//
// Para capturar os emails a sério, o mais simples é ligar isto a um
// serviço de email marketing (Brevo, Mailchimp, MailerLite, etc.).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const email = body && typeof body.email === 'string' ? body.email.trim() : '';
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!isValid) return res.status(400).json({ error: 'invalid_email' });

  console.log('[newsletter] nova inscrição:', email, new Date().toISOString());

  return res.status(200).json({ ok: true });
};
