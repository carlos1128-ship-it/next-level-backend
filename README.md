# NEXT LEVEL AI - Backend

Backend da plataforma NEXT LEVEL AI para analise de vendas, insights operacionais e base de atendimento inteligente para empresas (multi-tenant).

## Stack

- Node.js + NestJS + TypeScript
- PostgreSQL + Prisma ORM
- JWT para autenticacao
- Gemini 2.5 Flash (opcional) para respostas inteligentes

## Estrutura de pastas

```txt
src/
  main.ts
  app.module.ts
  prisma/
    prisma.module.ts
    prisma.service.ts
  common/
    decorators/
    dto/
    filters/
    guards/
  modules/
    auth/
    companies/
    sales/
    insights/
    ai/
    webhooks/
prisma/
  schema.prisma
  seed.ts
```

## Como rodar

1. Instale dependencias:

```bash
npm install
```

2. Configure ambiente:

```bash
cp .env.example .env
```

Variaveis obrigatorias no `.env`:
- `DATABASE_URL`
- `JWT_SECRET`
- `GEMINI_API_KEY`

Gere um `JWT_SECRET` forte:

```bash
openssl rand -base64 32
```

3. Gere cliente Prisma (automatico no postinstall, mas pode executar manualmente):

```bash
npm run prisma:generate
```

4. Rode migrations e seed:

```bash
npm run prisma:migrate
npm run prisma:seed
```

5. Suba em desenvolvimento:

```bash
npm run dev
```

API base: `http://localhost:3333/api`

## Endpoints principais

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/companies/me`
- `PATCH /api/companies/me`
- `POST /api/sales`
- `GET /api/sales`
- `GET /api/sales/aggregates`
- `GET /api/insights`
- `POST /api/chat`
- `POST /api/webhooks/shopify`
- `GET /api/webhooks/meta`
- `POST /api/webhooks/meta`

Documentacao de integração frontend:
- `docs/frontend-integration.md`

Smoke test automatizado:
- `npm run smoke`

## Comportamento atual

- Todas as rotas privadas exigem JWT.
- Isolamento por empresa via `companyId` no token e `CompanyGuard`.
- CORS configurado por ambiente com `CORS_ORIGINS`.
- Fallback de IA: se `GEMINI_API_KEY` nao estiver definido, o endpoint de chat responde com mensagem informativa.
- Webhooks de Shopify/Meta preparados para expansao.

## Proximos passos sugeridos

- Criar camada de repositories por modulo (sales, companies, insights).
- Adicionar testes E2E das rotas principais.
- Adicionar observabilidade (request id, logs estruturados e metricas).
- Integrar n8n e provedores externos de CRM/ERP.
- Evoluir RAG com vetorizacao e historico conversacional.
