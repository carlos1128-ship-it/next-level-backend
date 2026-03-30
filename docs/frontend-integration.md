# Frontend -> Backend Integration (NEXT LEVEL AI)

## Base URL

- Desenvolvimento: `http://localhost:3333/api`
- Produção: `https://SEU_DOMINIO/api`

Use variável no frontend:

- `NEXT_PUBLIC_API_BASE_URL` (Next.js)
- `VITE_API_BASE_URL` (Vite)

## Autenticação JWT

1. Faça `POST /auth/login` (ou `POST /auth/register`).
2. Salve `accessToken`.
3. Envie em todas as rotas privadas:

`Authorization: Bearer <token>`

## Endpoints para o frontend

### Auth

- `POST /auth/register`
  - body:
```json
{
  "email": "owner@empresa.com",
  "password": "senha123",
  "companyName": "Empresa X",
  "companySlug": "empresa-x",
  "name": "Owner"
}
```

- `POST /auth/login`
  - body:
```json
{
  "email": "owner@empresa.com",
  "password": "senha123"
}
```

### Empresa

- `GET /companies/me`
- `PATCH /companies/me`

### Vendas / Dashboard

- `POST /sales`
- `GET /sales?start=2026-02-01T00:00:00.000Z&end=2026-02-18T23:59:59.000Z`
- `GET /sales/aggregates`
  - retorno para dashboard:
```json
{
  "today": 0,
  "yesterday": 0,
  "week": 0,
  "month": 0,
  "year": 0
}
```

### Insights e Chat

- `GET /insights`
- `POST /chat`

### Webhooks (testes manuais)

- `POST /webhooks/shopify`
- `GET /webhooks/meta`
- `POST /webhooks/meta`

## CORS

Configurar no backend:

- `.env`: `CORS_ORIGINS=http://localhost:3000,http://localhost:5173`

Para produção, inclua domínio oficial do frontend.

## Exemplo de cliente HTTP (frontend)

```ts
const API_BASE = import.meta.env.VITE_API_BASE_URL;

export async function apiFetch(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.message || `HTTP ${res.status}`);
  }

  return res.json();
}
```
