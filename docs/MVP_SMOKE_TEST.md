# NEXT LEVEL AI - Smoke Test MVP

## Preparacao

1. Backend Render no commit atual e raiz `/` respondendo `ok: true`.
2. Frontend Vercel carregando com `VITE_API_URL=https://next-level-backend.onrender.com`.
3. Neon com migrations aplicadas e Prisma Client gerado.
4. Webhooks de pagamento e Mercado Livre configurados.

## Fluxo final

1. Abrir landing page.
2. Entrar com Google.
3. Se nao houver plano ativo, escolher Premium.
4. Completar checkout real ou sandbox.
5. Voltar para Next Level pela URL de sucesso.
6. Confirmar assinatura ativa em `/billing/me` e na UI.
7. Confirmar acesso ao dashboard.
8. Confirmar pagina `Uso do plano`.
9. Abrir Integracoes.
10. Conectar Mercado Livre.
11. Confirmar retorno OAuth e status conectado.
12. Confirmar que a sincronizacao automatica iniciou ou que a ultima sync foi registrada.
13. Abrir Produtos e Serviços e validar produtos importados.
14. Abrir Pedidos e validar pedidos do Mercado Livre e vendas/importacoes confirmadas.
15. Abrir Clientes se compradores forem importados.
16. Abrir Financeiro e validar receita importada.
17. Abrir Dashboard e validar receita/metricas atualizadas.
18. Perguntar no chat IA: `Quanto vendi pelo Mercado Livre?`
19. Enviar amostra no Adicionar dados, revisar e confirmar.
20. Confirmar que dados normalizados aparecem em modulo correto: pedidos, clientes, produtos, financeiro ou custos.
21. Testar alteracao de senha em conta com senha.
22. Confirmar Essential bloqueado no Mercado Livre.
23. Confirmar Premium liberado no Mercado Livre.
24. Confirmar Pro Business liberado no Mercado Livre.
25. Fazer logout/login novamente e confirmar que usuario pago nao volta para cobranca.

## Validacoes extras

1. Rodar sync/webhook Mercado Livre duas vezes e confirmar que `Sale` e `FinancialTransaction` nao duplicam.
2. Testar webhook `orders_v2`, `items`, `questions` e `shipments`.
3. Confirmar que `/questions` redireciona para dashboard e nao aparece no menu.
4. Confirmar que Dashboard mostra filtros: Hoje, Ontem, 7 dias, Mes, Ano.
5. Exportar relatorio no Dashboard e confirmar PDF visual, nao CSV cru.
