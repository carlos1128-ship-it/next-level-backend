# 🗺️ Roadmap de Integração com a Shopee

## ✅ Concluído

### Backend
- [x] Adicionado `SHOPEE` ao enum `IntegrationProvider` no schema.prisma
- [x] Adicionado campo `refreshToken` ao model `Integration`
- [x] Migração executada no banco de dados
- [x] Prisma Client gerado com as atualizações

### Frontend
- [x] Tipo `HubProvider` atualizado para incluir `"shopee"`
- [x] Tipo `IntegrationProvider` atualizado para incluir `"SHOPEE"`
- [x] Card da Shopee adicionado ao IntegrationsHub.tsx
  - Título: "Shopee NEXT"
  - Descrição: "Sincronize pedidos, rastreio e chat da Shopee em um só lugar."
  - Cor: Laranja (#EE4D2D / orange-500)
  - Ícone: SVG de sacola de compras
- [x] Grid ajustado para 4 colunas (sm:grid-cols-2 xl:grid-cols-4)
- [x] Status inicial: "Desconectado" / "Nunca conectado"

## 🚧 Pendente

### Backend - Rotas OAuth da Shopee
- [ ] Criar rota `GET /auth/shopee` para iniciar fluxo OAuth
- [ ] Criar rota `GET /auth/shopee/callback` para receber callback
- [ ] Implementar handshake OAuth 2.0 com API da Shopee
- [ ] Salvar `shopeeAccessToken` e `shopeeRefreshToken` no banco
- [ ] Implementar refresh automático do token

### Backend - Webhooks
- [ ] Configurar webhook para novos pedidos
- [ ] Configurar webhook para atualizações de rastreio
- [ ] Configurar webhook para mensagens do chat

### Frontend
- [ ] Modal de configuração pós-conexão (loja ID, região, etc.)
- [ ] Exibir status detalhado da conexão
- [ ] Botão de desconexão específico para Shopee

### Documentação
- [ ] Credenciais de desenvolvedor Shopee Open Platform
- [ ] Fluxo de autenticação passo a passo
- [ ] Exemplos de requests/responses

## 📝 Notas Técnicas

### Shopee Open Platform
- Documentação: https://open.shopee.com/documents/
- OAuth 2.0 com refresh token
- Rate limits: consultar docs oficiais
- Webhooks para eventos em tempo real

### Endpoints da API Shopee
- `/api/v2/shop/auth_token` - Obter token de acesso
- `/api/v2/shop/get` - Informações da loja
- `/api/v2/order/get_order_list` - Listar pedidos
- `/api/v2/message/chat` - Chat com compradores

## 🔗 Referências
- IntegrationsHub.tsx: Card segue padrão exato dos outros providers
- Cores: orange-500 (#EE4D2D é a cor oficial da Shopee)
- Ícone: Sacola de compras estilizada
