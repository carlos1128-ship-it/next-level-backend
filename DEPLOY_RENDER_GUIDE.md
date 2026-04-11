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

### Build / Start Command

Escolha apenas um modo de deploy:

#### Opcao A: Docker Runtime
- O Render usa o `Dockerfile`
- Nao configure `Build Command`
- Nao configure `Start Command`

#### Opcao B: Native Runtime (Node)
```bash
Build Command: npm install && npx puppeteer browsers install chrome && npx prisma generate && npm run build
Start Command: npm run start:prod
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
WHATSAPP_RESTORE_SESSIONS_ON_BOOT=true
WHATSAPP_BOOT_RESTORE_DELAY_MS=15000
WHATSAPP_RETRY_DELAY_MS=20000
```

Observacao:
- Em `Docker Runtime`, se quiser fixar manualmente: `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable`
- Em `Native Runtime`, prefira nao definir `PUPPETEER_EXECUTABLE_PATH`; o backend agora tenta localizar o binario automaticamente na cache do Puppeteer

## 🐛 Diagnóstico de Problemas

### Deploy "travou" mas o log mostra "Application is running"
**Causa**: Health check do Render não está encontrando a porta
**Solução**: Verifique se `0.0.0.0` está no `app.listen()`

### Log mostra "Conexao com banco validada" múltiplas vezes
**Causa**: Prisma está reconectando
**Solução**: Verifique se `DATABASE_URL` tem `sslmode=require`

### Erro de Puppeteer/Chrome não encontrado
**Causa**: O caminho configurado não existe no runtime atual, ou o serviço está em `Node` e não em `Docker`
**Solução**:
- Se estiver em `Docker`, confirme que o Render está realmente usando o `Dockerfile`
- Se estiver em `Node`, o `Dockerfile` é ignorado; use `npx puppeteer browsers install chrome` no `Build Command`
- Remova `PUPPETEER_EXECUTABLE_PATH` e `CHROME_PATH` se estiverem apontando para caminhos inválidos
- Refaça o deploy e use o caminho exibido no log apenas se precisar fixá-lo

### Timeout de 60 segundos do Render
**Causa**: Processo muito lento antes do `app.listen()`
**Solução aplicada**:
- Prisma retry reduzido (4.5s máximo)
- Logs de timing para identificar gargalos
- Binding `0.0.0.0` garante detecção imediata
- Restore das sessões WhatsApp adiado para depois do boot do app

### Log mostra `Auto close configured to 180s`
**Causa**: O deploy ainda está com a versão antiga da configuração do WPPConnect
**Solução**:
- O backend agora desabilita `autoClose` e `deviceSyncTimeout`
- Refaça o deploy e confirme se o log desapareceu

### Sessão entra em `disconnectedMobile` e logo reinicia
**Causa**: Queda transitória do cliente ou pareamento exigindo QR novo
**Solução aplicada**:
- Retry seguro sem `logout` automático
- Sem limpeza destrutiva da pasta da sessão em toda desconexão transitória
- Cleanup pesado só em erro real de lock/processo travado

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
