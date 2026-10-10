# apex-qa-payment

Testes do fluxo de pagamento e checkout do Apex, com dados sintéticos.

## Regressão de assinatura e Pix automático

A implementação é carregada de um checkout local autorizado por `APEX_BILLING_SOURCE`. O repositório público contém somente testes e fixtures; não contém a implementação nem dados de clientes.

```sh
APEX_BILLING_SOURCE=/caminho/checkout-autorizado npm run test:billing-lifecycle
APEX_BILLING_SOURCE=/caminho/checkout-autorizado npm run test:payment-access
APEX_BILLING_SOURCE=/caminho/checkout-autorizado npm test -- tests/billing-integrity-source.test.ts tests/pix-manager-standard-source.test.ts
```

Os dois primeiros comandos usam Node.js e o TypeScript instalado no checkout autorizado. O fluxo de acesso também usa React, React DOM, React Router e jsdom desse checkout. O último comando usa as dependências de desenvolvimento deste repositório.

Resultado de 10/10/2026: **14 testes comportamentais e 15 verificações de código passaram**. As 15 verificações também fazem parte de uma suíte existente de 26 testes, executada com sucesso no projeto autorizado.

Validação complementar de 10/10/2026: **24 testes passaram no comando `test:payment-access`** (os 14 anteriores e 10 novos). A fixture PostgreSQL ampliada também passou, com todas as alterações revertidas por `ROLLBACK`.

Cobertura: autorização bancária sem recebimento, valor insuficiente, pagamento antigo, concorrência entre consulta e webhook, renovação de autorização ativa, identificação de parcelas vencidas, checkout sem cobrança avulsa de fallback, notificações compatíveis com o banco, uma mensalidade por ciclo e recuperação de resposta ambígua sem duplicação.

## Bloqueio, confirmação e liberação

`tests/payment-access-flow.node.cjs` carrega os handlers e componentes reais do checkout autorizado. O SDK do banco e as respostas do provedor são sintéticos; chamadas externas de comunicação são isoladas. Os componentes React são renderizados no jsdom. Isso não representa um pagamento bancário real nem uma sessão de cliente em navegador.

Os casos verificam:

- API protegida retorna 403 antes do pagamento e permite acesso depois de um webhook financeiro válido.
- Vencimento bloqueia acesso mesmo antes de a rotina de expiração atualizar o status.
- Webhook sem autenticação, autorização bancária sem recebimento e valor insuficiente não liberam acesso.
- Confirmações duplicadas não prorrogam o mesmo pagamento duas vezes.
- A rota protegida mostra o bloqueio antes do pagamento e abre o painel depois da confirmação.
- A tela bloqueada exige também o status físico ativo da academia, evitando redirecionamentos com suspensão ainda vigente.
- A tela de cobrança mostra o QR da parcela existente; uma consulta pendente preserva o bloqueio, e a consulta automática após o recebimento mostra a confirmação.
- O contexto real da academia atualiza o acesso por evento de assinatura em tempo real e ao recuperar o foco da janela.
- Os listeners de tempo real são removidos ao desmontar a interface.

`tests/atomic-subscription-payment-fixture.sql` valida a operação atômica instalada em PostgreSQL: reativação financeira e física, prazo válido, limpeza das travas antigas, duplicação, renovação, confirmação histórica e permissão de execução. Executar somente em banco explicitamente autorizado, com as migrações de cobrança aplicadas. A fixture usa uma transação com `ROLLBACK`; não contém credenciais nem implementação.
