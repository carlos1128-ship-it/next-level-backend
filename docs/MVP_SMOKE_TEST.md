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
26. Enviar mensagem WhatsApp de lead: `Meu nome e Ana, meu telefone e 11999999999 e quero orcamento`.
27. Confirmar cliente/lead criado sem duplicar no reenvio da mesma mensagem.
28. Enviar mensagem WhatsApp de venda: `Pagamento confirmado do pedido 1234 de R$ 197,00`.
29. Confirmar `Sale`, `FinancialTransaction`, Dashboard e Financeiro atualizados uma unica vez.
30. Enviar mensagem WhatsApp de agenda: `Quero agendar consulta amanha as 14h, meu nome e Ana e meu telefone e 11999999999`.
31. Confirmar `AppointmentRequest` criado/atualizado.
32. Enviar DM Instagram de lead/venda em ambiente conectado e validar cliente, lead, venda e financeiro quando houver valor confirmado.
33. Perguntar no chat IA: `Qual o principal risco agora?` e confirmar que a resposta usa dados reais e nao contem asteriscos.

## Validacoes extras

1. Rodar sync/webhook Mercado Livre duas vezes e confirmar que `Sale` e `FinancialTransaction` nao duplicam.
2. Testar webhook `orders_v2`, `items`, `questions` e `shipments`.
3. Confirmar que `/questions` redireciona para dashboard e nao aparece no menu.
4. Confirmar que Dashboard mostra filtros: Hoje, Ontem, 7 dias, Mes, Ano.
5. Exportar relatorio no Dashboard e confirmar PDF visual, nao CSV cru.
6. Confirmar que a camada inteligente mostra estado vazio premium quando nao ha dados suficientes.
7. Confirmar que nao existem labels visiveis como `Fase A`, `Dados completos` ou `dados reais do backend`.
