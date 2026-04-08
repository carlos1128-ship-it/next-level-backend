# 🚀 Guia de Deploy no Render

## ✅ Alterações Aplicadas

### 1. Binding `0.0.0.0` (CRÍTICO)
**Arquivo**: `src/main.ts`
```typescript
await app.listen(port, '0.0.0.0');
```
**Por que**: Sem isso, o NestJS só escuta em `localhost` interno do container e o Render não consegue acessar.

### 2. Otimização de Startup do Prisma
**Arquivo**: `src/prisma/prisma.service.ts`
- Retries reduzidos de 5 → 3 (produção)
- Delay reduzido de 3000ms → 1500ms
- Logs de timing para diagnosticar lentidão

**Tempo máximo de startup do Prisma**:
- Antes: 5 × 3000ms = **15 segundos**
- Agora: 3 × 1500ms = **4.5 segundos**

### 3. Logs de Status do Servidor
**Arquivo**: `src/main.ts`
```
🚀 Application is running on: http://0.0.0.0:3333
📡 Listening on port: 3333
🌍 Environment: production
✅ Ready to accept connections
```

## 🔧 Configuração no Render

### Build Command
```bash
npm install && npx prisma generate && npm run build
```

### Start Command
```bash
npm run start:prod
```

### Environment Variables Obrigatórias
```
DATABASE_URL=postgresql://user:pass@host/db?schema=public&sslmode=require
JWT_SECRET=sua-chave-secreta
JWT_REFRESH_SECRET=segunda-chave-secreta
NODE_ENV=production
PORT=3333
CORS_ORIGINS=http://localhost:3000,https://seu-frontend.vercel.app
TRUST_PROXY=1
```

### ⚠️ Variáveis para Evitar Loop de Puppeteer
```
WPPCONNECT_HEADLESS=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

## 🐛 Diagnóstico de Problemas

### Deploy "travou" mas o log mostra "Application is running"
**Causa**: Health check do Render não está encontrando a porta
**Solução**: Verifique se `0.0.0.0` está no `app.listen()`

### Log mostra "Conexao com banco validada" múltiplas vezes
**Causa**: Prisma está reconectando
**Solução**: Verifique se `DATABASE_URL` tem `sslmode=require`

### Erro de Puppeteer/Chrome não encontrado
**Causa**: Render não tem Chrome instalado
**Solução**: Adicione ao `render.yaml`:
```yaml
buildCommand: |
  apt-get update && apt-get install -y wget gnupg
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add -
  echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update && apt-get install -y google-chrome-stable
  npm install && npx prisma generate && npm run build
```

### Timeout de 60 segundos do Render
**Causa**: Processo muito lento antes do `app.listen()`
**Solução aplicada**:
- Prisma retry reduzido (4.5s máximo)
- Logs de timing para identificar gargalos
- Binding `0.0.0.0` garante detecção imediata

## 📊 Logs Esperados no Deploy Bem-Sucedido

```
[Nest] XXXX  - XX/XX/XXXX, XX:XX:XX AM     LOG [NestFactory] Starting Nest application...
[Nest] XXXX  - XX/XX/XXXX, XX:XX:XX AM     LOG [PrismaService] Iniciando conexao com banco de dados (max 3 tentativas)...
[Nest] XXXX  - XX/XX/XXXX, XX:XX:XX AM     LOG [PrismaService] Conexao com banco validada em XXXms
[Nest] XXXX  - XX/XX/XXXX, XX:XX:XX AM     LOG [NestApplication] Nest application successfully started
🚀 Application is running on: http://0.0.0.0:3333
📡 Listening on port: 3333
🌍 Environment: production
✅ Ready to accept connections
```

## 🔄 Fazer Manual Deploy

1. Push para branch `main`
2. No Render Dashboard → Web Service → Manual Deploy → Deploy from latest commit
3. Aguardar logs mostrarem `✅ Ready to accept connections`
4. Testar endpoint: `https://seu-backend.onrender.com/api/`

## 🎯 Health Check

O Render usa o endpoint `/` para health check. O backend já responde:
```json
{
  "ok": true,
  "service": "next-level-backend",
  "timestamp": "2026-04-08T..."
}
```

Se necessário, configure no Render:
- **Health Check Path**: `/`
- **Expected Status**: `200`
