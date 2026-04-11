# Render.com - WhatsApp

Este projeto pode rodar no Render de dois jeitos diferentes, e isso muda totalmente como o Chrome fica disponivel.

## 1. Docker Runtime

Use este modo se voce quer que o `Dockerfile` controle tudo.

- O Render usa o [Dockerfile](/abs/path/c:\CURSOJS\next-level-backend\Dockerfile)
- O navegador e instalado na imagem
- O path esperado e `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable`

Neste modo:

- Nao use `Build Command`
- Nao use `Start Command`
- Nao configure `CHROME_PATH` manualmente, a menos que tenha um motivo real

## 2. Native Runtime

Use este modo se o servico no Render estiver configurado como `Node`, e nao como `Docker`.

Neste modo o `Dockerfile` e ignorado. O Chrome precisa ser baixado no build e normalmente fica na cache do Puppeteer.

Build Command recomendado:

```bash
npm install && npx puppeteer browsers install chrome && npm run build
```

Start Command recomendado:

```bash
npm run start:prod
```

Neste modo:

- Prefira nao definir `PUPPETEER_EXECUTABLE_PATH`
- Prefira nao definir `CHROME_PATH`
- O backend agora tenta autodetectar o binario na cache do Puppeteer

Se voce quiser fixar o caminho manualmente, use o caminho real exibido no log do deploy, por exemplo:

```env
CHROME_PATH=/opt/render/project/src/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome
```

## 3. Env Vars

Essenciais:

```env
REDIS_URL=redis://...
DATABASE_URL=postgresql://...&sslmode=require
NODE_ENV=production
PORT=3333
```

Recomendadas para o ciclo de vida do WhatsApp em producao:

```env
WHATSAPP_RESTORE_SESSIONS_ON_BOOT=true
WHATSAPP_BOOT_RESTORE_DELAY_MS=15000
WHATSAPP_RETRY_DELAY_MS=20000
```

Para o banco Neon, o backend ja normaliza:

- `sslmode=require`
- `connect_timeout=30`
- `connection_limit=5`
- `pool_timeout=30`

## 4. Sessao Persistente

Para evitar novo QR a cada restart:

1. Adicione um Render Disk
2. Mount Path: `/tmp/.wppconnect`
3. Tamanho: `1GB` costuma bastar

## 5. Troubleshooting

Se aparecer `Browser was not found`:

1. Confirme se o servico esta em `Docker` ou `Node`
2. Se estiver em `Node`, lembre que o `Dockerfile` nao vale
3. Remova `PUPPETEER_EXECUTABLE_PATH` e `CHROME_PATH` se estiverem apontando para caminho errado
4. Refaça o deploy

Se aparecer `browser is already running`:

1. Reinicie o servico
2. Se possivel, limpe `/tmp/.wppconnect`
3. O backend ja faz cleanup pesado e retry com espera maior

Se aparecer `Auto close configured to 180s`:

1. O deploy ainda esta com uma versao antiga do backend
2. O codigo atual desabilita `autoClose` e `deviceSyncTimeout`
3. Faca um novo deploy e confirme que esse log desapareceu

Se a sessao cair para `disconnectedMobile` e voltar para QR:

1. Isso deve gerar retry seguro, sem logout forzado
2. O backend nao deve mais apagar a sessao em toda desconexao transitoria
3. Se ainda houver loop, revise as env vars acima e o path `/tmp/.wppconnect`
