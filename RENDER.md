# Configuração Render.com - Next Level AI (WhatsApp)

Para que a integração do WhatsApp funcione corretamente no Render, siga estas etapas:

## 1. Blueprint / Configuração do Serviço
Certifique-se de que seu serviço de backend no Render tenha memória suficiente (recomenda-se pelo menos 1GB para rodar Puppeteer confortavelmente).

## 2. Environment Variables
Adicione as seguintes variáveis no painel do Render:

```env
# Path para o Chrome instalado no Render
CHROME_PATH=/usr/bin/google-chrome

# URL do Redis para o BullMQ (Pode ser o Redis do próprio Render)
REDIS_URL=rediss://default:senha@host:port

# Otimização Prisma (Caso use Neon)
# DATABASE_URL já deve estar configurada, mas garanta que o pool esteja otimizado.
```

## 3. Persistent Disk (Opcional, mas Recomendado)
Para evitar que as sessões do WhatsApp expirem a cada deploy:
1. Adicione um **Disk** no Render.
2. Monte-o em `/opt/render/project/sessions`.
3. No `whatsapp.service.ts`, altere `SESSION_BASE_DIR` para este caminho.
*Nota: Atualmente usamos `/tmp/.wppconnect` que é efêmero (reseta a cada restart).*

## 4. Build Settings
A integração usa `google-chrome` que não vem por padrão em algumas imagens. Use o build command que garanta as dependências:

```bash
# Exemplo de build command
npm install && npx playwright install-deps chromium && npm run build
```
Ou adicione as dependências do Puppeteer via Dockerfile se estiver usando Docker.

## 5. BullMQ Dashboard
Acesse as métricas da fila via `/queues` se habilitar o UI do BullBoard.
