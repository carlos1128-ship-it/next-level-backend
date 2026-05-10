# Migracao de Provedor de Pagamento

## Decisao

A AbacatePay foi desativada como provedor ativo porque exige CNPJ no fluxo atual. A NEXT LEVEL AI ainda nao possui CNPJ, entao o provedor ativo passa a ser Cakto.

## Preservado

O billing interno nao foi removido:

- `BillingPlan`
- `BillingPlanPrice`
- `Subscription`
- `PaymentEvent`
- `/api/billing/plans`
- `/api/billing/me`
- `/api/billing/checkout`
- `/api/billing/cancel`
- `/api/billing/change-plan`
- `/api/billing/webhooks/*`
- `SubscriptionGuard`
- `@RequirePlan()`
- parede obrigatoria `/planos`
- `/billing/success`
- planos no login
- hierarquia Comum, Premium e Pro Business
- regras de acesso backend/frontend por assinatura
- grants admin/dev e sincronizacao legacy, quando configurados

## Provider ativo

```env
BILLING_PAYMENT_PROVIDER=CAKTO
```

Alias aceito:

```env
BILLING_PAYMENT_PROVIDER=CACTO
```

Internamente o alias e normalizado para `CAKTO`.

## Como alternar

- `MANUAL`: sem checkout externo, util para manutencao/admin grants.
- `ABACATEPAY`: adaptador legado mantido para historico e compatibilidade.
- `CAKTO`: provedor ativo atual.

Placeholders reconhecidos:

- `ASAAS`
- `MERCADO_PAGO`

Esses placeholders caem no comportamento indisponivel ate um adaptador real existir.

## Isolamento AbacatePay

O backend nao exige mais:

- `ABACATEPAY_API_KEY`
- `ABACATEPAY_WEBHOOK_SECRET`
- `ABACATEPAY_*_PRODUCT_ID`

Essas variaveis continuam aceitas apenas se `BILLING_PAYMENT_PROVIDER=ABACATEPAY`.

## Cakto

A primeira integracao usa links fixos de checkout/oferta copiados do painel Cakto. A API Cakto fica preparada para:

- OAuth2
- listar/obter ofertas
- listar/obter pedidos
- reembolsar pedido futuramente
- criar webhook futuramente
- validar pedido no webhook quando `CAKTO_VERIFY_ORDER_ON_WEBHOOK=true`

Nenhum endpoint de checkout inexistente foi inventado.
