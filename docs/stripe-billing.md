# Stripe Billing

Stripe e o provedor oficial de assinaturas da NEXT LEVEL AI.

## Endpoints

- Checkout: `POST /api/billing/checkout`
- Portal do cliente: `POST /api/billing/portal`
- Webhook: `POST /api/billing/webhook/stripe`
- Plano atual: `GET /api/billing/me`

## Variaveis obrigatorias no Render

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ESSENTIAL_MONTHLY`
- `STRIPE_PRICE_ESSENTIAL_YEARLY`
- `STRIPE_PRICE_PREMIUM_MONTHLY`
- `STRIPE_PRICE_PREMIUM_YEARLY`
- `STRIPE_PRICE_PRO_BUSINESS_MONTHLY`
- `STRIPE_PRICE_PRO_BUSINESS_YEARLY`
- `FRONTEND_URL`
- `BACKEND_URL`

## Webhook

URL de producao: `BACKEND_URL/api/billing/webhook/stripe`

Eventos:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `payment_intent.succeeded`
- `entitlements.active_entitlement_summary.updated`

O backend valida `stripe-signature` com `STRIPE_WEBHOOK_SECRET`. A pagina de sucesso apenas informa o cliente; a ativacao do plano vem do webhook.
