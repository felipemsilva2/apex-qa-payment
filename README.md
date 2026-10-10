# apex-qa-payment

Testes do fluxo de pagamento e checkout do Apex, com dados sintéticos.

## Regressão de assinatura e Pix automático

A implementação é carregada de um checkout local autorizado por `APEX_BILLING_SOURCE`. O repositório público contém somente testes e fixtures; não contém a implementação nem dados de clientes.

```sh
APEX_BILLING_SOURCE=/caminho/checkout-autorizado npm run test:billing-lifecycle
APEX_BILLING_SOURCE=/caminho/checkout-autorizado npm test -- tests/billing-integrity-source.test.ts tests/pix-manager-standard-source.test.ts
```

O primeiro comando usa Node.js e o TypeScript instalado no checkout autorizado. O segundo usa as dependências de desenvolvimento deste repositório.

Resultado de 10/10/2026: **14 testes comportamentais e 15 verificações de código passaram**. As 15 verificações também fazem parte de uma suíte existente de 26 testes, executada com sucesso no projeto autorizado.

Cobertura: autorização bancária sem recebimento, valor insuficiente, pagamento antigo, concorrência entre consulta e webhook, renovação de autorização ativa, identificação de parcelas vencidas, checkout sem cobrança avulsa de fallback, notificações compatíveis com o banco, uma mensalidade por ciclo e recuperação de resposta ambígua sem duplicação.

`tests/atomic-subscription-payment-fixture.sql` valida a operação atômica em PostgreSQL. Executar somente em banco de desenvolvimento autorizado, com as migrações de cobrança aplicadas. A fixture usa uma transação com `ROLLBACK`; não contém credenciais nem implementação. A validação transacional foi executada e passou.
