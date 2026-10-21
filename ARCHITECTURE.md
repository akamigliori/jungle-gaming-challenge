# Arquitetura — Distributed Wagering Processor

## 1. Visão geral

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de
provedores de jogos, mantendo carteiras (`Wallet`) com saldo exato e um ledger imutável.

Stack: NestJS sobre Bun, MikroORM com PostgreSQL, SQS (LocalStack em ambiente local), logs
estruturados com pino.

Princípios:

- **O banco é a última linha de defesa.** Invariantes financeiras (saldo não negativo, ledger
  append-only, aritmética do lançamento, uma reversão por referência, idempotência) são garantidas
  por constraints e triggers, não só pelo código.
- **Dinheiro nunca é `number`.** `Money` (decimal.js) no código, `NUMERIC(20,2)` + `CHAR(3)` no
  banco e strings `"25.00"` nos contratos.
- **Erros são estáveis e legíveis por máquina.** Toda falha tem um código fixo que diz ao provedor
  se deve corrigir, reenviar ou desistir.

## 2. Camadas

```
src/
  domain/          regras de negócio puras (sem framework, ORM, validação externa ou node:*)
  application/     casos de uso e portas (repositórios, TransactionRunner, IdGenerator, Clock)
  infrastructure/  adaptadores: config, MikroORM, SQS, logs, auth, ids, relógio
  interfaces/      entrada HTTP: controllers, filtro de erros, mapeamento de status
```

- A dependência aponta sempre para dentro: `interfaces` → `application` → `domain`;
  `infrastructure` implementa as portas da `application`.
- Entidades de domínio têm construtor privado, fábricas estáticas e estado privado; `rehydrate`
  reconstrói a partir do banco sem revalidar.
- Entidades de domínio e de persistência são classes separadas: o mapeamento do MikroORM usa
  `EntitySchema` sobre interfaces `*Record` em `infrastructure/persistence/schemas`, e cada
  repositório converte record ↔ domínio (`Money.from` sobre as strings `NUMERIC`).
- O `AppModule` compõe um `InfrastructureModule` global, que recebe a configuração já validada.
  Isso permite subir a aplicação nos testes com variáveis diferentes sem alterar `process.env`.

## 3. Taxonomia de `failureCode`

| Código | Significado | Provedor deve |
|---|---|---|
| `INVALID_PAYLOAD` | payload malformado | corrigir |
| `INVALID_MONEY` | valor monetário inválido | corrigir |
| `CURRENCY_MISMATCH` | moeda diferente da moeda da wallet/referência | corrigir |
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir |
| `PLAYER_MISMATCH` | player não é dono da wallet | corrigir |
| `INSUFFICIENT_FUNDS` | aposta sem saldo | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão levaria o saldo a negativo | escalar/desistir |
| `REFERENCE_REQUIRED` | `REFUND`/`ROLLBACK` sem referência | corrigir |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite de espera | desistir/investigar |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/rodada/moeda | corrigir |
| `INVALID_REFERENCE_KIND` | ex.: `REFUND` referenciando `WIN` | corrigir |
| `REFERENCE_NOT_PROCESSED` | referência não está `PROCESSED` | desistir |
| `ALREADY_REVERSED` | referência já revertida (uma reversão por referência, no total) | desistir |
| `AMOUNT_MISMATCH` | valor diferente do valor da referência | corrigir |
| `IDEMPOTENCY_CONFLICT` | mesma `Idempotency-Key` com payload diferente | corrigir |
| `INTERNAL_ERROR` | falha permanente de infraestrutura (`FAILED`) | investigar |

Códigos usados apenas na API HTTP (não são `failureCode` de transação): `WALLET_ALREADY_EXISTS`,
`NOT_FOUND`, `UNAUTHORIZED`, `SERVICE_UNAVAILABLE`.

## 4. O que é gravado vs. só erro HTTP

- **Não gravados** — falham antes de existir uma transação válida; não geram evento na outbox e
  ficam visíveis em log/métrica: `INVALID_PAYLOAD`, `INVALID_MONEY`, `REFERENCE_REQUIRED` (`400`),
  `WALLET_NOT_FOUND` (`404`), `IDEMPOTENCY_CONFLICT` (`409`). Via SQS são erros de negócio: a
  mensagem é confirmada (ack) sem efeito.
- **Gravados como `REJECTED`** — auditáveis, devolvidos em replay com `idempotentReplay: true` e
  publicados como `WagerTransactionRejected`: todos os demais códigos de negócio
  (`CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`,
  `REFERENCE_*`, `INVALID_REFERENCE_KIND`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`).

## 5. Mapeamento HTTP

O mesmo mapeamento vale para todos os endpoints (`src/interfaces/http/error-status-map.ts`):

| Status | Situação | Códigos |
|---|---|---|
| `400` | payload inválido | `INVALID_PAYLOAD`, `INVALID_MONEY`, `REFERENCE_REQUIRED` |
| `401` | autenticação | `UNAUTHORIZED` |
| `404` | recurso inexistente | `NOT_FOUND`, `WALLET_NOT_FOUND` |
| `409` | conflito | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| `422` | rejeição por regra de negócio | demais códigos de negócio |
| `202` | aceito com processamento pendente | transação em `PENDING_REFERENCE` |
| `503` | falha transitória de infraestrutura (com `Retry-After`) | `SERVICE_UNAVAILABLE` |
| `500` | erro inesperado | `INTERNAL_ERROR` |

Corpo de erro uniforme:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "retryable": false } }
```

`retryable` é `true` só para `SERVICE_UNAVAILABLE`. O filtro global (`HttpErrorFilter`) nunca
devolve stack trace: erros `5xx` são logados com o erro completo, `4xx` são logados sem o corpo
da requisição. JSON malformado e erros de validação viram `400 INVALID_PAYLOAD`; demais erros do
parser do corpo mantêm o status original com código `INVALID_PAYLOAD` (ex.: corpo grande demais →
`413`); falha de conexão com o banco vira `503`.

## 6. Interpretações de regra adotadas

- **Uma reversão por referência, no total.** O enunciado proíbe reverter a mesma referência duas
  vezes pelo mesmo tipo; adotamos a regra mais estrita: uma transação só pode ser revertida uma
  vez, por `REFUND` ou por `ROLLBACK`. Isso impede que a mesma `BET` receba `REFUND` e `ROLLBACK`
  (crédito em dobro). Desfazer um `REFUND` continua possível com um `ROLLBACK` do próprio
  `REFUND`. Garantido por índice único parcial em `wager_transactions`; a segunda reversão recebe
  `ALREADY_REVERSED`.
- **`WIN` e `LOSS` podem referenciar uma `BET`** (é comum o provedor apontar a aposta da rodada);
  `REFUND`/`ROLLBACK` exigem referência; `BET` e `OPENING` não aceitam.
- **Nunca arredondar silenciosamente.** Valores com mais de 2 casas decimais são rejeitados
  (`INVALID_MONEY`), não arredondados.
- **Normalização do valor antes do hash.** `"25.5"` vira `"25.50"` antes do cálculo do
  `payloadHash`, para que requisições equivalentes não virem conflito de idempotência. O hash é
  SHA-256 do JSON canônico (chaves ordenadas) dos campos de negócio.
- **Ledger paginado por `wallet_version`.** A ordem do ledger é a sequência exata de versões da
  wallet (única por wallet); o cursor é opaco. UUIDv7 não serve como ordem porque não é monotônico
  entre instâncias.
- **Eventos publicados em `wagering-events.fifo`**, a partir da outbox transacional.

## 7. Persistência e criação de wallet

- **Uma transação SQL por caso de uso.** A porta `TransactionRunner` abre a transação no
  `EntityManager` global (`em.transactional`); o MikroORM propaga o contexto por
  AsyncLocalStorage, então os repositórios participam dela sem receber a transação por parâmetro.
  Se qualquer passo lança erro, tudo é desfeito (rollback).
- **Escritas explícitas com `em.insert`.** Cada repositório executa o `INSERT` na hora, em vez de
  acumular mudanças para um `flush` no fim. A ordem dos comandos fica explícita no caso de uso
  (wallet → transação → ledger → outbox), as violações de constraint aparecem no ponto exato em
  que acontecem e não há unit of work implícito para depurar.
- **`POST /wallets`**: numa única transação, insere a wallet e, se o saldo inicial for positivo, a
  transação interna `OPENING` já `PROCESSED`, o lançamento `CREDIT` (versão 1) e os eventos
  `WagerTransactionProcessed` e `WalletBalanceChanged` na outbox. Saldo zero grava só a wallet
  (versão 1). O `payloadHash` da `OPENING` usa o mesmo algoritmo das transações de provedor, com
  `providerId = 'internal'`, `externalTransactionId = walletId`, `roundId = 'opening'` e
  `gameId = 'internal'`.
- **Wallet duplicada** (mesmo `playerId` e moeda) é detectada pela constraint
  `wallets_player_currency_uq`, nunca por um `SELECT` prévio: com requisições simultâneas, o
  segundo `INSERT` espera o primeiro terminar e recebe a violação de unicidade, traduzida em
  `409 WALLET_ALREADY_EXISTS`. Um `SELECT` antes do `INSERT` teria uma janela de corrida entre
  as instâncias.
- **Ledger paginado por `wallet_version`**: `GET /wallets/:walletId/ledger` lê direto do banco
  (sem passar pelo agregado), em ordem crescente de versão. O cursor é o base64url da última versão
  devolvida; a consulta busca `limit + 1` linhas para saber se há próxima página. Como a versão é
  única e crescente por wallet, novos lançamentos nunca deslocam as páginas já lidas.

## 8. Autenticação

Hoje não há autenticação: o `AuthGuard` global é um no-op que libera todas as requisições. Ele é o
ponto de extensão explícito para integrar um IdP externo, junto com o contrato
`ProviderIdentityPort`.

Desenho planejado (Keycloak, OIDC):

- cada provedor é um client no Keycloak e obtém um token via client credentials;
- o `AuthGuard` valida o bearer token (assinatura via JWKS, `iss`, `aud`, expiração) e responde
  `401 UNAUTHORIZED` quando inválido;
- o `ProviderIdentityPort` extrai o `providerId` das claims, e o caso de uso exige que ele seja
  igual ao `providerId` do corpo.

Os endpoints de health (`/health/live`, `/health/ready`) são marcados com `@Public()` e continuam
abertos. Mensagens da fila são tratadas como canal interno confiável, mas a identidade do provedor
na mensagem passa pelas mesmas validações de domínio.

## 9. Observabilidade e health checks

- Logs JSON (pino) com uma linha por requisição. O header `x-correlation-id` é aceito (se for um
  valor curto e seguro) ou gerado como UUIDv7, devolvido na resposta e incluído como
  `correlationId` em todas as linhas de log da requisição. `authorization`, cookies e o corpo da
  requisição são omitidos dos logs.
- `GET /health/live`: processo vivo, sem consultar dependências.
- `GET /health/ready`: `SELECT 1` no Postgres e `GetQueueUrl` nas três filas, em paralelo, cada
  verificação com timeout de 2 s; `503` indicando qual dependência está `down`. O cliente SQS não
  faz retry interno e tem timeout de conexão e de requisição, para não travar a verificação.

## 10. Limitações conhecidas

- `TRUNCATE` não dispara os triggers de linha que tornam o ledger append-only. Ele é usado apenas
  nos testes para limpar o banco; em produção o usuário da aplicação não deve ter permissão de
  `TRUNCATE`.
- Autenticação ainda não implementada (ver seção 8).
