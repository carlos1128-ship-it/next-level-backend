# Deploy Quickstart (NEXT LEVEL AI)

## Backend Render

- Root Directory: `next-level-backend`
- Build Command: `npm install --include=dev && npm run build:render`
- Start Command: `npm run start:prod`
- Node: `20.x`

`start:prod` executa `prisma migrate deploy` antes de subir `dist/main.js`.

## Frontend Vercel

- Root Directory: `next-level-front`
- Build Command: `npm run build`
- Output Directory: `dist`
- Variavel obrigatoria: `VITE_API_URL=https://next-level-backend.onrender.com`

## Variaveis Obrigatorias No Render

- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `FRONTEND_URL`
- `BACKEND_URL`
- `PUBLIC_API_URL`
- `CORS_ORIGINS`
- `ML_CLIENT_ID`
- `ML_CLIENT_SECRET`
- `ML_REDIRECT_URI`
- `ML_TOKEN_ENCRYPTION_KEY`
- `ML_STATE_SECRET`
- `WEBHOOK_SECRET`
- `MERCADOLIVRE_WEBHOOK_SECRET_REQUIRED=false`
- `BILLING_PAYMENT_PROVIDER`
- `CAKTO_WEBHOOK_SECRET` quando `BILLING_PAYMENT_PROVIDER=CAKTO`
- `ABACATEPAY_WEBHOOK_SECRET` quando `BILLING_PAYMENT_PROVIDER=ABACATEPAY`
- `GEMINI_API_KEY` se IA real estiver habilitada
- `REDIS_URL` se fila/BullMQ estiver habilitada

Em producao, `JWT_REFRESH_SECRET` precisa existir e ser diferente de `JWT_SECRET`.

## Comandos Locais De Validacao

```bash
npx prisma generate
npm run build
npm test
npm run test:ai-usage
npm run test:whatsapp-isolation
npm audit --omit=dev
```

Frontend:

```bash
npm run build
npm test
npm audit --omit=dev
```
