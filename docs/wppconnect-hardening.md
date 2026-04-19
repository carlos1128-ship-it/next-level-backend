# WPPConnect Hardening

## O que mudou

- Reconexao automatica com backoff exponencial para falhas transitórias.
- Preservacao correta do `sessionName` em recoveries para nao perder o vinculo com os tokens salvos.
- `headless` agora respeita ambiente e funciona melhor em Docker/Render.
- `startPhoneWatchdog()` ativado para detectar queda do celular mais cedo.
- Listeners do WPPConnect agora sao descartados explicitamente no cleanup.
- Health check enriquecido com `hasInitialization`, `hasRetryTimer`, `needsReconnect`, `reconnectAttempts` e `nextReconnectAt`.
- Perfil do browser, tokens e sessao passaram a usar paths cross-platform.

## Variaveis recomendadas

```env
WPPCONNECT_HEADLESS=true
WPPCONNECT_AUTO_CLOSE=0
WPPCONNECT_AUTO_RETRY=true
WPPCONNECT_RETRY_LIMIT=5
WPPCONNECT_SESSION_DIR=/app/.wppconnect
WPPCONNECT_TOKEN_DIR=/app/tokens
WPPCONNECT_BROWSER_PROFILE_DIR=/app/.wpp-browser
WHATSAPP_RETRY_DELAY_MS=10000
WHATSAPP_RETRY_MAX_DELAY_MS=120000
WHATSAPP_PHONE_WATCHDOG_MS=30000
```

## Operacao

1. Gere a instancia em `POST /api/attendant/whatsapp/instance`.
2. Leia o QR em `GET /api/attendant/whatsapp/qrcode`.
3. Monitore `GET /api/attendant/whatsapp/health`.
4. Use `POST /api/attendant/whatsapp/cleanup` apenas para limpeza forçada.

## Docker

- O container agora instala o Chrome do Puppeteer no build.
- Persistencia local exige volumes para sessao, tokens e perfil do browser.
- Nao deixe segredos embutidos no `docker-compose.yml`.
