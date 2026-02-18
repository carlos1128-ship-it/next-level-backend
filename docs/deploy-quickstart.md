# Deploy Quickstart (NEXT LEVEL AI)

## 1) Ambiente

- Node.js 20+
- PostgreSQL 15+
- Variáveis configuradas em `.env`

## 2) Variáveis mínimas

- `PORT`
- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `CORS_ORIGINS`

Opcional:
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `SHOPIFY_WEBHOOK_SECRET`
- `META_WEBHOOK_VERIFY_TOKEN`
- `META_APP_SECRET`
- `META_AD_ACCOUNT_TO_COMPANY`

## 3) Build e migração

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run build
```

## 4) Start em produção

```bash
npm run start
```

## 5) Health operacional (manual)

- Login: `POST /api/auth/login`
- Dashboard: `GET /api/sales/aggregates`
- Insights: `GET /api/insights`

## 6) Frontend

Configurar base URL do frontend para `https://SEU_DOMINIO/api`.
