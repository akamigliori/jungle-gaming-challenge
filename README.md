# Distributed Wagering Processor

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de
provedores de jogos, mantendo wallets com saldo exato e um ledger imutável. Decisões de design,
taxonomia de erros e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

Stack: Bun 1.x, TypeScript (strict), NestJS, MikroORM, PostgreSQL 17, SQS (LocalStack), pino.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose

## Setup

```bash
bun install
cp .env.example .env          # opcional: os defaults já apontam para o docker compose
docker compose up -d --wait   # Postgres (porta 5433 do host) e LocalStack com as filas SQS
bun run migration:up          # aplica as migrations no banco `wagering`
bun run dev                   # API em http://localhost:3000 (recarrega ao salvar)
```

O Postgres é publicado na porta **5433** do host (e não 5432) para não conflitar com uma
instalação local. Na primeira subida do volume, o container também cria o banco `wagering_test`,
usado pelos testes de integração. Se o volume já existia antes, crie-o à mão:
`docker compose exec postgres createdb -U wagering wagering_test`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | sobe a API com recarga automática |
| `bun run start` | sobe a API |
| `bun run typecheck` | checagem de tipos (`tsc --noEmit`) |
| `bun run lint` | lint e formatação (Biome) |
| `bun run check:money` | falha se o código usar `parseFloat`, `parseInt`, `Number()` ou `toFixed` fora das exceções listadas no script (dinheiro nunca é `number`) |
| `bun run check:architecture` | falha se `src/domain` ou `src/application` importarem framework, ORM, SDK ou as camadas externas (`infrastructure`, `interfaces`); exceções listadas no script |
| `bun run test` | testes unitários (`test/unit`, sem Docker) |
| `bun run test:integration` | testes de integração (`test/integration`, Postgres e LocalStack reais) |
| `bun run test:concurrency` | testes de concorrência (`test/concurrency`, requisições HTTP simultâneas contra Postgres real) |
| `bun run migration:up` | aplica as migrations pendentes |
| `bun run migration:down` | reverte a última migration |

Use `bun run test`, e não `bun test` puro: este último também executaria os testes de integração.

## CI

O GitHub Actions (`.github/workflows/ci.yml`) roda em todo pull request e em todo push para
`develop` e `main`: typecheck, lint, `check:money`, `check:architecture`, testes unitários e, com o Postgres e o
LocalStack do `docker-compose.yml`, os testes de integração e os de concorrência.

## Testes de integração

Precisam do `docker compose up -d --wait` em execução: usam o Postgres e o LocalStack reais (sem
mocks), no banco `wagering_test`, e aplicam as migrations sozinhos. Cada teste limpa as tabelas
antes de rodar. Os logs da aplicação ficam silenciosos durante os testes, mesmo com `LOG_LEVEL` no `.env`; para
vê-los, defina `TEST_LOG_LEVEL` (ex.: `TEST_LOG_LEVEL=info bun run test:integration`).

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP da API |
| `LOG_LEVEL` | `info` | nível de log do pino (`silent` desliga) |
| `DB_HOST` | `localhost` | host do Postgres |
| `DB_PORT` | `5433` | porta do Postgres |
| `DB_USER` | `wagering` | usuário do Postgres |
| `DB_PASSWORD` | `wagering` | senha do Postgres |
| `DB_NAME` | `wagering` | banco da aplicação |
| `TEST_DB_NAME` | `wagering_test` | banco usado pelos testes de integração |
| `TEST_LOG_LEVEL` | `silent` | nível de log da aplicação nos testes de integração |
| `SQS_ENDPOINT` | `http://localhost:4566` | endpoint do SQS (LocalStack) |
| `AWS_REGION` | `us-east-1` | região AWS |
| `AWS_ACCESS_KEY_ID` | `test` | credencial AWS (LocalStack aceita qualquer valor) |
| `AWS_SECRET_ACCESS_KEY` | `test` | credencial AWS |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publisher da outbox nesta instância (`false` desliga; nos testes de integração o padrão é `false`) |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | intervalo entre ciclos do publisher quando não há lote cheio |
| `OUTBOX_BATCH_SIZE` | `50` | máximo de eventos reservados por ciclo |
| `OUTBOX_LEASE_MS` | `30000` | prazo da reserva de um lote; se a instância morrer, outra o assume depois disso |

## Endpoints

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria uma wallet: `{ "playerId": "<uuid>", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }` → `201` |
| `GET /wallets/:walletId` | consulta a wallet → `200 { id, playerId, balance, version }` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | ledger em ordem de versão, paginado (`limit` de 1 a 200, padrão 50) → `200 { items, nextCursor }` |
| `POST /wagering/transactions` | submete `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` (header `Idempotency-Key` obrigatório) → `201` processada, `202` aguardando a referência, `422` rejeitada por regra de negócio, `409` chave reutilizada com outro payload |
| `GET /wagering/transactions/:transactionId` | consulta uma transação pelo id interno → `200`, `404 NOT_FOUND` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta uma transação pelo id do provedor → `200`, `404 NOT_FOUND` |
| `GET /health/live` | processo vivo |
| `GET /health/ready` | Postgres e filas SQS alcançáveis (`503` se alguma dependência cair) |

Exemplo:

```bash
curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Aposta de `25.00` (troque `<walletId>` pelo `id` devolvido acima; o `playerId` precisa ser o dono
da wallet):

```bash
curl -s -XPOST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'idempotency-key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# → 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Reenviar a mesma requisição devolve o mesmo resultado com `"idempotentReplay": true` e o header
`Idempotent-Replayed: true`, sem novo débito. Reenviar a mesma chave com outro valor devolve
`409 IDEMPOTENCY_CONFLICT`. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.

Erros seguem sempre o formato `{ "error": { "code", "message", "retryable" } }`; o mapeamento de
códigos para status HTTP está em `ARCHITECTURE.md`.

## Cenários obrigatórios de concorrência → teste

Testes em `test/concurrency/wagering-races.test.ts` (`bun run test:concurrency`). Para rodar um só,
filtre pelo nome: `bun run test:concurrency -t "2×80.00"`.

| # | Cenário | Teste |
|---|---|---|
| 1 | a mesma aposta enviada 50 vezes em paralelo → um único débito | `same BET 50× in parallel (same key and payload) → all 201, 49 replays, one row, one DEBIT, balance 75.00`; complementado por `same key on 2 different wallets in parallel → one 201, the other 409 IDEMPOTENCY_CONFLICT, no 5xx` |
| 2 | operações concorrentes disputando o saldo da mesma wallet (100.00 com 2 × 80.00) | `100.00 with 2×80.00 at the same time, 10 rounds → one 201, one 422 INSUFFICIENT_FUNDS, balance 20.00, one DEBIT`; complementado por `REFUND and ROLLBACK of the same BET in parallel → one 201, one 422 ALREADY_REVERSED, a single CREDIT back` |
| 3 | wallets distintas processadas em paralelo | `10 wallets × 20 BETs of 7.00 at the same time → per wallet 14 processed, 6 INSUFFICIENT_FUNDS, balance 2.00`; complementado por `lock is per wallet: a BET on wallet B gets 201 in < 1 s while wallet A stays locked` |
| 4 | ≥ 3 processos/instâncias simultâneos | pendente |
| 5 | worker morto depois do commit e antes do ack | pendente |
| 6 | dois publishers sobre a mesma outbox | `two concurrent publishers over 100 events -> every event received, none claimed twice, none left pending` (em `test/integration/outbox-publisher.test.ts`, `bun run test:integration`); complementado por `lease: a claimed batch that is never published is not re-claimed before the lease expires, and is published after it` |
| 7 | `ROLLBACK` ou `REFUND` entregue antes da referência | pendente |
| 8 | reinício do serviço com comprovação da consistência final | pendente |

Invariante verificada depois de cada teste que grava pela aplicação (integração e concorrência):
saldo da wallet = soma do ledger, com versões contínuas (`test/integration/support/invariants.ts`).
