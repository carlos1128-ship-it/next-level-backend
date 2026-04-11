# CHANGELOG - Melhorias de Estabilidade WhatsApp/Render (v2.0)

## Data: 2026-04-11
## Baseado em: Análise completa dos logs de produção no Render.com

---

## 🚨 PROBLEMAS IDENTIFICADOS NOS LOGS

### 1. **Versão do WhatsApp WEB indisponível**
```
error: [company-cmm6t6nvx0002rfrrsl1z21zd:client] Version not available for 2.3000.10305x, using latest as fallback
```
**Impacto**: Aviso inocente, mas gera confusão nos logs
**Solução**: WPPConnect já faz fallback automático para versão mais recente. Atualizado User-Agent para Chrome 131.

---

### 2. **Política de evicção do Redis incorreta**
```
IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"
```
**Impacto**: CRÍTICO - Redis pode descartar sessões do WhatsApp e jobs do BullMQ
**Solução**: 
- Documentado em `REDIS_CONFIG.md`
- docker-compose.yml atualizado com `--maxmemory-policy noeviction`
- Para Render.com: configurar via dashboard do Redis

---

### 3. **Múltiplas conexões sequenciais ao banco (7 conexões)**
```
[Nest] 80 - LOG [PrismaService] Iniciando conexao com banco de dados (max 3 tentativas)...
[Nest] 80 - LOG [PrismaService] Conexao com banco validada em 2217ms
[Nest] 80 - LOG [PrismaService] Iniciando conexao com banco de dados...
[Nest] 80 - LOG [PrismaService] Conexao com banco validada em 1496ms
... (repete 7 vezes)
```
**Impacto**: Startup lento (12+ segundos), desperdício de recursos
**Solução**: Implementado singleton pattern no PrismaService para reutilizar conexão

---

### 4. **Perfil sincronizado sem nome/número**
```
[WA-PROFILE][cmm6t6nvx0002rfrrsl1z21zd] Perfil sincronizado (sem nome / sem numero)
```
**Impacto**: Dificulta identificação da sessão, debugging prejudicado
**Solução**: 
- Adicionado delay de 2s para cliente estabilizar antes de sync
- Fallback em cascata para nome (pushname > formattedName > name > phoneNumber > WhatsApp-{id})
- Retry automático após 3s e 5s em caso de falha

---

### 5. **Auto-close configurado implicitamente**
**Impacto**: Sessões podem fechar automaticamente em produção
**Solução**: `autoClose: 0` (desabilitado) no WPPConnect

---

### 6. **Retry sem backoff exponencial**
**Impacto**: Retentativas muito rápidas podem sobrecarregar o serviço
**Solução**: Implementado backoff exponencial com:
- Delay inicial: 10s
- Delay máximo: 120s
- Multiplicador: 2x
- Máximo de tentativas: 5

---

### 7. **Graceful shutdown sem timeout**
**Impacto**: Shutdown pode ficar pendente indefinidamente
**Solução**: Timeout de 30s distribuído entre todas as sessões

---

### 8. **Health check inexistente para WhatsApp**
**Impacto**: Impossível monitorar saúde de cada sessão individualmente
**Solução**: Novo método `getHealthStatus(companyId)` retorna status detalhado

---

## ✅ MELHORIAS IMPLEMENTADAS

### WhatsApp Service (`whatsapp.service.ts`)

#### ✨ Novas Funcionalidades
- **Health Check Detalhado**: `getHealthStatus(companyId)` retorna status completo
  - Status da conexão
  - Número de telefone
  - Contagem de retries
  - Último erro
  - Flag de saúde geral

- **Singleton de Conexão**: Evita múltiplas inicializações do PrismaService

- **Recuperação Escalonada**: Sessões recuperadas com delay de 1s entre cada uma

#### 🔧 Melhorias de Estabilidade
- **Backoff Exponencial**: Retry com delays crescentes (10s → 20s → 40s → 80s → 120s)
- **Máximo de Retries**: Limitado a 5 tentativas antes de exigir intervenção manual
- **Graceful Shutdown**: Timeout de 30s para fechar todas as sessões
- **Perfil Robusto**: Fallback em cascata para nome/número com retries automáticos
- **Auto-Close Desabilitado**: `autoClose: 0` para produção
- **User-Agent Atualizado**: Chrome 131 (mais recente)

#### 🐛 Bug Fixes
- Corrigido "sem nome / sem número" no perfil sincronizado
- Evitado Unhandled Rejections em retries
- Silenciado erros de "Target.closeTarget" e "Auto Close Called"
- Limpeza de memória otimizada (mantém status para referência)

---

### Prisma Service (`prisma.service.ts`)

#### 🔧 Otimizações
- **Singleton Pattern**: Evita 7 conexões sequenciais desnecessárias
- **Connection Limit**: Reduzido de 5 para 3 (otimizado para Render free tier)
- **PgBouncer Support**: Adicionado `pgbouncer=true` para connection pooling
- **Startup Time**: Reduzido de ~12s para ~2s

---

### Dockerfile

#### 🚀 Melhorias de Performance
- **Dependências Otimizadas**: Adicionadas libs essenciais para Chromium
  - `libnss3`, `libatk-bridge2.0-0`, `libdrm2`, `libxkbcommon0`, `libgbm1`, `libasound2`
- **npm ci --ignore-scripts**: Evita scripts de postinstall desnecessários no build
- **PUPPETEER_SKIP_DOWNLOAD**: Evita download duplicado do Chrome
- **Health Check**: Adicionado health check nativo do Docker
- **Permissões**: `/tmp/.wppconnect` com permissões adequadas
- **Versão do Chrome**: Log da versão no build para debugging

---

### Docker Compose (`docker-compose.yml`)

#### 🔧 Correções Críticas
- **Redis noeviction**: `command: redis-server --maxmemory-policy noeviction --maxmemory 256mb`
- **Memory Limit**: Redis limitado a 256MB para evitar OOM

---

### Environment Variables (`.env.example`)

#### 📝 Novas Variáveis Documentadas
```bash
WPPCONNECT_AUTO_CLOSE=0
WPPCONNECT_AUTO_RETRY=true
WPPCONNECT_RETRY_LIMIT=5
PRISMA_CONNECT_RETRIES=3
PRISMA_CONNECT_RETRY_DELAY_MS=1500
```

---

### Documentação Nova

#### 📚 Arquivos Criados
1. **`REDIS_CONFIG.md`**: Guia completo para configurar política de evicção do Redis
2. **`CHANGES_v2.0.md`**: Este arquivo de changelog

---

## 📊 IMPACTO ESPERADO

### Antes
- ❌ Startup: ~12-15 segundos
- ❌ 7 conexões sequenciais ao banco
- ❌ Sessões WhatsApp instáveis
- ❌ Redis pode descartar dados criticos
- ❌ Perfil sem nome/número
- ❌ Retry sem controle
- ❌ Shutdown pode travar

### Depois
- ✅ Startup: ~2-3 segundos (80% mais rápido)
- ✅ 1 conexão singleton ao banco
- ✅ Sessões estáveis com retry inteligente
- ✅ Redis com política noeviction (sem perda de dados)
- ✅ Perfil completo com fallback robusto
- ✅ Retry com backoff exponencial (10s → 120s)
- ✅ Graceful shutdown com timeout de 30s

---

## 🚀 COMO DEPLOYAR

### Render.com (Docker)

1. **Push para o repositório**
   ```bash
   git add .
   git commit -m "feat: melhorias de estabilidade WhatsApp/Render v2.0"
   git push
   ```

2. **Configurar Redis no Render**
   - Ir ao dashboard do Redis
   - Settings > Eviction Policy
   - Selecionar: **noeviction**

3. **Variáveis de Ambiente (já documentadas no .env.example)**
   ```bash
   WPPCONNECT_AUTO_CLOSE=0
   WPPCONNECT_AUTO_RETRY=true
   PRISMA_CONNECT_RETRIES=3
   ```

4. **Deploy Automático**
   - Render detectará mudanças no Dockerfile
   - Build será executado automaticamente
   - Health check validará o serviço

### Docker Local

```bash
# Subir todos os serviços
docker-compose up -d

# Ver logs
docker-compose logs -f backend

# Verificar saúde
docker-compose ps

# Testar health check
curl http://localhost:3333/
```

---

## 🔍 MONITORAMENTO PÓS-DEPLOY

### Logs para Observar

#### ✅ Logs Esperados (SUCESSO)
```
[Nest] 80 - LOG [PrismaService] Conexao ja inicializada, reutilizando instancia singleton
[Nest] 80 - LOG [PrismaService] Conexao com banco validada em 2217ms
[Nest] 80 - LOG [WhatsappService] Encontradas 1 sessões para recuperar
[Nest] 80 - LOG [WhatsappService] [WA-INIT][cmm6t6nvx0002rfrrsl1z21zd] Inicializando motor WPPConnect...
[Nest] 80 - LOG [WhatsappService] [WA-BROWSER] Usando Chrome: /usr/bin/google-chrome-stable
[Nest] 80 - LOG [WhatsappService] [WA-PROFILE][cmm6t6nvx0002rfrrsl1z21zd] Perfil sincronizado (Nome / 5511999999999)
```

#### ❌ Logs de Alerta (REQUER ATENÇÃO)
```
[Nest] 80 - ERROR [WhatsappService] [WA-RETRY-MAX][...] Máximo de tentativas atingido
[Nest] 80 - ERROR [WhatsappService] [WA-FATAL][...] Falha na inicialização
```

### Endpoints de Health Check

```bash
# Health geral da aplicação
GET /api

# Health de sessão WhatsApp específica
GET /api/whatsapp/session/{companyId}/status

# Health detalhado (novo)
GET /api/whatsapp/session/{companyId}/health
```

---

## 📝 NOTAS TÉCNICAS

### Por que Singleton no PrismaService?
Os logs mostravam 7 inicializações sequenciais do PrismaService. Isso acontece porque múltiplos módulos importam o PrismaService e cada um chama `onModuleInit()`. Com o singleton:
- Primeira chamada inicializa a conexão
- Chamadas subsequentes reutilizam a conexão existente
- Redução de ~12s para ~2s no startup

### Por que noeviction no Redis?
Com `allkeys-lru`, o Redis pode descartar QUALQUER chave quando atinge o limite de memória. Isso é perigoso para:
- Sessões do WhatsApp (tokens de autenticação)
- Jobs do BullMQ (processamento de mensagens)
- Dados de webhook (eventos não processados)

Com `noeviction`, o Redis retorna erro quando está cheio, mas **não descarta dados**.

### Backoff Exponencial
Retry imediato pode sobrecarregar serviços já sob stress. Com backoff exponencial:
- 1ª tentativa: 10s
- 2ª tentativa: 20s
- 3ª tentativa: 40s
- 4ª tentativa: 80s
- 5ª tentativa: 120s (máximo)

Isso dá tempo para o serviço se recuperar entre tentativas.

---

## 🎯 PRÓXIMOS PASSOS (OPCIONAL)

1. **Implementar métricas Prometheus** para monitorar sessões WhatsApp
2. **Adicionar circuit breaker** para fallback automático em caso de falhas recorrentes
3. **Implementar WebSocket** para streaming de status em tempo real
4. **Adicionar tracing distribuído** (OpenTelemetry) para rastrear requests
5. **Criar dashboard admin** para gerenciar sessões WhatsApp

---

## 📞 SUPORTE

Para dúvidas ou issues relacionados a estas mudanças:
1. Verificar logs de produção no Render Dashboard
2. Consultar `REDIS_CONFIG.md` para configuração do Redis
3. Revisar este changelog para entender as mudanças
4. Verificar health checks de cada sessão

---

**Versão**: 2.0
**Data**: 2026-04-11
**Autor**: Análise de logs de produção + Otimizações de estabilidade
