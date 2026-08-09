# Testes de pagamento — Apex

## Objetivo

Validar a entrada de cartão antes de iniciar o checkout:

- normalização do número;
- validação de Luhn;
- nome do titular;
- validade com ano de dois ou quatro dígitos;
- CVV;
- rejeição de cartão inválido ou expirado.

Os dados usados são cartões de teste e não geram cobrança.

## Execução

```bash
npm install
npm test
```

A implementação auxiliar publicada em `src/lib/payment-validation.ts` é pequena e independente para que o cenário possa ser reproduzido sem expor o código privado do produto.
