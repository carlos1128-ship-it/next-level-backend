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

Eventos para configurar no painel da AbacatePay:

- `checkout.completed`
- `checkout.refunded`
- `checkout.disputed`
- `checkout.lost`
- `subscription.completed`
- `subscription.renewed`
- `subscription.cancelled`
- `subscription.payment_failed`
- `subscription.trial_started`

Aliases em portugues aceitos apenas por compatibilidade:

- `assinatura.concluida` -> `subscription.completed`
- `assinatura.renovada` -> `subscription.renewed`
- `assinatura.cancelada` -> `subscription.cancelled`
- `assinatura.pagamento_falha` -> `subscription.payment_failed`
- `checkout.concluido` -> `checkout.completed`
- `checkout.reembolsado` -> `checkout.refunded`
- `checkout.disputado` -> `checkout.disputed`
- `checkout.perdido` -> `checkout.lost`

O backend valida `X-Webhook-Signature` quando enviado pela AbacatePay usando HMAC-SHA256 e tambem aceita os fallbacks seguros `x-abacatepay-secret`, `x-webhook-secret`, `webhookSecret` ou `secret`. O payload bruto e salvo em `PaymentEvent` antes do processamento e eventos duplicados com `eventId` ja processado retornam `duplicated: true`.

## Variaveis no Render

Obrigatorias:

- `ABACATEPAY_API_KEY`
- `ABACATEPAY_WEBHOOK_SECRET`
- `ABACATEPAY_WEBHOOK_PUBLIC_KEY` quando a assinatura HMAC estiver habilitada na conta
- `ABACATEPAY_API_BASE_URL=https://api.abacatepay.com/v2`
- `ABACATEPAY_SUBSCRIPTION_METHODS=CARD`
- `ABACATEPAY_ENABLE_PIX_SUBSCRIPTIONS=false`
- `FRONTEND_URL=https://next-level-front.vercel.app`
- `BACKEND_URL=https://<BACKEND_DOMAIN>`
- os 6 IDs de produto AbacatePay

Concessoes internas opcionais:

- `BILLING_ADMIN_EMAILS=seuemail@gmail.com,outro@email.com`
- `BILLING_LEGACY_GRACE_ENABLED=true`

Quando `BILLING_ADMIN_EMAILS` contem o e-mail do usuario, o backend cria uma assinatura interna `ADMIN_GRANT` com plano `PRO_BUSINESS`. Quando `BILLING_LEGACY_GRACE_ENABLED=true`, usuarios antigos `ENTERPRISE` recebem `INTERNAL_LEGACY` em `PRO_BUSINESS` e usuarios antigos `PRO` recebem `INTERNAL_LEGACY` em `PREMIUM`. Usuarios `COMUM` continuam bloqueados se nao tiverem assinatura ativa.

Metodo de pagamento:

- Com `ABACATEPAY_ENABLE_PIX_SUBSCRIPTIONS=false`, o backend sempre envia `["CARD"]`.
- Com `ABACATEPAY_ENABLE_PIX_SUBSCRIPTIONS=true`, o backend aceita `CARD`, `PIX`, `PIX,CARD` ou `["PIX","CARD"]` e nunca envia `["PIX,CARD"]`.

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
23. Configurar `BILLING_ADMIN_EMAILS`, logar com a conta dev e confirmar `source=ADMIN_GRANT`.
24. Configurar `BILLING_LEGACY_GRACE_ENABLED=true`, logar com usuario `ENTERPRISE` legado e confirmar `source=INTERNAL_LEGACY`.
25. Confirmar que usuario novo sem assinatura continua recebendo `SUBSCRIPTION_REQUIRED`.

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
