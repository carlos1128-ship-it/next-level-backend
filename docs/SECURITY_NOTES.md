# Security Notes MVP

## Resolvido Nesta Passagem

- `npm audit --omit=dev` limpo no backend e no frontend.
- `JWT_REFRESH_SECRET` nao pode cair silenciosamente para `JWT_SECRET` em producao.
- Google OAuth agora retorna tokens no fragmento da URL e o frontend remove o fragmento imediatamente apos ler.
- Webhook legado `/api/webhooks/mercadolivre` exige segredo; o webhook oficial segue em `/webhook/ml`.
- Tokens Mercado Livre continuam criptografados em `MercadoLivreOAuthToken` e no registro generico de integracao.

## Risco Aceito Para MVP Controlado

- O frontend ainda guarda `access_token` e `refresh_token` em `localStorage`. Para beta privada, mitigar com HTTPS, CSP, ausencia de scripts terceiros nao controlados e tempo curto do access token. Proximo passo recomendado: migrar refresh token para cookie `httpOnly`/`secure` e usar access token em memoria.
- `MERCADOLIVRE_WEBHOOK_SECRET_REQUIRED=false` permanece permitido porque notificacoes oficiais do Mercado Livre podem nao enviar assinatura HMAC. Mitigacoes atuais: payload validado por topico/recurso, processamento idempotente e escopo por seller/company.
- `ADMIN_CROSS_COMPANY_ACCESS` fica desabilitado por padrao. Se habilitado, usar apenas em ambiente operacional controlado.
