# Configuração Render.com - Next Level AI (WhatsApp)

Para que a integração do WhatsApp funcione corretamente no Render, siga estas etapas:

## 1. Environment Variables (Environment -> Secret Files ou Env Vars)
Adicione as seguintes variáveis no painel do Render para garantir a estabilidade:

```env
# REDIS: Otimizado para rede interna do Render
# Use a Internal Redis URL do seu painel
REDIS_URL=redis://red-d7cojmt7vvec73ehb5vg:6379

# CHROME (Opcional): O Puppeteer agora detecta automaticamente o binário na cache.
# Se receber "Browser not found", use o caminho extraído do log:
# CHROME_PATH=/opt/render/project/src/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome
```

## 2. Build Config (Settings -> Build & Deploy)
O comando de build deve garantir que o Chrome seja baixado para a cache do ambiente:

**Build Command:**
`npm install && npx puppeteer browsers install chrome && npm run build`

## 3. Persistent Sessions (Recomendado)
Para evitar que os usuários tenham que ler o QR Code a cada deploy:
1. Adicione um **Render Disk**.
2. Mount Path: `/tmp/.wppconnect`
3. Tamanho: 1GB é suficiente.
*Isso garante que a pasta de sessões persista entre deploys e restarts.*

## 4. Otimizações de Rede
O código já está configurado com `family: 4` no BullMQ para evitar erros de `ECONNREFUSED` que ocorrem na rede IPv6 interna do Render.

## 5. Troubleshooting de Browser
Se o serviço iniciar, mas o WhatsApp falhar com erro de protocolo:
1. Verifique se o Render Plan tem pelo menos **1GB de RAM**. Planos de 512MB podem falhar ao abrir o navegador.
2. Observe os logs: procure pela linha `chrome@xxx /opt/render/...` para confirmar o caminho do binário.
