# Integracao AbacatePay

## Setup no painel AbacatePay

Crie 6 produtos de assinatura na AbacatePay. O ciclo de cobranca deve ser configurado no produto, nao no checkout:

- Common Monthly
- Common Annual
- Premium Monthly
- Premium Annual
- Pro Business Monthly
- Pro Business Annual

Depois copie os IDs dos produtos para as variaveis de ambiente do backend:

- `ABACATEPAY_COMMON_MONTHLY_PRODUCT_ID`
- `ABACATEPAY_COMMON_ANNUAL_PRODUCT_ID`
- `ABACATEPAY_PREMIUM_MONTHLY_PRODUCT_ID`
- `ABACATEPAY_PREMIUM_ANNUAL_PRODUCT_ID`
- `ABACATEPAY_PRO_BUSINESS_MONTHLY_PRODUCT_ID`
- `ABACATEPAY_PRO_BUSINESS_ANNUAL_PRODUCT_ID`

## Webhook

Endpoint de producao:

`https://<BACKEND_DOMAIN>/api/billing/webhooks/abacatepay`

Configure o segredo com `ABACATEPAY_WEBHOOK_SECRET`.

Eventos suportados:

- `checkout.completed`
- `checkout.refunded`
- `checkout.disputed`
- `checkout.lost`
- `subscription.completed`
- `subscription.trial_started`
- `subscription.renewed`
- `subscription.cancelled`

O backend valida `X-Webhook-Signature` quando enviado pela AbacatePay usando HMAC-SHA256 e tambem aceita os fallbacks seguros `x-abacatepay-secret`, `x-webhook-secret`, `webhookSecret` ou `secret`. O payload bruto e salvo em `PaymentEvent` antes do processamento e eventos duplicados com `eventId` ja processado retornam `duplicated: true`.

## Variaveis no Render

Obrigatorias:

- `ABACATEPAY_API_KEY`
- `ABACATEPAY_WEBHOOK_SECRET`
- `ABACATEPAY_WEBHOOK_PUBLIC_KEY` quando a assinatura HMAC estiver habilitada na conta
- `ABACATEPAY_API_BASE_URL=https://api.abacatepay.com/v2`
- `ABACATEPAY_SUBSCRIPTION_METHODS=CARD`
- `FRONTEND_URL=https://next-level-front.vercel.app`
- `BACKEND_URL=https://<BACKEND_DOMAIN>`
- os 6 IDs de produto AbacatePay

Precos opcionais em centavos:

- `PLAN_COMMON_MONTHLY_CENTS=4990`
- `PLAN_COMMON_ANNUAL_CENTS=49900`
- `PLAN_PREMIUM_MONTHLY_CENTS=9700`
- `PLAN_PREMIUM_ANNUAL_CENTS=97000`
- `PLAN_PRO_BUSINESS_MONTHLY_CENTS=19700`
- `PLAN_PRO_BUSINESS_ANNUAL_CENTS=197000`

## Variaveis na Vercel

- `NEXT_PUBLIC_API_URL=https://<BACKEND_DOMAIN>`

Nao adicione `ABACATEPAY_API_KEY` ou segredo de webhook no frontend.

## Checklist de teste

1. Abrir `/login` e conferir a secao "Escolha seu nivel".
2. Alternar Mensal/Anual.
3. Registrar por email/senha.
4. Confirmar redirecionamento para `/planos`, nao `/dashboard`.
5. Tentar abrir `/dashboard` manualmente e confirmar retorno para `/planos`.
6. Clicar em Premium Mensal.
7. Confirmar `Subscription` local `PENDING`.
8. Confirmar chamada real `POST /subscriptions/create`.
9. Confirmar redirect para `data.url` da AbacatePay.
10. Receber `subscription.completed`.
11. Confirmar assinatura `ACTIVE`.
12. Confirmar sincronizacao de `User.plan` e `UsageQuota.currentTier`.
13. Acessar dashboard.
14. Fazer logout e login novamente.
15. Confirmar entrada direta com assinatura ativa.
16. Enviar cancelamento/reembolso/disputa e confirmar bloqueio.
17. Confirmar Common bloqueado em rota Premium quando `@RequirePlan('PREMIUM')` for usado.
18. Confirmar Premium acessando rotas Common.
19. Confirmar Pro Business acessando tudo.
20. Confirmar que a chave AbacatePay nao aparece no bundle frontend.
21. Confirmar webhook sem segredo retorna 403.
22. Confirmar webhook duplicado nao processa duas vezes.

## Checklist de producao

- Rodar `npx prisma migrate deploy`.
- Rodar `npx prisma generate`.
- Rodar `npm run build` no backend e frontend.
- Confirmar as 6 variaveis de produto no Render.
- Confirmar `FRONTEND_URL` e `CORS_ORIGINS`.
- Confirmar webhook da AbacatePay apontando para `/api/billing/webhooks/abacatepay`.
- Confirmar logs sem chave secreta ou dados sensiveis de cartao.

## MCP

A AbacatePay possui MCP para ferramentas de IA e agentes de desenvolvimento. Ele pode ajudar a inspecionar ou criar objetos durante desenvolvimento assistido, mas nao substitui o fluxo de producao. A aplicacao NEXT LEVEL chama a AbacatePay diretamente pelo backend NestJS usando `ABACATEPAY_API_KEY`; o frontend nunca acessa a API secreta.
