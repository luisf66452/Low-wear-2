# Low Wear checkout API

O projeto cria sessões Stripe, confirma pagamentos por webhook e expõe apenas o resumo necessário para a página de confirmação da loja.

## Variáveis de ambiente

- `STRIPE_SECRET_KEY`: chave secreta já usada pelo checkout.
- `SITE_URL`: `https://lowwear.shop`.
- `STRIPE_WEBHOOK_SECRET`: segredo do endpoint `https://low-wear-2.vercel.app/api/stripe-webhook`.
- `RESEND_API_KEY`: opcional, ativa os emails automáticos.
- `ORDER_EMAIL_FROM`: remetente verificado, por exemplo `Low Wear <encomendas@lowwear.shop>`.
- `ORDER_EMAIL_TO`: email interno que recebe cada nova encomenda paga.

## Webhook Stripe

Registar o endpoint `/api/stripe-webhook` para estes eventos:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

O corpo é validado com a assinatura Stripe. Os emails usam chaves de idempotência baseadas na sessão para evitar duplicados durante as tentativas automáticas do webhook.

