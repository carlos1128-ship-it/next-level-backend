# Integracao Cakto

## Objetivo

A Cakto e o provedor ativo de pagamentos da NEXT LEVEL AI enquanto a empresa ainda nao possui CNPJ para operar o fluxo atual da AbacatePay.

O billing interno permanece no backend:

- `BillingPlan`, `BillingPlanPrice`, `Subscription` e `PaymentEvent`
- checkout autenticado em `/api/billing/checkout`
- webhooks publicos em `/api/billing/webhooks/cakto`
- liberacao de acesso somente apos webhook valido e assinatura local atualizada

## Setup no painel Cakto

1. Crie a conta na Cakto.
2. Acesse `Integracoes` > `Cakto API`.
3. Crie uma chave de API e salve:
   - `client_id`
   - `client_secret`
4. Use o minimo de escopos necessario:
   - `read`
   - `write`, se for criar webhooks pela API
   - `products`
   - `offers`
   - `orders`
   - `webhooks`, se for criar webhooks pela API
5. Crie os produtos/ofertas:
   - Next Level Comum Mensal
   - Next Level Comum Anual
   - Next Level Premium Mensal
   - Next Level Premium Anual
   - Next Level Pro Business Mensal
   - Next Level Pro Business Anual
6. Configure ofertas mensais como recorrencia mensal e anuais como recorrencia anual, quando disponivel.
7. Habilite Pix, cartao de credito e boleto se desejado.
8. Para cada produto/oferta, copie:
   - product ID
   - offer ID
   - checkout/payment link
9. Configure a URL de retorno no produto/oferta:
   - `FRONTEND_URL + "/billing/success?provider=cakto"`

## Variaveis no Render

```env
BILLING_PAYMENT_PROVIDER=CAKTO
CAKTO_API_BASE_URL=https://api.cakto.com.br
CAKTO_CLIENT_ID=
CAKTO_CLIENT_SECRET=
CAKTO_WEBHOOK_SECRET=
CAKTO_VERIFY_ORDER_ON_WEBHOOK=true

CAKTO_COMMON_MONTHLY_CHECKOUT_URL=
CAKTO_COMMON_ANNUAL_CHECKOUT_URL=
CAKTO_PREMIUM_MONTHLY_CHECKOUT_URL=
CAKTO_PREMIUM_ANNUAL_CHECKOUT_URL=
CAKTO_PRO_BUSINESS_MONTHLY_CHECKOUT_URL=
CAKTO_PRO_BUSINESS_ANNUAL_CHECKOUT_URL=

CAKTO_COMMON_MONTHLY_PRODUCT_ID=
CAKTO_COMMON_MONTHLY_OFFER_ID=
CAKTO_COMMON_ANNUAL_PRODUCT_ID=
CAKTO_COMMON_ANNUAL_OFFER_ID=
CAKTO_PREMIUM_MONTHLY_PRODUCT_ID=
CAKTO_PREMIUM_MONTHLY_OFFER_ID=
CAKTO_PREMIUM_ANNUAL_PRODUCT_ID=
CAKTO_PREMIUM_ANNUAL_OFFER_ID=
CAKTO_PRO_BUSINESS_MONTHLY_PRODUCT_ID=
CAKTO_PRO_BUSINESS_MONTHLY_OFFER_ID=
CAKTO_PRO_BUSINESS_ANNUAL_PRODUCT_ID=
CAKTO_PRO_BUSINESS_ANNUAL_OFFER_ID=
```

No frontend/Vercel mantenha apenas:

```env
NEXT_PUBLIC_API_URL=https://<backend>/api
```

Nunca envie `CAKTO_CLIENT_SECRET` ou `CAKTO_WEBHOOK_SECRET` ao frontend.

## Webhook

1. Acesse `Integracoes` / `Apps` / `Webhooks`.
2. Crie um webhook:
   - Nome: `NEXT LEVEL Billing Webhook`
   - URL: `BACKEND_URL + "/api/billing/webhooks/cakto"`
3. Selecione os produtos da NEXT LEVEL.
4. Selecione eventos:
   - `purchase_approved`
   - `purchase_refused`
   - `refund`
   - `chargeback`
   - `subscription_created`
   - `subscription_canceled`
   - `subscription_renewed`
   - `subscription_renewal_refused`
   - `checkout_abandonment`
   - `pix_gerado`
   - `boleto_gerado`
5. Copie o secret/token do webhook e configure `CAKTO_WEBHOOK_SECRET`.

## Validacao

O backend aceita o segredo em locais seguros e flexiveis:

- `x-cakto-secret`
- `x-webhook-secret`
- `authorization`
- `body.secret`
- `body.token`
- `body.fields.secret`
- `body.fields.token`

Em producao, webhook sem segredo valido retorna `401` e nao ativa assinatura.

## Eventos

Ativam acesso:

- `purchase_approved`
- `subscription_renewed`

Mantem pendente:

- `subscription_created`, salvo se payload/order indicar pago ou ativo
- `checkout_abandonment`
- `pix_gerado`
- `boleto_gerado`
- `picpay_gerado`
- `openfinance_nubank_gerado`

Bloqueiam acesso:

- `purchase_refused`
- `subscription_canceled`
- `subscription_renewal_refused`
- `refund`
- `chargeback`

## OAuth

O backend autentica em:

```text
POST https://api.cakto.com.br/public_api/token/
Content-Type: application/x-www-form-urlencoded
```

Corpo:

```text
client_id=<CAKTO_CLIENT_ID>
client_secret=<CAKTO_CLIENT_SECRET>
```

O token fica em cache em memoria ate perto da expiracao. Se a API retornar `401`, o backend busca um novo token e tenta a chamada uma vez novamente.

## Estrategia de checkout

Esta versao usa links fixos de checkout/oferta copiados do painel Cakto.

O backend nao cria checkout via API porque a documentacao oficial confirmada mostra produtos, ofertas, pedidos, webhooks e `checkoutUrl` em pedidos, mas nao um endpoint oficial de criacao de checkout para este fluxo.

Ao criar checkout local:

- a assinatura fica `PENDING`
- `provider=CAKTO`
- o link recebe parametros seguros quando aceitos:
  - `sck=<subscriptionId>`
  - `utm_source=next_level`
  - `utm_medium=billing`
  - `utm_campaign=<PLAN>_<CYCLE>`
  - `email=<user.email>`

## Checklist de producao

- `BILLING_PAYMENT_PROVIDER=CAKTO`
- todos os 6 links de checkout configurados
- `CAKTO_CLIENT_ID` e `CAKTO_CLIENT_SECRET` no Render
- `CAKTO_WEBHOOK_SECRET` no Render
- webhook da Cakto testado com segredo valido
- segredo invalido testado com resposta `401`
- `PaymentEvent` criado para eventos validos
- usuario novo sem pagamento continua bloqueado em `/planos`
- admin/dev em `BILLING_ADMIN_EMAILS` continua com acesso Pro Business
