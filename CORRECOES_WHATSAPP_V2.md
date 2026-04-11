# CORREÇÕES WHATSAPP MULTI-TENANT v2.0

## Problemas Resolvidos

### 1. ✅ Dessincronização entre abas "Integrações" e "Atendente Virtual"
**Causa raiz**: Cada aba usava métodos diferentes para verificar status do WhatsApp. O estado em memória (`Map<string, WhatsappClient>`) podia divergir entre chamadas.

**Solução implementada**:
- Novo endpoint `GET /api/attendant/whatsapp/health` que verifica estado **LIVE** com o WPPConnect
- Hook compartilhado `useWhatsAppStatus.ts` usado por ambas as abas
- Polling de 5s para sincronização automática
- Auto-correção: se memória e WPPConnect divergem, status é corrigido automaticamente

### 2. ✅ Loop de erro ao trocar de empresa
**Causa raiz**: Ao trocar de `companyId`, a sessão anterior não era limpa, causando conflito de estados.

**Solução implementada**:
- Endpoint `POST /api/attendant/whatsapp/cleanup` para limpeza forçada
- Hook `useWhatsAppStatus` faz cleanup automático ao detectar troca de empresa
- Frontend limpa sessão antes de conectar nova empresa

### 3. ✅ Restauração agressiva no boot
**Causa raiz**: `onModuleInit` restaurava TODAS as sessões marcadas como `CONNECTED`, mesmo antigas.

**Solução implementada**:
- Filtro por `lastConnectedAt >= 24h` — apenas sessões recentes são restauradas
- Delay escalonado (1s entre cada sessão) para evitar sobrecarga
- Nova flag `WHATSAPP_SKIP_RESTORE_ON_BOOT=true` para pular restore em staging/dev

### 4. ✅ Session Unpaired derrubando processo
**Causa raiz**: Evento `sessionUnpaired` do WPPConnect causava Unhandled Rejection.

**Solução implementada**:
- Tratamento explícito de `sessionUnpaired` com log warning (não error)
- Não persiste no banco — permite retry externo via QR Code manual
- Não rejeita Promise — evita crash do NestJS

---

## Arquivos Modificados

### Backend
| Arquivo | Mudança |
|---------|---------|
| `src/modules/whatsapp/whatsapp.service.ts` | + `getHealthStatus()`, `forceCleanupSession()`, tratamento de `sessionUnpaired`, restore seletivo |
| `src/modules/whatsapp/whatsapp.controller.ts` | + Endpoints `/health` e `/cleanup` |
| `src/modules/attendant/attendant.service.ts` | + `getWhatsappHealth()`, `cleanupWhatsappSession()` |
| `src/modules/attendant/attendant.controller.ts` | + Endpoints `/health` e `/cleanup` |

### Frontend
| Arquivo | Mudança |
|---------|---------|
| `src/hooks/useWhatsAppStatus.ts` | **NOVO** — Hook compartilhado para status consistente |
| `src/services/endpoints.ts` | + `getWhatsappHealth()`, `cleanupWhatsappSession()` |
| `pages/Attendant.tsx` | Usa hook `useWhatsAppStatus` em vez de chamadas manuais |

---

## Novos Endpoints API

### `GET /api/attendant/whatsapp/health?companyId=xxx`
Retorna estado REAL da sessão WhatsApp:

```typescript
{
  companyId: string;
  status: string;              // Status normalizado
  connected: boolean;          // TRUE se conectado LIVE
  qrCode: string | null;       // Base64 do QR Code
  phoneNumber: string | null;  // Número do WhatsApp
  pushname: string | null;     // Nome do perfil
  hasClient: boolean;          // Cliente existe em memória
  hasInitialization: boolean;  // Inicialização em andamento
  hasRetryTimer: boolean;      // Retry pendente
  lastError: string | null;    // Último erro
  dbStatus: string;            // Status no banco
  dbEnabled: boolean;          // Habilitado no banco
  dbLastConnected: string | null;
  healthy: boolean;            // Status final saudável
  needsReconnect: boolean;     // Precisa reconectar
  awaitingQR: boolean;         // Aguardando scan
}
```

### `POST /api/attendant/whatsapp/cleanup?companyId=xxx`
Limpeza forçada ao trocar de empresa:

```typescript
{
  success: true;
  companyId: string;
  status: "DISCONNECTED";
}
```

---

## Hook Frontend: `useWhatsAppStatus`

```typescript
import { useWhatsAppStatus } from '../src/hooks/useWhatsAppStatus';

const {
  status,          // Objeto completo de health
  loading,         // Carregando
  error,           // Erro se houver
  isConnected,     // Boolean: está conectado?
  isHealthy,       // Boolean: status saudável?
  needsReconnect,  // Boolean: precisa reconectar?
  isAwaitingQR,    // Boolean: aguardando QR Code?
  refresh,         // Função: buscar status manual
  cleanup,         // Função: limpar sessão
} = useWhatsAppStatus(selectedCompanyId, {
  pollingInterval: 5000,  // Polling a cada 5s
  enablePolling: true,
  onStatusChange: (status) => {
    if (status.connected) {
      toast('WhatsApp conectado!');
    }
  },
});
```

---

## ⚠️ Configuração do Redis com `noeviction` no Render

### Problema
Os logs mostram: `IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"`

Com `allkeys-lru`, o Redis pode **descartar sessões do WhatsApp e jobs do BullMQ** quando atinge o limite de memória.

### Solução — Render.com

1. **Acesse o Dashboard do Render**
   - Vá para https://dashboard.render.com
   - Selecione seu serviço Redis

2. **Altere a Eviction Policy**
   - Clique em **Settings**
   - Encontre **Eviction Policy**
   - Mude de `allkeys-lru` para **`noeviction`**
   - Salve

3. **Verifique a mudança**
   - Via Redis CLI: `CONFIG GET maxmemory-policy`
   - Deve retornar: `noeviction`

### Solução — Docker Local
Já configurado no `docker-compose.yml`:
```yaml
redis:
  command: redis-server --maxmemory-policy noeviction --maxmemory 256mb
```

### Variável de Ambiente (opcional)
Se seu provedor Redis não permitir mudar via dashboard, adicione:
```bash
# No .env ou variáveis de ambiente do Render
# (Apenas para documentação — a mudança deve ser feita no painel do Redis)
REDIS_EVICTION_POLICY=noeviction
```

---

## Deploy

### 1. Backend
```bash
cd next-level-backend
git add .
git commit -m "feat: correções WhatsApp multi-tenant v2.0 — health check, cleanup, sync"
git push
```

### 2. Frontend
```bash
cd next-level-front
git add .
git commit -m "feat: hook useWhatsAppStatus para status consistente entre abas"
git push
```

### 3. Redis (Render)
- Dashboard do Redis → Settings → Eviction Policy → **`noeviction`**

---

## Monitoramento Pós-Deploy

### ✅ Logs Esperados (Sucesso)
```
[WA-HEALTH][companyId] Cliente conectado mas status era QR_READY. Corrigindo.
[WA-RESTORE][companyId] Restoring session (1/1)
[WA-UNPAIRED][companyId] Sessão despareada. Aguardando reconexão manual.
```

### ⚠️ Logs de Alerta
```
[WA-RETRY-MAX][companyId] Máximo de tentativas atingido
[WA-FATAL][companyId] Startup failed
```

### Endpoints de Verificação
```bash
# Status básico
GET /api/whatsapp/session/{companyId}/status

# Health detalhado (NOVO)
GET /api/attendant/whatsapp/health?companyId={companyId}

# Cleanup forçado (NOVO)
POST /api/attendant/whatsapp/cleanup?companyId={companyId}
```

---

## Variáveis de Ambiente Novas

```bash
# Pular restauração de sessões no boot (staging/dev)
WHATSAPP_SKIP_RESTORE_ON_BOOT=true

# Delay entre restauração de sessões (ms)
WHATSAPP_BOOT_RESTORE_DELAY_MS=1000

# Delay de retry entre tentativas (ms)
WHATSAPP_RETRY_DELAY_MS=20000
```

---

**Versão**: 2.0
**Data**: 2026-04-11
**Status**: ✅ Build validado, pronto para deploy
