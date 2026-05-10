# Comparativo de Gateways

## Escolha atual

Cakto foi selecionada para a implementacao atual porque permite seguir com pagamentos sem depender do fluxo da AbacatePay que exige CNPJ neste momento.

## Cakto

- API REST
- OAuth2 com `client_id` e `client_secret`
- token via `POST /public_api/token/`
- produtos via `/public_api/products/`
- ofertas via `/public_api/offers/`
- pedidos via `/public_api/orders/`
- webhooks via `/public_api/webhook/`
- eventos de compra e assinatura
- pedidos retornam `checkoutUrl`, `status`, `product`, `subscription`, `paymentMethod`, `customer`, `paidAt`, `sck` e UTMs
- suporta Pix, cartao e boleto no nivel de produto/oferta

Estrategia inicial:

- usar checkout links fixos copiados do painel/ofertas
- validar eventos por webhook secreto
- ativar acesso por `purchase_approved` e `subscription_renewed`
- bloquear por cancelamento, recusa, reembolso e chargeback
- verificar pedido pela API quando `CAKTO_VERIFY_ORDER_ON_WEBHOOK=true`

## AbacatePay

- Adaptador mantido para historico e compatibilidade.
- Nao e o provedor ativo atual.
- Variaveis de ambiente ficam opcionais quando o provider ativo e `CAKTO`.

## Manual

- Sem checkout externo.
- Mantem grants internos e operacao administrativa.
- Util em manutencao ou desenvolvimento.
