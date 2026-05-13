# NEXT LEVEL AI - Smoke Test MVP

## Preparacao

1. Backend Render em commit atual e `GET /api/health` respondendo.
2. Frontend Vercel carregando com `VITE_API_URL=https://next-level-backend.onrender.com`.
3. Banco Neon com migrations aplicadas.
4. Webhooks configurados no provedor de pagamento e no Mercado Livre.

## Fluxo De Usuario Pago

1. Criar usuario novo com email real.
2. Criar ou selecionar empresa.
3. Escolher plano Premium.
4. Criar checkout.
5. Pagar ou enviar webhook real/sandbox aprovado.
6. Confirmar no banco que `Subscription.status=ACTIVE` e `planKey=PREMIUM` na empresa correta.
7. Abrir `/billing/success` e aguardar redirecionamento.
8. Reentrar com o mesmo email e confirmar que nao pede novo pagamento.
9. Confirmar UI de plano/uso mostrando Premium.

## Admin

1. Configurar `ADMIN_EMAIL` ou `ADMIN_COMPANY_ID`.
2. Rodar `npm run admin:pro-business`.
3. Confirmar UI de plano/uso como Business/PRO_BUSINESS.
4. Confirmar Mercado Livre liberado por plano, sem depender de bypass.

## Mercado Livre

1. Com plano Essential, abrir integracoes e confirmar Mercado Livre bloqueado.
2. Com plano Premium, confirmar botao Mercado Livre liberado.
3. Conectar Mercado Livre via OAuth.
4. Confirmar status conectado, seller id e conta exibidos.
5. Clicar `Sincronizar agora`.
6. Confirmar produtos em `/products`.
7. Confirmar pedidos em `/orders`.
8. Confirmar perguntas em `/questions`.
9. Confirmar que pedido pago criou `Sale` com `channel=mercadolivre`.
10. Confirmar que pedido pago criou `FinancialTransaction` com `source=mercadolivre`.
11. Rodar sync novamente e confirmar que receita nao duplicou.
12. Enviar webhook `orders_v2` e confirmar que pedido/sale/transacao foram atualizados sem duplicar.

## Dashboard, Financeiro E IA

1. Dashboard deve incluir receita Mercado Livre.
2. Financeiro deve listar transacao de receita Mercado Livre.
3. Perguntar no chat IA: `Quanto vendi pelo Mercado Livre?`
4. Perguntar: `Quais produtos venderam mais no Mercado Livre?`
5. Perguntar: `Tenho perguntas pendentes no Mercado Livre?`

## WhatsApp

1. Plano Premium ou Business.
2. Abrir integracoes e iniciar WhatsApp.
3. Confirmar QR/estado sem erro interno.
4. Enviar mensagem inbound de teste.
5. Confirmar que processamento de acao nao registra `undefined.upsert`.
