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
| `bun run test` | testes unitários (`test/unit`, sem Docker) |
| `bun run test:integration` | testes de integração (`test/integration`, Postgres e LocalStack reais) |
| `bun run migration:up` | aplica as migrations pendentes |
| `bun run migration:down` | reverte a última migration |

Use `bun run test`, e não `bun test` puro: este último também executaria os testes de integração.

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

## Endpoints

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria uma wallet: `{ "playerId": "<uuid>", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }` → `201` |
| `GET /wallets/:walletId` | consulta a wallet → `200 { id, playerId, balance, version }` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | ledger em ordem de versão, paginado (`limit` de 1 a 200, padrão 50) → `200 { items, nextCursor }` |
| `GET /health/live` | processo vivo |
| `GET /health/ready` | Postgres e filas SQS alcançáveis (`503` se alguma dependência cair) |

Exemplo:

```bash
curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Erros seguem sempre o formato `{ "error": { "code", "message", "retryable" } }`; o mapeamento de
códigos para status HTTP está em `ARCHITECTURE.md`.
