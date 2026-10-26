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
  infrastructure/  adaptadores: config, MikroORM, SQS, logs, auth, ids, relógio, workers
  interfaces/      entrada HTTP: controllers, filtro de erros, mapeamento de status
```

- A dependência aponta sempre para dentro: `interfaces` → `application` → `domain`;
  `infrastructure` implementa as portas da `application`. As camadas externas (`interfaces` e
  `infrastructure`) podem se referenciar para composição e leituras (health check, consulta do
  ledger no `GET`), mas o núcleo (`domain` e `application`) nunca importa nenhuma delas.
- A regra é verificada no CI por `bun run check:architecture`: o domínio só pode importar o
  próprio domínio e `decimal.js`; a aplicação, o domínio, ela mesma e `node:crypto` (hash do
  payload). Qualquer outro import no núcleo — framework, ORM, SDK ou camada externa — falha o build.
- Entidades de domínio têm construtor privado, fábricas estáticas e estado privado; `rehydrate`
  reconstrói a partir do banco sem revalidar.
- Entidades de domínio e de persistência são classes separadas: o mapeamento do MikroORM usa
  `EntitySchema` sobre interfaces `*Record` em `infrastructure/persistence/schemas`, e cada
  repositório converte record ↔ domínio (`Money.from` sobre as strings `NUMERIC`).
- O `AppModule` compõe um `InfrastructureModule` global, que recebe a configuração já validada.
  Isso permite subir a aplicação nos testes com variáveis diferentes sem alterar `process.env`.

## 3. Taxonomia de `failureCode`

| Código                        | Significado                                                     | Provedor deve       |
| ----------------------------- | --------------------------------------------------------------- | ------------------- |
| `INVALID_PAYLOAD`             | payload malformado                                              | corrigir            |
| `INVALID_MONEY`               | valor monetário inválido                                        | corrigir            |
| `CURRENCY_MISMATCH`           | moeda diferente da moeda da wallet/referência                   | corrigir            |
| `WALLET_NOT_FOUND`            | wallet inexistente                                              | corrigir            |
| `PLAYER_MISMATCH`             | player não é dono da wallet                                     | corrigir            |
| `INSUFFICIENT_FUNDS`          | aposta sem saldo                                                | desistir            |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão levaria o saldo a negativo                             | escalar/desistir    |
| `BALANCE_LIMIT_EXCEEDED`      | crédito levaria o saldo além do máximo de `NUMERIC(20,2)`       | escalar/desistir    |
| `REFERENCE_REQUIRED`          | `REFUND`/`ROLLBACK` sem referência                              | corrigir            |
| `REFERENCE_NOT_FOUND`         | referência não chegou dentro do limite de espera                | desistir/investigar |
| `REFERENCE_MISMATCH`          | referência de outro player/wallet/rodada/moeda                  | corrigir            |
| `INVALID_REFERENCE_KIND`      | ex.: `REFUND` referenciando `WIN`                               | corrigir            |
| `REFERENCE_NOT_PROCESSED`     | referência não está `PROCESSED`                                 | desistir            |
| `ALREADY_REVERSED`            | referência já revertida (uma reversão por referência, no total) | desistir            |
| `AMOUNT_MISMATCH`             | valor diferente do valor da referência                          | corrigir            |
| `IDEMPOTENCY_CONFLICT`        | mesma `Idempotency-Key` com payload diferente                   | corrigir            |
| `INTERNAL_ERROR`              | falha permanente de infraestrutura (`FAILED`)                   | investigar          |

Nos códigos `REJECTED` marcados como "corrigir" (`CURRENCY_MISMATCH`, `PLAYER_MISMATCH`,
`REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`), a transação rejeitada é
terminal: reenviar o payload corrigido com a mesma chave ou o mesmo `externalTransactionId`
devolve `409`. A correção deve ir como uma nova transação (novo `externalTransactionId` e nova
`Idempotency-Key`).

Códigos usados apenas na API HTTP (não são `failureCode` de transação): `WALLET_ALREADY_EXISTS`,
`NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `SERVICE_UNAVAILABLE`.

## 4. O que é gravado vs. só erro HTTP

- **Não gravados** — falham antes de existir uma transação válida; não geram evento na outbox e
  ficam visíveis em log/métrica: `INVALID_PAYLOAD`, `INVALID_MONEY`, `REFERENCE_REQUIRED` (`400`),
  `WALLET_NOT_FOUND` (`404`), `IDEMPOTENCY_CONFLICT` (`409`). No consumer SQS, a mensagem vai
  para a DLQ na primeira entrega, com o código no atributo `failureCode` (seção 12).
- **Gravados como `REJECTED`** — auditáveis, devolvidos em replay com `idempotentReplay: true` e
  publicados como `WagerTransactionRejected`: todos os demais códigos de negócio
  (`CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`,
  `BALANCE_LIMIT_EXCEEDED`, `REFERENCE_*`, `INVALID_REFERENCE_KIND`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`).

## 5. Mapeamento HTTP

O mesmo mapeamento vale para todos os endpoints (`src/interfaces/http/error-status-map.ts`):

| Status | Situação                                                                    | Códigos                                                  |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `400`  | payload inválido                                                            | `INVALID_PAYLOAD`, `INVALID_MONEY`, `REFERENCE_REQUIRED` |
| `401`  | token ausente ou inválido                                                   | `UNAUTHORIZED`                                           |
| `403`  | token válido sem o escopo exigido, ou provedor do token ≠ provedor do corpo | `FORBIDDEN`                                              |
| `404`  | recurso inexistente                                                         | `NOT_FOUND`, `WALLET_NOT_FOUND`                          |
| `409`  | conflito                                                                    | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`          |
| `422`  | rejeição por regra de negócio                                               | demais códigos de negócio                                |
| `202`  | aceito com processamento pendente                                           | transação em `PENDING_REFERENCE`                         |
| `503`  | falha transitória de infraestrutura (com `Retry-After`)                     | `SERVICE_UNAVAILABLE`                                    |
| `500`  | erro inesperado                                                             | `INTERNAL_ERROR`                                         |

Corpo de erro uniforme:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "retryable": false } }
```

`retryable` é `true` só para `SERVICE_UNAVAILABLE`. O filtro global (`HttpErrorFilter`) nunca
devolve stack trace: erros `5xx` são logados apenas com campos seguros (`safeError`), `4xx` são logados sem o corpo
da requisição. JSON malformado e erros de validação viram `400 INVALID_PAYLOAD`; demais erros do
parser do corpo mantêm o status original com código `INVALID_PAYLOAD` (ex.: corpo grande demais →
`413`); falha de conexão com o banco vira `503`. Nas respostas `5xx` a mensagem é sempre genérica
(`Internal server error` ou `Service temporarily unavailable`), mesmo quando o erro é um erro de
domínio: o detalhe fica só no log. Uma soma de `Money` fora da faixa do `NUMERIC(20,2)` nunca
chega ao banco: `Money.add` lança erro de domínio e, num crédito, a transação é gravada como
`REJECTED` com `BALANCE_LIMIT_EXCEEDED` (`422`).

## 6. Interpretações de regra adotadas

- **Uma reversão por referência, no total.** O enunciado proíbe reverter a mesma referência duas
  vezes pelo mesmo tipo; adotamos a regra mais estrita: uma transação só pode ser revertida uma
  vez, por `REFUND` ou por `ROLLBACK`. Isso impede que a mesma `BET` receba `REFUND` e `ROLLBACK`
  (crédito em dobro). Desfazer um `REFUND` continua possível com um `ROLLBACK` do próprio
  `REFUND`. Garantido por índice único parcial em `wager_transactions`; a segunda reversão recebe
  `ALREADY_REVERSED`. Como `NULL`s são distintos num índice único, o CHECK
  `wager_tx_reversal_resolved_ck` exige que todo `REFUND`/`ROLLBACK` `PROCESSED` tenha
  `reference_transaction_id` preenchido; sem ele, uma reversão sem referência resolvida escaparia
  do índice.
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
- **Integridade do ledger no schema.** Além da FK de `transaction_id`, o trigger
  `ledger_wallet_matches_transaction` rejeita (BEFORE INSERT) um lançamento cujo par
  `(transaction_id, wallet_id)` não exista em `wager_transactions` — isto é, cuja wallet difere da
  wallet da transação referenciada. A alternativa declarativa (FK composta) exigiria um
  `UNIQUE (id, wallet_id)` redundante em `wager_transactions`; o trigger dá a mesma garantia sem
  índice a mais na tabela mais quente do fluxo.
- **Partidas dobradas no schema.** Toda entrada de wallet tem uma contrapartida igual e oposta na
  conta da casa (`journal_entries`, `account_id = house:{provider}:{currency}`), gravada na mesma
  transação SQL. A soma-zero por transação é garantida pelo banco: o trigger
  `journal_matches_wallet` (BEFORE INSERT) confere direção oposta + mesmo valor + mesma moeda, e o
  constraint trigger deferido `wallet_requires_journal` exige a contrapartida no `COMMIT`. A casa
  não tem saldo materializado (evita linha quente global): o saldo dela é `SUM` sob demanda.
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

## 8. Processamento de transações de aposta

`POST /wagering/transactions` chama o `ProcessWagerTransactionUseCase`, que é o único ponto de
entrada do processamento (o consumer SQS chama o mesmo caso de uso, seção 12). Antes de abrir a
transação SQL, o comando é validado sem tocar no banco: `Money.from` (valor inválido →
`INVALID_MONEY`), `REFUND`/`ROLLBACK` sem referência → `REFERENCE_REQUIRED`, `kind = OPENING` ou
`providerId = 'internal'` → `INVALID_PAYLOAD` (reservados para a transação de abertura), UUIDs
normalizados para minúsculas e cálculo do `payloadHash`.

Depois, numa única transação SQL:
1. `SET LOCAL lock_timeout = '2s'` e `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`. Wallet
   inexistente → `404 WALLET_NOT_FOUND`, nada gravado.
2. Idempotência (seção 10): replay da original, `409` ou segue.
3. Regras de negócio (`decideWager`, função pura do domínio), na ordem: player dono da wallet
   (`PLAYER_MISMATCH`), moeda (`CURRENCY_MISMATCH`), referência, saldo.
4. Gravação, nesta ordem: `UPDATE` da wallet com `WHERE version = $anterior` (segunda defesa: se o
   lock faltasse, nenhuma linha seria alterada e a transação falharia), `INSERT` da transação, do
   lançamento no ledger e dos eventos na outbox. Rejeitada ou pendente grava só a transação e o
   evento correspondente, sem ledger e sem mudar o saldo.

### Regras por tipo

| Tipo       | Efeito                                                                                                                        | Referência                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `BET`      | débito; sem saldo → `INSUFFICIENT_FUNDS`                                                                                      | não aceita                                    |
| `WIN`      | crédito                                                                                                                       | opcional; se informada, precisa ser uma `BET` |
| `LOSS`     | nenhum movimento (`PROCESSED`, sem ledger, só `WagerTransactionProcessed`)                                                    | opcional; se informada, precisa ser uma `BET` |
| `REFUND`   | crédito do valor da `BET`                                                                                                     | obrigatória, só `BET`                         |
| `ROLLBACK` | inverso da referência (desfaz `BET` com crédito, `WIN`/`REFUND` com débito); débito sem saldo → `REVERSAL_INSUFFICIENT_FUNDS` | obrigatória: `BET`, `WIN` ou `REFUND`         |

A referência é resolvida por `(provider_id, reference_external_transaction_id)` e verificada nesta
ordem; a primeira regra violada decide o `failureCode`:
- ainda não existe → `202 PENDING_REFERENCE` (grava `next_reference_attempt_at`; o worker a
  reavalia depois, ver "Referências fora de ordem");
- de outro player, wallet, rodada ou moeda → `REFERENCE_MISMATCH`;
- tipo não permitido pela tabela acima → `INVALID_REFERENCE_KIND` (ex.: `REFUND` de um `WIN`, ou
  `ROLLBACK` de um `LOSS`: o `LOSS` não moveu saldo, não há o que desfazer);
- referência existe mas ainda não foi decidida (`PENDING` ou `PENDING_REFERENCE`, como um `WIN`
  que espera a sua `BET`) → também `202 PENDING_REFERENCE`;
- referência terminou sem ser aplicada (`REJECTED` ou `FAILED`) → `REFERENCE_NOT_PROCESSED`;
- referência já revertida → `ALREADY_REVERSED`. Vale também para `WIN`/`LOSS`: pagar o `WIN` de
  uma aposta já estornada pagaria duas vezes;
- só em `REFUND`/`ROLLBACK`: valor diferente do valor da referência → `AMOUNT_MISMATCH`.

`WIN`/`LOSS` sem referência são aceitos sem vínculo (o provedor nem sempre informa a aposta).

### Referências fora de ordem

Um `REFUND` pode chegar antes da sua `BET` (filas diferentes, reentrega, provedor fora de ordem).
A transação fica `PENDING_REFERENCE` e um worker em segundo plano
(`PendingReferenceWorker`, um por instância, ligado por `PENDING_REFERENCE_WORKER_ENABLED`) a
reavalia até a referência aparecer ou as tentativas acabarem.

**Reavaliação** (`ResolvePendingReferenceUseCase`, uma transação SQL por pendência):
1. trava a wallet (`SELECT ... FOR UPDATE`), como todo processamento;
2. recarrega a transação; se ela não está mais `PENDING_REFERENCE` (outra instância decidiu antes),
   sai sem efeito;
3. aplica as mesmas regras do processamento normal (`decideWager`, sem regra duplicada);
4. grava o resultado com o mesmo código do processamento normal, trocando o `INSERT` da transação
   por um `UPDATE ... WHERE status = 'PENDING_REFERENCE'` (0 linhas = bug, a transação é desfeita):
   - resolvida (`PROCESSED`) → saldo, ledger, `WagerTransactionProcessed` + `WalletBalanceChanged`;
   - rejeitada por regra ou por esgotar as tentativas → `WagerTransactionRejected`;
   - ainda pendente → só `reference_attempts` e `next_reference_attempt_at`, **sem evento** (um
     evento a cada tentativa seria ruído para os consumidores).

Os eventos da resolução usam o id da transação pendente como `correlationId`: não há requisição
ou mensagem de origem viva naquele momento, e o id liga os eventos à transação.

**Backoff e limite.** A espera até a próxima tentativa é `min(base × 2^tentativas, teto)`, sem
jitter (o worker não disputa nada além do lock da wallet, e o claim já espalha o trabalho entre as
instâncias). Com os valores padrão (`REFERENCE_RETRY_BASE_MS` 2 s, `REFERENCE_RETRY_MAX_MS` 60 s,
`REFERENCE_MAX_ATTEMPTS` 10), as esperas são 2, 4, 8, 16, 32 e depois 60 s, e a 10ª reavaliação
do worker desiste (a que desiste não é contada em `reference_attempts`): cerca de **6 minutos**
desde a chegada. O motivo: o provedor normalmente manda a referência em segundos; minutos cobrem
atraso de fila e reentrega do próprio provedor sem deixar a transação pendente (e o jogador sem
resposta) por horas. Os três valores são configuráveis, e os testes usam esperas de 100 a 400 ms
com 3 reavaliações. Ao desistir, a transação vira `REJECTED`
com um código preciso:
- `REFERENCE_NOT_FOUND`: a referência nunca chegou;
- `REFERENCE_NOT_PROCESSED`: a referência existe, mas continuou sem decisão (ex.: um `ROLLBACK` de
  um `WIN` cuja `BET` nunca chegou).

**Acordar dependentes.** Esperar o backoff depois que a referência chega atrasaria um `REFUND` em
até 60 s. Por isso, quando uma transação termina (`PROCESSED` ou `REJECTED`), na mesma transação
SQL, as pendentes da mesma wallet e provedor que a referenciam têm `next_reference_attempt_at`
antecipado para agora (`UPDATE` coberto por um índice parcial só das pendentes). `REJECTED` também
acorda, para o dependente virar `REFERENCE_NOT_PROCESSED` na hora. Acordar não conta tentativa e
não gera evento. A cadeia anda sozinha: a `BET` acorda o `WIN`, o `WIN` processado acorda o
`ROLLBACK`.

**Claim com lease.** Cada ciclo reserva até 50 pendências vencidas numa transação curta
(`SELECT ... FOR UPDATE SKIP LOCKED`, mais antigas primeiro) e, no mesmo `COMMIT`, empurra o
`next_reference_attempt_at` delas pelo lease (`PENDING_REFERENCE_LEASE_MS`, 30 s por padrão).
Duas instâncias nunca pegam a mesma linha no mesmo ciclo; se a instância morrer, as linhas voltam quando o lease vence. O lease não toca em
`updated_at` (é coordenação entre instâncias, não mudança de negócio). O lote é agrupado por
wallet: dentro da wallet, um item por vez, na ordem do claim; no máximo 2 wallets ao mesmo tempo
(seção 9). Um item que falha é logado (só ids) e espera o lease; os demais seguem. Mesmo que duas
instâncias reavaliem a mesma pendência (lease vencido, ou acordada durante um claim), o lock da
wallet as serializa: se a primeira resolveu, a segunda sai no passo 2; se a primeira só reagendou,
a segunda conta mais uma tentativa (inofensivo: no pior caso a desistência chega uma tentativa
antes).

**Como é testado** (`test/integration/pending-reference.test.ts`, Postgres e LocalStack reais, com
o worker ligado e a política curta): `REFUND` antes da `BET` → `PROCESSED` com saldo e eventos
corretos; referência que nunca chega → `REJECTED REFERENCE_NOT_FOUND` com `reference_attempts` = 2
e `WagerTransactionRejected`; cadeia `WIN` e `ROLLBACK` do `WIN` antes da `BET` → os dois
`PROCESSED`, na ordem; referência rejeitada → dependente `REFERENCE_NOT_PROCESSED` em menos de dois
ciclos; duas instâncias do caso de uso sobre a mesma pendência → um único crédito e um `skipped`;
via SQS, `REFUND` e `BET` no mesmo grupo, nessa ordem → os dois `PROCESSED`. Nos testes de acordar,
a pendência é empurrada para daqui a 1 hora antes de a referência chegar: só o "acordar" explica a
resolução no tempo do teste.

### HTTP

| Rota                                                                                     | Resposta                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /wagering/transactions` (header `Idempotency-Key` obrigatório, até 255 caracteres) | `201` `PROCESSED`, `202` `PENDING_REFERENCE`, `422` `REJECTED`, `409` conflito de idempotência, `400`/`404` como na seção 5, `503` + `Retry-After` em falha transitória |
| `GET /wagering/transactions/:transactionId`                                              | `200` com a transação, `404 NOT_FOUND`                                                                                                                                  |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId`                | `200` com a transação, `404 NOT_FOUND`                                                                                                                                  |

Corpo do `POST`: `{ transactionId, status, balance, idempotentReplay }`; no `422` o corpo também
traz `error: { code, message, retryable }`. `balance` é o saldo depois da transação (em
`REJECTED`, o saldo observado na decisão; em `PENDING_REFERENCE`, `null`; a rejeição por moeda divergente também devolve `null`, porque o saldo é de outra moeda). Replay devolve o mesmo
status do original com `idempotentReplay: true` e o header `Idempotent-Replayed: true`. O valor
recomendado para a chave é `"{providerId}:{externalTransactionId}"`, mas não é imposto. Os `GET`s
leem direto do banco e devolvem um DTO, sem passar pelo agregado.

## 9. Concorrência

**Lock pessimista por wallet.** Toda transação de aposta começa com `SELECT ... FOR UPDATE` na
linha da wallet: transações da mesma wallet entram uma de cada vez, em qualquer instância, porque o
lock é do Postgres e não da memória do processo. Wallets diferentes não se bloqueiam. Cada
transação trava exatamente uma wallet, então não existe ciclo de espera entre locks de wallets. Um
deadlock improvável envolvendo os índices únicos (duas transações de wallets diferentes inserindo
chaves cruzadas) é detectado pelo Postgres e tratado como falha transitória, como abaixo.

Por que não lock otimista: o caso crítico é a _hot wallet_ (muitas apostas simultâneas no mesmo
saldo). Com versão + retry, a cada rodada só uma transação vence e as outras refazem todo o
trabalho; sob disputa alta, o número de tentativas cresce e o retry limitado começa a devolver erro
para requisições válidas. O lock pessimista faz as concorrentes esperarem na fila do próprio
Postgres, sem trabalho desperdiçado. O `UPDATE ... WHERE version = $anterior` continua lá como
segunda defesa, não como estratégia.

**Espera limitada.** `SET LOCAL lock_timeout = '2s'`: ninguém espera o lock indefinidamente. Se
estourar (`55P03`), ou em deadlock (`40P01`), serialização (`40001`) ou falha de conexão, o caso de
uso inteiro é refeito por `retryTransient`: até 3 execuções, com espera
`random() * 50 ms * 2^tentativa` (backoff exponencial com jitter, para que instâncias em disputa
não tentem juntas). Refazer é seguro porque cada execução é uma transação nova e a anterior já foi
desfeita. Esgotadas as tentativas → `503 SERVICE_UNAVAILABLE` com `Retry-After: 1`.

**Pior caso de espera.** O `lock_timeout` limita _cada_ espera por lock, não a transação inteira,
e vale também para a espera num índice único (um `INSERT` que colide com uma linha ainda não
commitada espera o outro terminar e é cancelado com `lock timeout` depois de 2 s — conferido no
Postgres 17). Numa tentativa, há até quatro esperas: o `FOR UPDATE` da wallet e a espera no índice
único durante o `INSERT`; se o `INSERT` violar a unicidade, a re-execução repete as duas. Isso dá
até 4 × 2 s = 8 s por tentativa e, com 3 tentativas e o backoff (até 100 ms + 200 ms), um limite de
**≈ 24,3 s** antes do `503`, mais uma eventual espera por conexão do pool (abaixo), que fica fora
dessa conta. É um limite teórico: exige que toda espera estoure o tempo máximo; nos testes de
concorrência, 200 requisições simultâneas (20 por wallet) terminam todas em cerca de 1 s.

**Timeouts de sessão.** Toda conexão do pool abre com `statement_timeout = 5s` e
`idle_in_transaction_session_timeout = 10s`. Se um processo vivo travar no meio de uma transação
(por exemplo, esperando algo externo com a transação aberta), o Postgres a cancela e libera o lock
da wallet em vez de segurá-lo para sempre. Quando o processo morre (`SIGKILL`), o Postgres já
derruba a conexão e desfaz a transação; os timeouts cobrem o caso do processo que continua vivo.
Um comando cancelado por `statement_timeout` (SQLSTATE `57014`) é tratado como falha transitória e
refeito por `retryTransient`.

**Fila de entrada do SQS.** O `VisibilityTimeout` da fila de entrada é de 60 s, acima do pior caso
de ≈ 24,3 s do processamento, para que a mensagem não volte a ficar visível enquanto a primeira
execução ainda roda. O prazo conta a partir do recebimento, então uma mensagem que espera atrás de
outras do mesmo grupo no mesmo lote pode ultrapassá-lo. Isso é seguro (inbox, lock da wallet e
ordem FIFO) e custa só um replay. A `maxReceiveCount` da redrive policy é 10. Os nomes das filas são
configuráveis por `SQS_TRANSACTIONS_QUEUE`, `SQS_TRANSACTIONS_DLQ` e `SQS_EVENTS_QUEUE`. O motivo
do 10 e o que as filas de produção precisam repetir estão na seção 12.

**Pool de conexões.** Cada instância usa o pool padrão do MikroORM (knex: no máximo 10 conexões).
Requisições além disso esperam por uma conexão livre antes de abrir a transação, então essa espera
não consome o `lock_timeout`. Os testes de concorrência disparam 200 requisições simultâneas
contra uma instância com esse pool, sem erro. Com N instâncias, N × 10 conexões precisam caber no
`max_connections` do Postgres (100 por padrão).

O worker de referências pendentes processa no máximo 2 wallets ao mesmo tempo (cada item é uma
transação curta). Somado às 8 transações do consumer, isso ocupa o pool inteiro: o limite serve
para reduzir a disputa, não para garantir conexão livre. Quem chega com o pool cheio (HTTP,
publisher da outbox, worker) espera uma conexão antes de abrir a transação, sem segurar lock, e
nenhuma transação que já segura o lock de uma wallet precisa de uma segunda conexão, então a
espera nunca vira impasse.

**Pool depois de um timeout.** Um `lock_timeout` (`55P03`) cancela só o comando: a transação é
desfeita e a conexão volta utilizável para o pool (o teste de integração que segura o lock da
wallet em outra conexão confere que a re-execução seguinte grava normalmente). Um
`idle_in_transaction_session_timeout` (`25P03`) encerra a sessão no servidor: o pool descarta a
conexão quebrada e abre outra na próxima requisição (conferido à mão com um pool de uma única
conexão: a consulta seguinte roda num novo processo do Postgres). Isso importa porque o consumer
SQS é um laço de vida longa: falhas transitórias repetidas não podem esgotar o pool. O teste do
consumer em que as duas primeiras entregas falham com `lock_timeout` simulado e a terceira grava
mostra o laço seguindo em frente depois das falhas; a recuperação do pool fica com a verificação
manual descrita acima.

**Como é testado** (`test/concurrency/wagering-races.test.ts`, requisições HTTP reais disparadas
juntas com `Promise.all` contra Postgres real): saldo `100.00` com duas apostas de `80.00` em 10
rodadas; a mesma aposta 50 vezes em paralelo; a mesma chave em duas wallets; `REFUND` e `ROLLBACK`
da mesma `BET` ao mesmo tempo; 10 wallets com 20 apostas cada. Além das respostas HTTP, os testes
conferem no banco o saldo, o ledger, as transações gravadas e os eventos na outbox. Há ainda um
teste de que o lock é por wallet e não global: outra conexão segura o `FOR UPDATE` da wallet A e,
enquanto isso, uma aposta na wallet B recebe `201` em menos de 1 s. Para validar que os testes
detectam a falta do lock, o `FOR UPDATE` foi removido manualmente numa verificação pontual: quatro
dos seis testes falharam (o da mesma chave em duas wallets depende só da `UNIQUE`, e o do lock por
wallet não depende do lock da aplicação). Depois de cada teste que grava pela aplicação, um helper
confere em SQL que o saldo de cada wallet é igual à soma do seu ledger, que as versões do ledger
são contínuas e que a cadeia de saldos fecha (o `balance_before` de cada lançamento é o
`balance_after` do anterior, e o primeiro parte de zero). A suíte de schema fica de fora: ela grava
linhas soltas de propósito para provocar cada constraint.

## 10. Idempotência e replay

- **Consultada depois do lock.** A busca por `(provider_id, idempotency_key)` acontece com a wallet
  já travada: duplicatas concorrentes da mesma wallet esperam na fila do lock e, quando entram, a
  original já foi commitada e é encontrada. Mesmo payload (`payloadHash`) → replay; payload
  diferente → `409 IDEMPOTENCY_CONFLICT`. O mesmo `externalTransactionId` com outra chave também
  é `409`.
- **Garantia final no schema.** `wager_tx_provider_idem_uq`, `wager_tx_provider_external_uq` e
  `wager_tx_single_reversal_uq` são `UNIQUE`. O lock não cobre a mesma chave enviada para wallets
  diferentes (cada uma trava a sua): nesse caso o segundo `INSERT` espera o primeiro commitar e
  recebe a violação de unicidade. A transação é desfeita e o caso de uso roda **mais uma vez**; na
  segunda execução a consulta encontra a original e a resposta é a mesma de uma requisição
  sequencial (replay ou `409`). Uma repetição basta, porque depois do commit da original a
  consulta sempre a enxerga.
- **Replay devolve o resultado original.** Transações terminais (`PROCESSED`, `REJECTED`) nunca
  mudam: o replay devolve o mesmo status, o mesmo `failureCode` e o `balance` gravado na época,
  mesmo que o saldo tenha mudado depois. A rejeição por moeda divergente não tem saldo observado,
  porque o saldo é de outra moeda: `balance` é `null` na resposta original, no replay e nos `GET`s.
  Uma transação `PENDING_REFERENCE` devolve o seu estado atual: `202` enquanto pendente e, depois
  que o worker a resolve (seção 8), o resultado final (`201` ou `422`, com o saldo gravado na
  resolução). O replay nunca tenta resolver a referência na hora.
- **Falha no COMMIT.** Se a conexão cai durante o `COMMIT`, o cliente não sabe se a transação foi
  gravada. Se não foi, o reenvio processa normalmente; se foi, o reenvio encontra a original e
  devolve um replay. Em qualquer caso existe exatamente um efeito no saldo e no ledger.

## 11. Outbox e publicação de eventos

**Gravação.** Os eventos entram na tabela `outbox_messages` na mesma transação SQL do saldo, do
ledger e da transação de aposta. Se a transação faz rollback, o evento não existe; se faz commit,
ele fica gravado mesmo que o processo morra no instante seguinte. Nada é enviado à fila de dentro
da transação: o envio só acontece depois, a partir do que já está confirmado no banco.

**Publisher.** Cada instância roda um loop (`OutboxPublisherWorker`) que chama
`PublishOutboxUseCase.runOnce()`; quando o ciclo publica algo sem falha, o próximo começa na hora,
senão espera `OUTBOX_POLL_INTERVAL_MS` (250 ms). Um ciclo:
1. **Reserva** (transação curta e própria):
   `SELECT ... FROM outbox_messages o WHERE published_at IS NULL AND next_attempt_at <= $agora
   AND NOT EXISTS (versão menor da mesma wallet ainda não publicada) ORDER BY next_attempt_at, id
   LIMIT $lote FOR UPDATE SKIP LOCKED` e, na mesma transação, `next_attempt_at = $agora + lease`
   (30 s) para as linhas escolhidas; `COMMIT`. O `NOT EXISTS` é a cabeça por wallet da seção
   "Ordem estrita por wallet".
2. **Publica** fora de qualquer transação, em `wagering-events.fifo`, com
   `MessageGroupId = aggregateId` (a wallet) e `MessageDeduplicationId = eventId`; o corpo é o
   envelope JSON gravado no `payload`. O lote inteiro é enviado em chamadas de até 10
   (`SendMessageBatch`), com até `OUTBOX_PUBLISH_CONCURRENCY` chamadas simultâneas: sobrepõe a
   latência do envio sem disparar todo o lote de uma vez. A ordem por wallet não depende da
   concorrência — o claim garante no máximo um evento de saldo por wallet por ciclo (cabeça por
   wallet), e os eventos sem versão seguem melhor-esforço (seção "Ordem estrita por wallet").
3. **Registra** o resultado por entrada, em escritas curtas e separadas: sucesso →
   `UPDATE ... SET published_at = $agora WHERE id = $id AND published_at IS NULL`; falha →
   `attempts + 1`, `next_attempt_at` com backoff exponencial e jitter (1 s, 2 s, 4 s ... até 5 min)
   e `last_error` (até 500 caracteres). Uma entrada falha não impede as demais do lote; se a chamada
   em lote nem chega a acontecer (rede), o lote inteiro é reagendado. A ordem por wallet continua
   garantida pelo claim (cabeça por wallet), não por este código.
   As escritas só valem enquanto a reserva ainda é de quem escreve
   (`next_attempt_at <= fim do lease reservado`): se o lease venceu e outra instância reservou a
   linha de novo, uma falha atrasada não sobrescreve o lease nem o `attempts` dela.

Publicou algo sem falha → o próximo ciclo começa na hora (ainda há fila), **inclusive com lote
incompleto** — é o que destrava a cauda depois do tráfego, quando sobram poucas cabeças de wallets
quentes e o claim devolve menos que o lote. Ciclo ocioso (nada publicado) ou com falha espera o
intervalo normal, para não varrer a outbox sem pausa enquanto o SQS está fora. Erro no ciclo (banco
fora, por exemplo) é logado, sem o conteúdo dos eventos, e o loop continua. No shutdown, o worker
para antes de o pool do Postgres e o cliente SQS serem fechados e espera o ciclo em andamento
terminar.

**Por que `SKIP LOCKED` + lease, sem coluna nova.** `SKIP LOCKED` faz duas instâncias reservando
ao mesmo tempo pegarem linhas diferentes, sem uma esperar a outra. Empurrar o `next_attempt_at`
para o futuro no mesmo commit tira o lote da consulta das demais depois que o lock é solto; ele
funciona como um "aluguel" com prazo. Se a instância morrer com o lote reservado, ninguém precisa
limpar nada: quando o prazo vence, as linhas voltam a satisfazer `next_attempt_at <= agora` e
outra instância as pega. A alternativa — uma coluna `claimed_by`/`claimed_at` — precisaria da mesma
lógica de expiração e de uma migration, sem ganho. A publicação fica fora da transação para não
segurar locks e conexões do banco durante uma chamada de rede.

**Garantia: at-least-once.** Um evento nunca é perdido (só é marcado depois que o SQS confirmou o
envio) e nunca sai antes do commit (o publisher só enxerga linhas confirmadas). Ele pode sair mais
de uma vez quando o processo morre entre publicar e marcar, ou quando um envio demora mais que o
lease e outra instância reserva a mesma linha. Duas defesas: o SQS FIFO descarta reenvios com o
mesmo `MessageDeduplicationId` dentro da janela de 5 minutos; fora dela, o consumidor deduplica
pelo `eventId`. A marcação com `published_at IS NULL` torna inofensiva a corrida de dois
publishers marcando a mesma linha.

**Cenário de crash exigido pelo enunciado, passo a passo:**
1. a transação de aposta faz `COMMIT`: saldo, ledger e evento gravados juntos;
2. a instância A reserva o lote (o evento ganha `next_attempt_at = agora + 30 s`) e morre antes de
   publicar — ou antes de marcar `published_at`;
3. durante o lease, as outras instâncias não pegam o evento (não está vencido); vencido o prazo,
   a instância B o reserva no seu ciclo normal;
4. B publica e marca `published_at`;
5. se A tinha chegado a publicar, o evento sai duas vezes com o mesmo `eventId`: o SQS descarta a
   segunda dentro da janela de deduplicação e, fora dela, o consumidor a ignora pelo `eventId`.

Os testes de integração (`test/integration/outbox-publisher.test.ts`, Postgres e LocalStack reais)
cobrem: publicação única e marcação; segunda execução não republica; falha no envio
(`attempts = 1`, nova tentativa no futuro, `last_error`, demais wallets publicadas); uma entrada
falha sem bloquear o resto do lote e é publicada no ciclo seguinte; falha atrasada que não
sobrescreve a reserva de outra instância; dois
publishers concorrentes sobre 100 eventos (todos recebidos, cada linha reservada por um único
publisher, nenhuma pendente); reserva abandonada não é pega antes do lease e é publicada depois; a
cabeça por wallet (a v2 não é reivindicada antes de a v1 publicar) e a ordem estrita por
`wallet_version` mesmo com `occurred_at` fora de ordem; o envio em lotes de até 10 (unit);
e o worker ligado publicando os eventos de uma wallet nova de ponta a ponta. Os testes controlam o
relógio (`Clock` injetado) para avançar além do lease sem esperar.

**Ordem estrita por wallet.** A coluna `wallet_version` da outbox (preenchida só em
`WalletBalanceChanged`, com a versão do lançamento) e o filtro de "cabeça" no `claimDue` garantem
que o evento de saldo de uma wallet só sai quando nenhuma versão anterior daquela wallet ainda está
não publicada: um `NOT EXISTS` de versão menor pendente, somado ao `FOR UPDATE SKIP LOCKED`, faz
nenhum publisher reivindicar a v2 enquanto a v1 está em voo — mesmo travada por outra instância. A
ordem deixa de depender de `occurred_at` (relógio de parede, sujeito a skew entre instâncias) e do
acaso da divisão entre publishers: ela é garantida no banco, e o `MessageGroupId` por wallet a
preserva dentro da fila FIFO. Eventos de transação (`wallet_version NULL`) não têm versão e seguem
melhor-esforço, como antes; o consumidor que precisa de ordem de saldo usa o `walletVersion` do
payload como referência. O índice parcial `outbox_balance_unpublished_idx` serve o filtro de cabeça.

**Retenção.** Eventos já publicados ficam na tabela até o `OutboxRetentionWorker` apagá-los: a cada
`OUTBOX_RETENTION_POLL_INTERVAL_MS` (60 s), um ciclo calcula o corte (`agora - maxAgeMs`, 7 dias por
padrão) e apaga até `OUTBOX_RETENTION_BATCH_SIZE` linhas (1000) com `published_at < corte`, na ordem
de publicação, com `DELETE ... WHERE id IN (SELECT ... LIMIT ...)` numa transação curta. A deleção
nunca toca eventos ainda não publicados (o filtro é `published_at IS NOT NULL`), então não interfere
na entrega nem no retry; e, como o publisher só enxerga `published_at IS NULL`, apagar uma linha
publicada é inofensivo. Várias instâncias podem rodar juntas: cada `DELETE` é uma transação própria e
uma linha apagada por uma não volta para as outras. O índice parcial `outbox_published_idx` serve a
busca por `published_at`; o lote cheio encadeia o próximo ciclo na hora.

## 12. Consumo por SQS

`WagerTransactionsConsumer` lê a fila FIFO `wager-transactions.fifo` e chama o mesmo
`ProcessWagerTransactionUseCase` do HTTP: o consumer é só outro adaptador de transporte. Cada
mensagem é um envelope `{ messageId, type, occurredAt, data }`, validado por schema; `data` tem os
mesmos campos do corpo HTTP mais a `idempotencyKey`. O produtor usa a wallet como
`MessageGroupId`.

**Recebimento.** Cada instância roda `SQS_CONSUMER_LOOPS` laços independentes (2), cada um com
long polling (`SQS_WAIT_TIME_SECONDS`, 10 s) e lotes de até `SQS_RECEIVE_BATCH_SIZE` mensagens
(4). Dois laços fazem uma mensagem lenta (esperando lock) não parar as outras wallets da instância.
O SQS FIFO nunca entrega o mesmo grupo a dois receptores ao mesmo tempo, então a ordem por wallet
se mantém entre laços e entre instâncias.

**Classificação das falhas.**

| Classe            | Exemplos                                                                                                              | O que o consumer faz                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Resultado gravado | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay                                                                  | ack em lote (`DeleteMessageBatch`) depois do `COMMIT`                          |
| Permanente        | `INVALID_PAYLOAD` (JSON ou schema), `INVALID_MONEY`, `REFERENCE_REQUIRED`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_CONFLICT` | DLQ explícita na primeira entrega                                              |
| Transitório       | `TransientFailureError`: `lock_timeout`, deadlock, conexão, `statement_timeout`, depois dos 3 retries do caso de uso  | volta para a fila com backoff; o redrive leva para a DLQ depois de 10 entregas |
| Inesperado        | qualquer outro erro (bug, `InvariantViolationError`)                                                                  | backoff nas 2 primeiras entregas; na 3ª, DLQ explícita com `INTERNAL_ERROR`    |

Uma rejeição de negócio (`INSUFFICIENT_FUNDS`, por exemplo) não é falha da mensagem: a transação
`REJECTED` é gravada e a mensagem recebe ack. O permanente vai direto para a DLQ porque reprocessar
nunca muda o resultado; esperar o redrive só seguraria a wallet. O inesperado tem limite próprio
pelo mesmo motivo: com o backoff do transitório, um payload que dispara um bug travaria o grupo da
wallet por até ~13 min; com o corte na 3ª entrega, por poucos segundos (1 s + 2 s de backoff).
Nenhum dos casos põe dinheiro em risco: o saldo é conferido sob lock na hora de processar, então
atraso nunca muda o resultado.

**DLQ explícita.** `SendMessage` na DLQ com o mesmo corpo, o `MessageGroupId` original,
`MessageDeduplicationId` = `MessageId` do SQS e os atributos `failureCode` e `failedAt`; só depois
o ack (em lote) na fila principal. Se o processo morrer entre os dois, a mensagem volta, falha de
novo e o reenvio para a DLQ é descartado pela deduplicação do SQS.

**Backoff.** `ChangeMessageVisibility` com `min(1 s × 2^(entrega − 1), 300 s)` e _equal jitter_
(metade do atraso fixa, metade sorteada), no mínimo 1 s. O número da entrega é o
`ApproximateReceiveCount` do próprio SQS: nenhum contador fica em memória nem no banco, e
qualquer instância que receba a mensagem continua a contagem.

**Inbox × idempotência.** A tabela `inbox_messages` (`UNIQUE (consumer_name, message_id)`, com o
hash de `data`) é gravada na mesma transação do saldo, do ledger e da outbox, depois do lock da
wallet. Ela registra a _entrega_; a _operação de negócio_ continua identificada por
`(provider_id, idempotency_key)`. Uma entrega repetida (mesmo `messageId`, mesmo corpo) segue até
a consulta de idempotência e vira replay; o mesmo `messageId` com outro `data` é
`IDEMPOTENCY_CONFLICT` e vai para a DLQ. A mesma aposta enviada por HTTP e depois por SQS (mesma
chave) gera uma única transação: a mensagem cai no replay e recebe ack.

**Ack em lote depois do `COMMIT`.** As mensagens resolvidas num lote de recebimento são apagadas
juntas, no fim do lote, com `DeleteMessageBatch` (até o limite de 10 do SQS por chamada): o ack
individual por mensagem vira uma chamada por lote, reduzindo chamadas ao SQS sob carga. Uma
mensagem só entra no lote de ack depois que o caso de uso resolveu, nunca antes do `COMMIT`. Se a
instância morre depois do `COMMIT` e antes do ack em lote, a mensagem reaparece depois do visibility
timeout, outra instância a recebe, a inbox e a chave de idempotência fazem dela um replay e ela
recebe ack: um lançamento no ledger, uma linha na inbox e nenhum evento duplicado na outbox. Se
morre antes do `COMMIT`, o Postgres desfaz a transação e a mensagem é processada do zero na próxima
entrega. Uma falha parcial do `DeleteMessageBatch` só é logada: as entradas não apagadas reaparecem
depois do visibility timeout e são tratadas pela inbox.

**Ordem FIFO.** No lote, os grupos (wallets) rodam em paralelo e as mensagens de um grupo, em
sequência. A primeira mensagem do grupo que não sai da fila (transitório, inesperado antes da 3ª
entrega) encerra o grupo naquele lote: as seguintes recebem `ChangeMessageVisibility` com o mesmo
atraso, sem serem processadas, e voltam atrás dela na ordem da fila. Continuar o laço depois de
uma falha deixaria uma aposta ser ultrapassada pela seguinte da mesma wallet: com saldo `100.00`,
uma `BET 80` que falha transitoriamente seguida de uma `BET 30` terminaria com a de 30 aceita e a
de 80 rejeitada, o contrário da ordem enviada. O teste de integração reproduz exatamente esse
caso e confere que a de 80 é `PROCESSED`, a de 30 é `REJECTED INSUFFICIENT_FUNDS` e a de 80 foi
gravada antes. Quando a falha é do próprio SQS (ack ou troca de visibilidade), o atraso não é
conhecido: as seguintes não são processadas e voltam com o próprio visibility timeout. Enquanto
uma mensagem do grupo está em voo, o SQS segura o grupo inteiro; é o comportamento desejado.

**Desligamento (`SIGTERM`).** No `beforeApplicationShutdown`, antes de o Nest fechar o HTTP, o pool
do Postgres e o cliente SQS:
1. o consumer para de iniciar novos long polls. O que está em andamento não é abortado e termina
   em até `SQS_WAIT_TIME_SECONDS`: o SQS pode atender um `ReceiveMessage` cujo cliente já
   desistiu, e a mensagem "recebida" por ninguém ficaria escondida pelo visibility timeout (60 s
   de atraso para o grupo da wallet), com uma entrega a mais no contador;
2. mensagens recebidas durante o desligamento, ou atrás de uma em andamento no mesmo grupo, voltam
   para a fila com `ChangeMessageVisibility` = 0 assim que o grupo chega nelas: antes disso o SQS
   não as entregaria a ninguém, porque a mensagem em andamento segura o grupo;
3. as mensagens em andamento terminam e recebem ack, com prazo de `SHUTDOWN_TIMEOUT_MS` (20 s).
   Estourado o prazo, o shutdown segue: a transação aberta é desfeita quando o pool fecha e a
   mensagem reaparece depois do visibility timeout.

Como o desligamento espera o long poll em andamento, `SHUTDOWN_TIMEOUT_MS` precisa cobrir
`SQS_WAIT_TIME_SECONDS` + 5 s (a folga do timeout HTTP do long poll); a configuração recusa um
valor menor na inicialização.

O `main.ts` trata o `SIGTERM`/`SIGINT` por conta própria: chama `app.close()` (que roda os mesmos
hooks de desligamento do Nest) e sai com código 0. O `enableShutdownHooks` do Nest não é usado:
no padrão ele reenvia o sinal ao terminar, e o processo sairia com 143 mesmo num desligamento
limpo (um orquestrador leria isso como falha); a opção `useProcessExit` dele sai com 0, mas não
arma o timer de saída forçada descrito a seguir, então um só handler faz as duas coisas. Um
segundo sinal durante o desligamento é ignorado (não inicia outro `close`). O mesmo handler arma um timer de saída forçada de `SHUTDOWN_TIMEOUT_MS` + 5 s
(`process.exit(1)`), para que um hook travado nunca deixe o processo pendurado. Com os valores
padrão, o total fica abaixo dos 30 s que um orquestrador costuma esperar antes do `SIGKILL`; em
geral, o prazo do orquestrador precisa ser maior que `SHUTDOWN_TIMEOUT_MS` + 5 s. Num `SIGKILL`
nada disso roda: o Postgres desfaz a transação ao perder a conexão e as mensagens voltam depois do
visibility timeout, sem efeito duplicado por causa da inbox e da idempotência.

**Paralelismo × pool.** Cada mensagem em processamento ocupa uma conexão durante a sua transação.
Com os valores padrão, uma instância processa no máximo 2 laços × 4 mensagens = 8 transações do
consumer ao mesmo tempo, abaixo do pool de 10 conexões, sobrando conexões para o HTTP e para o
publisher da outbox. Aumentar `SQS_CONSUMER_LOOPS` ou `SQS_RECEIVE_BATCH_SIZE` sem aumentar o pool
só faz as requisições esperarem por conexão (sem erro, mas com mais latência).

**Configuração das filas.** O script `docker/localstack/ready.d/01-queues.sh` cria as três filas no
start do LocalStack com nomes fixos (`wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
`wagering-events.fifo`). As variáveis `SQS_*_QUEUE` só apontam a aplicação para outras filas (os
testes de integração criam filas próprias, com nomes aleatórios); mudá-las não muda o que o script
cria. A aplicação não cria nem confere os atributos das filas: em produção elas vêm da
infraestrutura e precisam repetir a configuração local — FIFO, deduplicação explícita
(`ContentBasedDeduplication=false`), `VisibilityTimeout` de 60 s (acima do pior caso de ≈ 24,3 s
do processamento, seção 9) e redrive para a DLQ FIFO com `maxReceiveCount` 10. As filas de
transações e de eventos usam o **FIFO de alta vazão** (`FifoThroughputLimit=perMessageQueueId` com
`DeduplicationScope=messageGroup`): o teto passa de ~300 msg/s (3.000/s em lote) para até 9.000/s
em lote, sem perder a ordem por grupo de mensagem (a wallet). A deduplicação por grupo é segura
porque toda mensagem leva um `MessageDeduplicationId` único (`messageId` na entrada, `eventId` nos
eventos); a DLQ permanece FIFO padrão. O `maxReceiveCount` 10 vem do backoff:
somando as esperas (1 + 2 + … + 256 + 300 s, até ~13 min, menos com o jitter) e o tempo de cada
tentativa, uma mensagem saudável aguenta uma falha transitória contínua (banco fora, por exemplo)
da ordem de 10 min antes de ir para a DLQ; com 5, cerca de 30 s de falha já bastariam.

**Como é testado** (`test/integration/sqs-consumer.test.ts`, Postgres e LocalStack reais, filas
próprias da suíte com visibility de 2 s e `maxReceiveCount` 3). Falhas são simuladas trocando um
provider da aplicação (repositório de wallet que lança ou demora, cliente SQS que engole o
`DeleteMessageBatch`), nunca com mocks de banco ou fila. Casos: mensagem válida processada e
confirmada; várias mensagens do mesmo lote apagadas num único `DeleteMessageBatch`; reentrega com o
mesmo `messageId` (um débito, duas confirmações); mesmo `messageId` com outro corpo
na DLQ como `IDEMPOTENCY_CONFLICT`; JSON quebrado, valor numérico e wallet inexistente na DLQ na
primeira entrega; a mesma aposta por HTTP e por SQS; a ordem FIFO descrita acima; transitório que
se resolve na 3ª entrega, sem DLQ; erro inesperado na DLQ como `INTERNAL_ERROR`, recebido
exatamente 3 vezes; instância que morre entre `COMMIT` e ack (outra instância confirma, sem segundo
efeito); shutdown no meio de uma mensagem (ela termina e é confirmada; a não iniciada do mesmo
grupo volta visível na hora e é processada por uma instância nova); e mensagem recebida pelo long
poll durante o desligamento (volta visível sem ser processada e uma instância nova a processa).

## 13. Múltiplas instâncias

Nenhum estado que importa para a correção fica na memória de um processo: saldo, idempotência,
inbox, pendências e outbox estão no Postgres, e a fila é o SQS. Por isso N instâncias iguais
dividem o trabalho sem coordenação extra:

| Peça                 | O que impede duas instâncias de pisarem uma na outra                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| HTTP e consumer      | lock da linha da wallet (`SELECT … FOR UPDATE`) e `UNIQUE` de idempotência e de inbox |
| Consumer             | o SQS FIFO não entrega o mesmo grupo (wallet) a dois receptores ao mesmo tempo        |
| Publisher da outbox  | claim com `FOR UPDATE SKIP LOCKED` + lease; reenvio deduplicado pelo `eventId`        |
| Worker de pendências | o mesmo claim com lease, e o lock da wallet na reavaliação                            |

**Docker Compose.** O profile `app` sobe `app-1`, `app-2` e `app-3` (portas 3001–3003) a partir da
mesma imagem, depois do serviço `migrate`. São serviços nomeados, e não `replicas`, para que dê para
derrubar uma instância específica (`docker compose kill -s SIGKILL app-2`). Pool: 3 × 10 conexões
cabem no `max_connections` (100) do Postgres.

**Como é testado** (`test/multi-instance/multi-instance.test.ts`, `bun run test:multi-instance`,
último passo da CI). Três processos reais (`bun src/main.ts`, sem Docker, para rodar igual na CI)
contra o Postgres e o LocalStack do Compose, com filas próprias (visibility 5 s, `maxReceiveCount`
10), leases curtos (3 s na outbox e nas pendências) e consumer, publisher e worker ligados em
todos. O roteiro (`test/multi-instance/scenario.ts`) é
determinístico: 10 wallets, 13 rodadas por wallet (`BET`+`WIN`, `BET`+`LOSS`, `REFUND` antes da
`BET`, `BET`+`ROLLBACK`, `BET`+`WIN`+`ROLLBACK` do `WIN`), uma reentrega do mesmo `messageId` e a
mesma operação em duas mensagens por wallet, e uma mensagem venenosa — 307 mensagens enviadas,
296 `messageId` válidos distintos. Em paralelo, a mesma `BET` vai 50 vezes por HTTP, espalhada
pelas três instâncias.

Durante o processamento, quando ⅓ das mensagens já está na inbox, a instância 2 leva `SIGKILL` e é
reiniciada; com ⅔, a instância 3 leva `SIGTERM`, tem de sair com código 0 em menos de 30 s, e é
reiniciada. O teste espera a fila principal esvaziar, nenhuma `PENDING_REFERENCE` e nenhuma outbox
pendente, e confere: invariante do ledger (com a cadeia de saldos); saldo de cada wallet igual ao
calculado pelo roteiro com `Money`; nenhuma chave de idempotência repetida e todas as operações
`PROCESSED`; uma linha de inbox por `messageId` válido; a DLQ com exatamente a mensagem venenosa; a
`BET` repetida com um único lançamento; e todo evento da outbox presente na fila de eventos (o
publisher roda nos processos mortos, então pode cobrir "morreu entre publicar e marcar").

O `SIGKILL` e o `SIGTERM` são disparados pela contagem global da inbox, não por uma mensagem
específica: o teste não garante qual mensagem estava em voo no momento. As provas determinísticas
desses casos são os testes de integração do consumer (morte depois do `COMMIT` e antes do ack;
desligamento com mensagem em andamento), descritos na seção 12.

**Números medidos** (máquina de desenvolvimento, 8 GB de RAM, três execuções seguidas): os 296
`messageId` + 50 requisições HTTP drenados em 9,1 s a 9,5 s (32,5 a 31,2 mensagens/s); o `SIGTERM`
terminou em 0,1 s a 0,3 s. O tempo é dominado pela recuperação das falhas, não pelo processamento:
a mensagem em voo na instância morta só volta depois do visibility timeout (5 s no teste, segurando
o grupo da wallet), e uma pendência reservada pelo worker da instância morta só volta quando o
lease vence (3 s no teste; com o padrão de 30 s, uma execução levou 33 s). Não é um teste de
carga: a vazão sem falhas está na seção 16.

**Worker de pendências no desligamento.** O worker termina o lote reservado inteiro (até 50 itens,
cada um uma transação curta) antes de sair. Parar no meio deixaria o resto reservado até o lease
vencer (30 s de atraso para essas pendências, com o padrão), e o lote inteiro cabe com folga no prazo: no teste,
o `SIGTERM` termina em menos de 1 s.

## 14. Autenticação

A autenticação está implementada e fica **desligada por padrão** (`AUTH_ENABLED=false`), para que a
demonstração e os testes rodem sem token. Ligada, o `AuthGuard` global valida um bearer token OIDC
emitido pelo Keycloak (client credentials) e os controllers conferem o provedor e os escopos.
- cada provedor é um client no Keycloak e obtém um token via client credentials;
- o `AuthGuard` valida a assinatura contra o JWKS do IdP (com cache e nova leitura quando aparece
  um `kid` desconhecido), `iss`, `aud` e expiração (tolerância de relógio de 30 s); token ausente
  ou inválido → `401 UNAUTHORIZED`;
- o `providerId` vem da claim `azp` (o client id) e os escopos da claim `scope`; o guard grava os
  dois em `request.auth` e exige, por rota, os escopos declarados com `@RequireScope(...)` — falta
  de escopo → `403 FORBIDDEN`;
- o `providerId` do token é comparado com o do corpo/caminho: diferente no submit → `403
  FORBIDDEN`; `GET` de transação de outro provedor → `404`, sem revelar que ela existe.

Escopos: `wagers:submit` (submeter), `wagers:read` (consultar transações) e `wallets:manage`
(criar wallet, ler o ledger e reconciliar — operações de back-office). Os endpoints de health
(`/health/live`, `/health/ready`) e `/metrics` são marcados com `@Public()` e continuam abertos.
Mensagens da fila são tratadas como canal interno confiável: o `providerId` da mensagem passa pelas
mesmas validações de domínio, sem bearer token (quem escreve na fila é autenticado pelo IAM da AWS).

### Configuração

| Variável        | Papel                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| `AUTH_ENABLED`  | liga/desliga a exigência de token (padrão `false`)                     |
| `OIDC_ISSUER`   | `iss` esperado no token (ex.: `http://localhost:8080/realms/wagering`) |
| `OIDC_AUDIENCE` | `aud` esperado — o público da API (ex.: `wagering-app`)                |
| `OIDC_JWKS_URI` | JWKS do IdP para validar a assinatura                                  |

Com `AUTH_ENABLED=true`, as três `OIDC_*` são obrigatórias e validadas no boot.

### Infraestrutura e testes

- Keycloak num profile `auth` do Compose, com realm importado (`docker/keycloak/realm.json`): um
  client por provedor (`provider-a`, `provider-b`) e um `backoffice`, todos `client_credentials`,
  com `azp` = client id, `scope` = escopos do client e `aud = wagering-app` (mapper de audience).
  Heap limitado; não sobe junto com as três instâncias e o teste de carga numa máquina de 8 GB.
- Testes unitários do verifier e do guard com um par de chaves gerado no teste e JWKS local (token
  válido, expirado, `aud` errado, assinatura errada, sem `azp`, escopo ausente); integração HTTP
  com JWKS local (`auth-http.test.ts`) e contra o Keycloak real no profile `auth`
  (`auth-keycloak.test.ts`, ativado com `KEYCLOAK_AUTH_TEST=true`).

**Trade-offs.**

| Ponto                                                 | Decisão                                                                                                                                            | Motivo                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Validação do token                                    | local, por JWKS em cache; sem chamar o IdP a cada requisição                                                                                       | não coloca o IdP no caminho crítico nem soma latência                                                    |
| Revogação                                             | tokens de vida curta (minutos); sem lista de revogação                                                                                             | revogar de verdade exigiria introspecção a cada chamada; para APIs servidor a servidor o TTL curto basta |
| Fila                                                  | canal interno confiável: quem escreve na fila é autenticado pelo IAM da AWS, e o `providerId` da mensagem passa pelas mesmas validações de domínio | não há bearer token em mensagem SQS                                                                      |
| Mensagem cujo `providerId` não é o de quem a produziu | não é verificada: é o preço de tratar a fila como canal confiável                                                                                  | restringir exigiria um atributo assinado na mensagem; quem controla a fila já controla o sistema         |

## 15. Observabilidade e health checks

- Logs JSON (pino) com uma linha por requisição. O header `x-correlation-id` é aceito (se for um
  valor curto e seguro) ou gerado como UUIDv7, devolvido na resposta e incluído como
  `correlationId` em todas as linhas de log da requisição. `authorization`, cookies e o corpo da
  requisição são omitidos dos logs.
- Cada transação de aposta processada gera **uma linha de log `info`**, escrita por quem chamou o
  caso de uso: o controller HTTP (`wager transaction processed`) ou o consumer SQS
  (`wager message processed`). Campos: `correlationId`, `transactionId`, `walletId`, `providerId`,
  `kind`, `status`, `failureCode` (só em `REJECTED`), `idempotentReplay` e `durationMs`; no SQS,
  também `messageId` (id do envelope, igual ao `correlationId`), `sqsMessageId` e `receiveCount`. No
  HTTP, `walletId` e `providerId` são ligados ao logger da requisição assim que o corpo é validado,
  (`assignResponse`), então aparecem também na linha de erro do filtro global e na linha de
  conclusão da requisição. Antes dessa validação (respostas `400`) só o `correlationId` existe.
- Falhas carregam os ids disponíveis e o erro sempre reduzido por `safeError` (nome, SQLSTATE,
  constraint e tabela; sem a query nem a stack de erros do driver). O publisher da outbox loga cada
  mensagem que falhou com `eventId`, `eventType`, `aggregateId`, `attempts` e o erro; o worker de
  referências pendentes loga cada item avaliado com `transactionId`, `walletId`, `providerId`,
  `attempts` e `outcome` (`resolved`, `rejected` ou `rescheduled`).
- **O que nunca vai para o log:** valores monetários (`money`, saldos), o corpo da requisição ou
  da mensagem, o conteúdo dos eventos da outbox, `authorization` e cookies. Há testes de integração
  que afirmam a ausência do valor e do corpo na saída real do pino, para HTTP e SQS.
- `GET /metrics` (público, como o health): métricas Prometheus desta instância, em texto. Usam
  `prom-client` com registry próprio, mais as métricas padrão do processo. Os casos de uso e o
  consumer dependem só da porta `Metrics` (`application/ports/metrics.ts`); o adaptador
  `PrometheusMetrics` fica em `infrastructure/metrics/`. Rótulos vêm sempre de conjuntos fechados
  (canal, tipo, status, código de erro, SQLSTATE): nunca `walletId`, `transactionId` nem provedor.

  | Métrica                                | Rótulos                                                                                                                                                                                                                      | Pergunta que responde                                                                                                                                                                                                                                             |
  | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `wagering_transactions_total`          | `channel` (`http`, `sqs`, `worker`), `kind`, `status`, `failure_code` (só em `REJECTED`)                                                                                                                                     | Quantas transições de estado houve, por onde e por quê (rejeições)? Conta transações novas e, no canal `worker`, a resolução ou rejeição de uma pendente: a mesma transação pode aparecer duas vezes, então a soma dos status não é o total de transações.        |
  | `wagering_duplicates_total`            | `type` (`idempotency_replay`, `idempotency_conflict`, `inbox_redelivery`, `inbox_conflict`)                                                                                                                                  | Quantas repetições e conflitos de chave ou de `messageId` o sistema absorveu?                                                                                                                                                                                     |
  | `wagering_retries_total`               | `operation` (`use_case_transient`, `sqs_visibility`, `outbox_publish`, `reference_reschedule`)                                                                                                                               | Onde o sistema está refazendo trabalho: transações em erro transitório, mensagens devolvidas à fila, publicações da outbox, referências reagendadas?                                                                                                              |
  | `wagering_dlq_messages_total`          | `failure_code`                                                                                                                                                                                                               | Quantas mensagens foram para a DLQ e por qual motivo?                                                                                                                                                                                                             |
  | `wagering_lock_conflicts_total`        | `code` (`55P03`, `40P01`, `40001`, `57014`, `connection`, `other`)                                                                                                                                                           | Há disputa de lock, deadlock ou timeout no banco? O rótulo `connection` agrupa as falhas de conexão (banco fora), que seguem a mesma política de retry. Contado onde o erro transitório é classificado, a cada ocorrência (inclusive a que esgota as tentativas). |
  | `wagering_outbox_pending`              | (gauge)                                                                                                                                                                                                                      | Quantos eventos já confirmados no banco ainda não foram publicados?                                                                                                                                                                                               |
  | `wagering_outbox_lag_seconds`          | (gauge)                                                                                                                                                                                                                      | Há quanto tempo o evento pendente mais antigo espera? Cresce se o SQS cai ou um evento trava em retry.                                                                                                                                                            |
  | `wagering_reconciliations_total`       | `result` (`consistent`, `divergent`)                                                                                                                                                                                         | Quantas conferências de wallet foram feitas e quantas acharam divergência? Alertar em qualquer aumento de `result="divergent"`.                                                                                                                                   |
  | `wagering_processing_duration_seconds` | histograma por `channel` e `outcome` (`processed`, `rejected`, `pending`, `replay`, `conflict`, `resolved`, `rescheduled`, `skipped`, `error`; `error` inclui erros do cliente, como payload inválido ou wallet inexistente) | Quanto tempo o caso de uso leva (transação inteira, com lock e retries), por canal e resultado?                                                                                                                                                                   |

  As métricas são **por instância**: contadores locais em memória, que não participam de nenhuma
  decisão de correção. Com várias instâncias, o Prometheus coleta cada uma e agrega (`sum by (...)`
  sobre os contadores, `max` sobre o lag). Reiniciar uma instância zera os contadores dela, o que
  `rate()` e `increase()` já tratam. Os gauges da outbox são lidos do banco a cada coleta, com uma
  única consulta curta (índice parcial dos não publicados) e prazo de 1 s; se o banco não responde
  a tempo, valem `NaN` e a coleta continua; uma consulta lenta é reaproveitada pelas coletas seguintes (uma por vez por instância) e o `statement_timeout` local de 1 s a cancela no servidor. Todas as instâncias enxergam a mesma outbox, então o
  valor é o mesmo em cada uma (agregar com `max`, não `sum`).
- **Alertas e dashboard (opcional):** o profile `observability` do Compose sobe o Prometheus (coleta
  o `/metrics` das três instâncias e avalia as regras) e o Grafana (dashboard provisionado em
  `docker/observability/`). As regras alertam para instância fora do ar (`up == 0`), lag da outbox
  acima de 60 s, backlog acima de 5.000, mensagens novas na DLQ e muitos conflitos de lock (mais de
  10 em 5 min). Sem Alertmanager: o disparo é visível no Prometheus e no Grafana. Os gauges da
  outbox podem vir `NaN`; comparação com `NaN` não dispara alerta (desconhecido não é falha).
- **Reconciliação** (`POST /wallets/:walletId/reconciliation`): confere o saldo gravado de uma
  wallet contra o ledger. Responde `200` sempre que a wallet existe, com a divergência sinalizada
  no corpo (`consistent: false`, `issues`), e `404 WALLET_NOT_FOUND` se não existe. Exemplo:

  ```json
  {
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "storedBalance": { "amount": "115.00", "currency": "BRL" },
    "calculatedBalance": { "amount": "115.00", "currency": "BRL" },
    "ledgerBalance": { "amount": "115.00", "currency": "BRL" },
    "difference": { "amount": "0.00", "currency": "BRL" },
    "version": 5,
    "ledgerVersion": 5,
    "checkedEntries": 5,
    "consistent": true,
    "issues": [],
    "checkedAt": "2026-10-22T12:00:00.000Z"
  }
  ```

  O que é conferido, tudo em `NUMERIC` no banco (nenhum valor monetário vira `number`):
  o saldo gravado é igual ao `balance_after` do último lançamento (`BALANCE_DIFFERS_FROM_LAST_ENTRY`);
  é igual à soma assinada dos lançamentos a partir de zero (`BALANCE_DIFFERS_FROM_LEDGER_SUM`;
  `difference` é gravado menos calculado); a `version` da wallet é a maior `wallet_version` do ledger
  (`VERSION_DIFFERS_FROM_LEDGER`; sem lançamentos, a versão esperada é 1); cada `balance_before` é o
  `balance_after` do lançamento anterior, e o primeiro parte de zero (`LEDGER_CHAIN_BROKEN`); as
  versões são contíguas (`LEDGER_VERSION_GAP`); cada lançamento tem a contrapartida da casa
  (`DOUBLE_ENTRY_GAP`). Os códigos de `issues` são estáveis para o
  consumidor decidir sem ler texto.

  A leitura é uma única instrução SQL, e no Postgres uma instrução enxerga um snapshot único
  (mesmo em `READ COMMITTED`): saldo e ledger são lidos do mesmo instante, então um lançamento que
  chega no meio da conferência não gera divergência falsa, e a leitura não bloqueia quem escreve
  (nenhum lock; sem `FOR UPDATE`). É uma consulta direta, sem passar pelo agregado. Divergência
  gera um log `warn` com `walletId` e `issues` (sem valores); toda conferência incrementa
  `wagering_reconciliations_total{result}`. **A reconciliação nunca corrige nada**: o saldo só muda pelo
  caminho do ledger, e uma divergência é um incidente para um humano investigar. Limitação: ela
  confere a consistência interna do banco, não o que os provedores consideram o saldo certo.
- `GET /health/live`: processo vivo, sem consultar dependências.
- `GET /health/ready`: `SELECT 1` no Postgres e `GetQueueUrl` nas três filas, em paralelo, cada
  verificação com timeout de 2 s; `503` indicando qual dependência está `down`. O cliente SQS não
  faz retry interno e tem timeout de conexão e de requisição, para não travar a verificação.

## 16. Teste de carga

`bun run test:load` (`scripts/load.ts`) é um teste de carga sem meta de vazão: o que importa é a
latência e a vazão medidas com honestidade e, acima de tudo, a prova de que nada se perdeu sob
carga. Roda contra as três instâncias do Compose (`docker compose --profile app up -d --build --wait`).

**Metodologia.**
- 200 wallets criadas por `POST /wallets` com saldo inicial de `1000000.00`; 5 delas são
  "quentes" e recebem 30% das novas `BET`, para forçar disputa pelo lock da wallet.
- 32 usuários virtuais, cada um sequencial (envia a próxima requisição só quando recebe a resposta),
  durante 60 s, com as requisições distribuídas em rodízio entre as três instâncias. Cada
  requisição escolhe um cenário: `BET` (maioria, de 1.00 a 20.00), `WIN` e `REFUND` sobre uma `BET`
  anterior já processada (`referenceExternalTransactionId`), repetição idêntica (mesma
  `Idempotency-Key` e mesmo corpo, esperando `idempotentReplay: true`) e `BET` de valor impossível
  (`422 INSUFFICIENT_FUNDS`). Todo `externalTransactionId` leva um prefixo único da execução.
- Resultados esperados do negócio (`201`, replay, `422`) não contam como erro; erro é `5xx` ou falha
  de rede. Qualquer outra resposta inesperada também reprova a execução.
- Antes e depois do tráfego o script lê o `/metrics` das três instâncias e soma a diferença dos
  contadores; o backlog da outbox é amostrado uma vez por segundo durante o tráfego e depois
  acompanhado até zerar.
- **Prova de corretude**, ao final: `POST /wallets/:id/reconciliation` para as 200 wallets (todas
  precisam voltar `consistent: true`), nenhum saldo negativo, e o saldo gravado de cada wallet
  igual ao que o próprio script calculou, em centavos (`bigint`), somando só as respostas
  processadas (a réplica não conta). O código de saída é diferente de zero se qualquer dessas
  condições, um `5xx`/erro de rede ou a outbox não esvaziar dentro do prazo falhar.

**Ambiente.** AMD Ryzen 7 3700U (4 núcleos, 8 threads), 5,7 GB de RAM visíveis ao sistema, Bun 1.4.3,
Docker. Três instâncias da aplicação com `mem_limit` de 256 MB, Postgres 17 (256 MB) e LocalStack
(512 MB) no mesmo Compose. **O gerador de carga roda na mesma máquina e disputa CPU com o sistema
testado**, e a rede é o loopback.

**Resultados** (duas execuções de 60 s, seguidas, depois de um aquecimento de 20 s; a máquina com o
navegador fechado, mas com o editor e o próprio gerador de carga ativos):

|                                                                                         | Execução 1                        | Execução 2                        |
| --------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| Requisições                                                                             | 15.748                            | 16.262                            |
| Vazão                                                                                   | 262,0 req/s                       | 270,6 req/s                       |
| Latência p50 / p95 / p99 / máx                                                          | 91,2 / 323,0 / 612,3 / 2.111,6 ms | 88,3 / 303,0 / 623,3 / 1.885,4 ms |
| Wallets quentes p50 / p95 / p99                                                         | 157,1 / 534,0 / 850,3 ms          | 152,9 / 528,4 / 929,5 ms          |
| Demais wallets p50 / p95 / p99                                                          | 77,1 / 173,5 / 232,6 ms           | 74,4 / 165,0 / 213,3 ms           |
| Status                                                                                  | 15.256 × `201`, 492 × `422`       | 15.762 × `201`, 500 × `422`       |
| Erros (`5xx` ou rede)                                                                   | 0                                 | 0                                 |
| Replays detectados (`wagering_duplicates_total`)                                        | 1.350                             | 1.495                             |
| Conflitos de lock / retries (`wagering_lock_conflicts_total`, `wagering_retries_total`) | 0 / 0                             | 0 / 0                             |
| Tempo médio do caso de uso (servidor)                                                   | 112,2 ms                          | 108,7 ms                          |
| Outbox: pico de pendentes / lag durante o tráfego                                       | 2.793 / 38,2 s                    | 2.687 / 37,8 s                    |
| Tempo para a outbox esvaziar depois do tráfego                                          | 88,2 s                            | 89,1 s                            |
| Wallets reconciliadas como consistentes                                                 | 200 de 200                        | 200 de 200                        |
| Saldos negativos / saldo diferente do esperado                                          | 0 / 0                             | 0 / 0                             |

Numa terceira execução, o backlog foi conferido direto no Postgres (`SELECT count(*) FROM
outbox_messages WHERE published_at IS NULL`, uma amostra por segundo): o pico real foi **2.775**
pendentes — coerente com o gauge — e a drenagem foi de 115 s, mostrando a variação do tempo de
cauda (88 s, 89 s e 115 s nas três execuções).

Depois do ajuste do loop (seção 11: quando o ciclo publica algo sem falha, o próximo começa na
hora), uma execução de 60 s deu 223 req/s, pico de **1.484** pendentes e a outbox esvaziou em
**4,99 s** — contra 88–115 s antes do ajuste, com 200/200 wallets reconciliadas e zero erros. A
vazão HTTP variou para baixo nesta execução por carga da máquina; o ajuste só mexe no intervalo
entre ciclos do publisher e não altera o caminho HTTP.

**Análise.**
- **O publisher deixou de acumular backlog.** Com o envio em lotes (`SendMessageBatch`) e os
  pedaços em paralelo (`OUTBOX_PUBLISH_CONCURRENCY`), o backlog fica na casa de 1.500–2.700 durante
  o tráfego, contra os ~20.700 de uma medição anterior em que o publisher mandava um `SendMessage`
  por evento: cerca de 7× menos. Nessa vazão o publisher acompanha a produção (cerca de 450
  eventos/s) e não perde nada (a corretude passou).
- **A ordem estrita por wallet ainda limita a vazão por wallet, mas a cauda deixou de ser lenta.** O
  claim só libera a cabeça (menor `wallet_version` não publicada) de cada wallet, então uma wallet
  quente avança uma versão por ciclo de claim. Antes, o loop esperava 250 ms entre ciclos quando o
  lote vinha incompleto, e depois do tráfego (poucas cabeças restantes) isso dominava a cauda
  (88–115 s). Agora o ciclo encadeia na hora enquanto publica algo, e o que sobra drena em ~5 s; o
  limite de uma versão por wallet continua sendo o custo consciente da garantia de ordem (seção 11),
  mas não se traduz mais em espera artificial entre ciclos.
- **Vazão e latência do caminho HTTP ficaram estáveis.** ~266 req/s e p50 ~90 ms, sem erros, dentro
  da variação desta máquina (gerador e sistema disputam CPU). A medição não permite atribuir ganho
  nem perda ao caminho HTTP.
- **A CPU da máquina inteira satura.** Com gerador, banco e instâncias na mesma máquina, não dá para
  separar quanto da latência é do sistema e quanto é do gerador. Numa amostra do `docker stats`,
  cada instância usava uma fração de núcleo, o Postgres se aproxima do teto de 256 MB e o LocalStack
  também trabalha; a soma satura a máquina.
- **A disputa pelo lock de uma wallet aparece como latência, não como erro.** As 5 wallets quentes
  têm p50 cerca de duas vezes o das demais e p99 três a quatro vezes maior, porque as transações da
  mesma wallet se enfileiram no `SELECT … FOR UPDATE`. Nenhuma execução teve conflito de lock
  (`lock_timeout`, deadlock ou serialização) nem retry: a espera coube dentro do `lock_timeout`, e a
  correção do saldo não depende de sorte.
- **Pool de conexões: o teste não o isolou como gargalo.** Com 32 usuários virtuais para três
  instâncias de 10 conexões cada, não houve erro de pool, mas a aplicação não expõe métrica de
  espera por conexão, e o Postgres (CPU e memória) se esgota antes. Por isso a configuração do
  pool não mudou.

**Comparação com medições anteriores.** A medição antiga (vazão ~290 req/s, backlog ~20.700,
drenagem ~83 s) foi feita com um publisher diferente (um `SendMessage` por evento) e com outro
estado da máquina; os números não são diretamente comparáveis. O que se pode afirmar é a direção:
o backlog caiu uma ordem de grandeza e a cauda da outbox passou a ser limitada pela ordem por
wallet, não pela vazão agregada de publicação.

**O que os números não significam.** Não são a capacidade do sistema: são o que esta combinação
(máquina de notebook, gerador de carga no mesmo hardware, banco com 256 MB, SQS emulado pelo
LocalStack) entrega. A latência medida inclui a disputa por CPU com o próprio gerador. Os usuários
são sequenciais, então a vazão é limitada pela latência (carga em laço fechado); um gerador em
laço aberto, com taxa fixa, mediria melhor o ponto de saturação. O tráfego é sintético: 12%
de replays, 3% de saldo insuficiente e 5 wallets quentes são escolhas do experimento, não
um perfil real. A prova de corretude, ao contrário, não depende da máquina: vale para qualquer
vazão. As filas já usam FIFO de alta vazão (seção 12), então o teto do SQS não é o limitante aqui;
o LocalStack, de qualquer forma, não impõe os limites de vazão da AWS, então essa mudança não
altera o resultado local — ela afasta o limite do serviço em produção.

**Como reproduzir.** Ver "Teste de carga" no README.

## 17. Decisões de projeto

As decisões abaixo complementam as das seções anteriores (cada uma explica a sua no ponto onde
aparece). Formato: decisão, alternativas consideradas e motivo.

### Stack e código

| Decisão                                                                                              | Alternativas                                                                 | Motivo                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MikroORM 6 sem decorators: mapeamento por `EntitySchema` em `infrastructure/persistence`             | entidades decoradas; TypeORM; Prisma                                         | o domínio fica sem framework e sem metadados de ORM; evita problemas de reflection no Bun                                                                                                                                            |
| IDs UUIDv7 atrás da porta `IdGenerator` (`Bun.randomUUIDv7()`) e tempo atrás da porta `Clock`        | UUIDv4 direto; `Date.now()` espalhado                                        | testes determinísticos (relógio falso avança além de um lease sem esperar); UUIDv7 é ordenável no tempo                                                                                                                              |
| Validação de entrada com zod em `interfaces/`                                                        | `class-validator` com `ValidationPipe`                                       | o mesmo schema serve ao controller HTTP e ao consumer SQS, que não passa pelo `ValidationPipe`                                                                                                                                       |
| Regras do valor monetário (escala, sinal, moeda, faixa) no `Money`, não no schema do corpo           | validar `amount` no zod                                                      | uma só implementação para HTTP, SQS e testes; o erro sai como `INVALID_MONEY`                                                                                                                                                        |
| Casos de uso montados por `useFactory` nos módulos Nest, sem decorators na aplicação                 | `@Injectable()` e `@Inject(TOKEN)` nos casos de uso                          | a aplicação não importa o Nest; a composição fica no módulo                                                                                                                                                                          |
| Aplicação recebe `isTransient` e `isUniqueViolation` como funções nas dependências                   | porta `TransientErrorDetector` com classe; importar `pg-errors` na aplicação | a aplicação não conhece o Postgres e não ganha uma interface só para duas funções                                                                                                                                                    |
| Repositórios e entidades de persistência em um módulo compartilhado                                  | cada módulo registrar os seus                                                | HTTP, outbox, consumer e workers usam os mesmos repositórios; um ponto de registro evita providers duplicados e dependência circular                                                                                                 |
| Logs JSON com `nestjs-pino`, sem payload nem valores financeiros                                     | logger padrão do Nest                                                        | logs estruturados sem vazamento de dados financeiros                                                                                                                                                                                 |
| Lint e formatação com Biome                                                                          | ESLint e Prettier                                                            | uma ferramenta só, rápida e sem configuração pesada                                                                                                                                                                                  |
| `@nestjs/testing` (dev) para trocar providers no app de teste                                        | hooks de teste no `AppModule`; trigger temporário no banco                   | mecanismo oficial do Nest, sem poluir o código de produção                                                                                                                                                                           |
| `WALLET_ALREADY_EXISTS` só em `ErrorCode`, fora de `FAILURE_CODES`                                   | incluí-lo em `FAILURE_CODES`                                                 | `FailureCode` é o que se grava em transações rejeitadas; criar wallet não gera transação rejeitada                                                                                                                                   |
| Flags booleanas de ambiente com `z.stringbool()`                                                     | `z.coerce.boolean()`                                                         | `coerce.boolean` transformaria a string `"false"` em `true`                                                                                                                                                                          |
| Erros do body-parser (`http-errors` com `expose: true`) viram `INVALID_PAYLOAD` preservando o status | deixar cair em `500`                                                         | corpo grande demais devolve `413` e o provedor sabe que deve corrigir a requisição                                                                                                                                                   |
| Erros `5xx`, inclusive de `DomainError`, saem com mensagem genérica; o detalhe fica só no log        | ecoar a mensagem do erro                                                     | evita vazar detalhe interno ao cliente                                                                                                                                                                                               |
| Falha de inicialização escrita como uma linha JSON (`level: fatal`) e saída com código 1             | deixar a promessa rejeitada sem tratamento                                   | o orquestrador enxerga a falha e o log não perde o motivo                                                                                                                                                                            |
| Pool de conexões do MikroORM no padrão (2 a 10 por instância), sem variável nova                     | `DB_POOL_MAX` configurável                                                   | 200 requisições simultâneas passam sem erro; com N instâncias, N × 10 cabe em `max_connections = 100`; vira variável só se o teste de carga mostrar o pool como gargalo; o teste (seção 16) não o apontou, e o Postgres satura antes |
| Publicação da outbox com concorrência limitada (`OUTBOX_PUBLISH_CONCURRENCY`, padrão 5)              | sequencial; todo o lote em paralelo                                          | sobrepõe a latência do `SendMessageBatch` (o gargalo medido) sem disparar o lote inteiro de uma vez; a ordem por wallet vem do claim (cabeça por wallet), não desta concorrência                                                     |
| Idempotência numa leitura só (`findByIdempotency` devolve `byKey` e `byExternalId`)                  | duas consultas separadas                                                     | um round-trip a menos por transação; a chave tem precedência (uma linha que casa com os dois sai só em `byKey`), preservando a semântica anterior                                                                                    |
| `lock_timeout` da wallet continua com `SET LOCAL`, não no nível da conexão                           | `lock_timeout` como parâmetro de startup da conexão                          | no nível da conexão o timeout vazaria para DDL que espera locks legitimamente (`TRUNCATE` nos testes, migrations), e o ganho de um round-trip por transação não paga esse risco                                                      |

### Schema

| Decisão                                                                                                                                                                                                                               | Alternativas                                           | Motivo                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHECK` `wager_tx_reversal_resolved_ck`: `REFUND`/`ROLLBACK` `PROCESSED` exige `reference_transaction_id`                                                                                                                             | confiar só no processador; `UNIQUE NULLS NOT DISTINCT` | o índice parcial `wager_tx_single_reversal_uq` não enxerga `NULL`, então uma reversão processada sem referência escaparia de "uma reversão por referência"; `NULLS NOT DISTINCT` faria todas as reversões sem referência colidirem entre si |
| `CHECK` baratos: snapshot de `PROCESSED`, referência diferente da própria linha, versões ≥ 1, contadores ≥ 0                                                                                                                          | validar só no domínio                                  | custo zero em runtime e invariantes no schema, como o enunciado pede                                                                                                                                                                        |
| Colunas de resultado da transação (`status`, `failure_code`, `balance_after`, `wallet_version_after`, `processed_at`, `reference_*`, `updated_at`) mutáveis; identidade, valores, `payload_hash` e `created_at` imutáveis por trigger | tabela de transação toda imutável                      | a transação nasce pendente e recebe o resultado depois; o que identifica e o que foi pedido nunca muda                                                                                                                                      |
| Trigger `ledger_wallet_matches_transaction` garante que o lançamento aponta para uma transação da mesma wallet                                                                                                                        | FK composta `(transaction_id, wallet_id)`              | a FK composta exigiria um `UNIQUE (id, wallet_id)` redundante em `wager_transactions`; o trigger dá a mesma garantia com um `SELECT` por insert de ledger, sem índice a mais                                                                |
| Migrations por script próprio (`scripts/migrate.ts`, Migrator do MikroORM)                                                                                                                                                            | CLI do MikroORM                                        | funciona com Bun sem ts-node; `down` reverte a última migration                                                                                                                                                                             |
| Migrations ficam imutáveis depois de aplicadas; mudança de schema é migration nova e reversível                                                                                                                                       | editar a inicial                                       | bancos já migrados não divergem do código                                                                                                                                                                                                   |

### Infraestrutura local

| Decisão                                                                                                                        | Alternativas                                                         | Motivo                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres:17-alpine` e `localstack/localstack:4.4.0` (só SQS), versões fixas, com `mem_limit`                                  | imagens `latest` (as recentes do LocalStack exigem token); MiniStack | reprodutibilidade e gratuidade numa máquina com pouca memória                                                                                                                                       |
| Postgres publicado na porta padrão 5432 do host, trocável por `POSTGRES_HOST_PORT` e `DB_PORT`                                 | porta alternativa fixa                                               | quem avalia espera o padrão; quem já tem um Postgres local muda as duas variáveis no `.env`                                                                                                         |
| Filas criadas por script de init do LocalStack, FIFO com `ContentBasedDeduplication=false`; a principal com redrive para a DLQ | criar filas no código da aplicação                                   | infraestrutura declarada fora da aplicação e deduplicação sempre explícita                                                                                                                          |
| Healthcheck do LocalStack consulta `/_localstack/init/ready` e exige `completed: true`                                         | `"sqs": "running"` em `/_localstack/health`                          | o SQS fica "running" antes de o script criar as filas; `up --wait` liberava testes e app com filas inexistentes                                                                                     |
| Eventos da outbox numa terceira fila, `wagering-events.fifo` (grupo = `aggregateId`, deduplicação = `eventId`)                 | publicar na fila de entrada                                          | o enunciado não define o destino; misturar eventos com comandos confundiria os consumidores                                                                                                         |
| Nomes das filas configuráveis por variável de ambiente                                                                         | nomes fixos                                                          | cada suíte de teste usa filas próprias, sem interferir nas outras nem no ambiente local                                                                                                             |
| Banco de testes separado (`wagering_test`) no mesmo container                                                                  | um container por ambiente                                            | isolamento sem custo extra de memória; só é criado na primeira subida do volume                                                                                                                     |
| App roda com papel DML-only (`wagering_app`), sem DDL nem `TRUNCATE`; migrations com o dono (`wagering`)                       | uma credencial única de superusuário                                 | menor privilégio de verdade no banco; a app só precisa de `SELECT/INSERT/UPDATE` e de `DELETE` na outbox; os grants são aplicados após `migrate up` (idempotente, roda também em volume já migrado) |
| Keycloak num profile `auth` do Compose e as instâncias da aplicação num profile `app`                                          | tudo sempre ativo                                                    | economizar memória; os testes reutilizam Postgres e LocalStack já no ar                                                                                                                             |
| Prometheus + Grafana num profile `observability` do Compose, com `mem_limit` e retenção curta                                  | stack de observabilidade sempre ativa ou hospedada                   | alertas e dashboard sem pesar na máquina de 8 GB; sobem só quando alguém quer olhar os painéis                                                                                                      |
| Testes de integração usam `TEST_LOG_LEVEL` (padrão `silent`)                                                                   | herdar o `LOG_LEVEL` do `.env`                                       | quem copia `.env.example` não vê os testes cheios de log                                                                                                                                            |

### Testes

| Decisão                                                                                                                                                  | Alternativas                                               | Motivo                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Corridas em `test/concurrency` com script e passo de CI próprios; paralelismo real com `Promise.all` de `fetch`                                          | incluir em `test:integration`; chamar o caso de uso direto | permite rodar só as corridas; passa por toda a pilha (HTTP, validação, pool, lock)                                                           |
| Invariante do ledger (saldo = soma, versões contínuas, cadeia `balance_before`/`balance_after`) verificada depois de cada teste que grava pela aplicação | só no fim de cada suíte                                    | só a cadeia entre linhas detecta lançamento perdido ou fora de ordem; a suíte de schema fica de fora porque grava linhas soltas de propósito |
| Teste de que o lock é por wallet: outra conexão segura `FOR UPDATE` na wallet A e uma aposta na B volta `201` em menos de 1 s                            | inferir pelo tempo total                                   | prova direta e determinística de que não existe lock global                                                                                  |
| Teste multi-instância com três processos reais (`Bun.spawn`), filas próprias, `SIGKILL`, `SIGTERM` e reinício; espera por condições no banco e na fila   | containers; `sleep`                                        | determinismo e custo de memória menor que três containers                                                                                    |
| Testes de falha do consumer com filas e instância próprias e provider trocado                                                                            | usar a instância compartilhada da suíte                    | a instância compartilhada consumiria as mensagens e um long poll abortado de outra instância poderia recebê-las                              |
| Sem mocks de banco ou fila nos testes de integração                                                                                                      | repositórios e cliente SQS falsos                          | o enunciado exige Postgres e LocalStack reais; só se troca um provider para provocar uma falha específica                                    |

### O que ficou de fora de propósito

Prioridade do projeto: correção financeira, concorrência, idempotência e mensageria primeiro, e a
opção mais simples quando houver dúvida. Estes itens foram avaliados e deixados de fora; cada um
diz o que custaria e como entraria.

| Item                                        | Por que ficou de fora                                                                                                                                                                  | Como entraria                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Gateway na borda (limite de taxa, timeouts) | infraestrutura de implantação, fora do que o serviço garante; `lock_timeout` e `statement_timeout` já limitam quanto tempo uma requisição segura o banco                               | proxy reverso na frente das instâncias, com limite por IP e `/metrics` só na rede interna |
| Tracing distribuído                         | o serviço expõe logs com ids, métricas Prometheus, alertas e dashboard; tracing pesa e não muda a correção                                                                             | coletor OTLP e instrumentação dos casos de uso                                            |
| Auditoria de submissões inválidas           | decisão da seção 4: o que falha antes de existir uma transação válida devolve o erro e fica em log e métrica (no SQS, vai para a DLQ com o código); só a rejeição de negócio é gravada | tabela própria de recusas, com retenção, fora da tabela de transações                     |
| Lote por wallet no consumer                 | otimização de vazão; o gargalo medido no teste de carga é o publisher da outbox, não o consumer                                                                                        | seção 19                                                                                  |

## 18. Limitações conhecidas

- `TRUNCATE` não dispara os triggers de linha que tornam o ledger append-only. Ele é usado apenas
  nos testes para limpar o banco; em produção o usuário da aplicação não deve ter permissão de
  `TRUNCATE`.
- Autenticação desligada por padrão (`AUTH_ENABLED=false`): enquanto não for ligada, qualquer
  cliente que alcance a API pode submeter transações em nome de qualquer provedor. Ligar exige
  subir o Keycloak (profile `auth`) e configurar as variáveis `OIDC_*` (seção 14).
- O teste de carga (seção 16) roda com o gerador na mesma máquina do sistema testado, em laço
  fechado, com tráfego sintético: serve de comparação entre execuções nesta máquina, não de
  estimativa de capacidade. A publicação da outbox não acompanha a produção de eventos nessa
  vazão e o backlog cresce durante o tráfego.
- A chave de idempotência e o `externalTransactionId` são independentes: reenviar a mesma operação
  de negócio com uma chave nova e o mesmo `externalTransactionId` é `409 IDEMPOTENCY_CONFLICT`, e o
  provedor corrige usando um `externalTransactionId` novo.
- Uma pendência cuja reavaliação falha sempre com um erro não transitório (um bug) é tentada de
  novo a cada lease (`PENDING_REFERENCE_LEASE_MS`, 30 s por padrão) e logada a cada vez; `reference_attempts` não cresce, então ela não
  chega à rejeição sozinha.
- O lease do worker de referências pendentes também usa o relógio da instância. Um desvio de
  relógio só faz duas instâncias reavaliarem a mesma pendência, o que o lock da wallet e a releitura
  da transação tornam inofensivo; no máximo uma tentativa é contada a mais.
- O publisher da outbox tenta indefinidamente (backoff até 5 min) e não tem DLQ própria: um evento
  que nunca consegue ser publicado fica pendente, com `attempts` e `last_error` visíveis na tabela.
- O lease usa o relógio de cada instância (`Clock`), não o do banco: relógios das instâncias
  precisam estar sincronizados (NTP) com folga bem menor que o lease de 30 s. Um desvio maior só
  causa publicação duplicada (tratada pela deduplicação), nunca perda.
- Um crédito que levaria o saldo além de `NUMERIC(20,2)` (18 dígitos inteiros) é uma rejeição de
  negócio: a transação é gravada como `REJECTED` com `BALANCE_LIMIT_EXCEEDED` (`422`), o evento é
  publicado, o SQS recebe ack e o worker de referências pendentes a encerra como `REJECTED`. O
  limite (quase 10^18) não é alcançável na prática. Como `REFUND` e `ROLLBACK` têm o mesmo valor
  da `BET` original, uma reversão pendente só estoura se um crédito grande entrar entre a `BET` e
  a resolução; esse caminho é coberto por teste unitário, não por integração, por depender dessa
  corrida.
- As linhas publicadas da outbox são removidas pelo `OutboxRetentionWorker` (seção 11) depois de um
  prazo configurável (`OUTBOX_RETENTION_MAX_AGE_MS`, 7 dias por padrão); enquanto o worker está
  desligado ou o prazo não venceu, elas permanecem na tabela.
- Um lote reservado é publicado em sequência por wallet; se o SQS ficar lento (no pior caso cerca
  de 2,5 s por envio: 1 s para abrir a conexão mais 1,5 s esperando a resposta) e uma wallet tiver
  muitos eventos no mesmo lote, o envio pode passar do lease e outra instância reservar as mesmas
  linhas — resultado: duplicatas, absorvidas pela deduplicação.
- `@mikro-orm/nestjs` 6.1.2 declara peer dependencies para Nest `^10 || ^11`, e o projeto roda
  Nest 12. A integração funciona e é coberta pelos testes de integração; se uma versão futura
  quebrar, a alternativa é registrar à mão um provider de `MikroORM` (`MikroORM.init` +
  `orm.close()` no shutdown), sem o módulo.
- **Contador de entregas compartilhado no grupo.** Mensagens devolvidas sem processar (atrás de uma
  que falhou no mesmo grupo, ou não iniciadas num desligamento) também têm o
  `ApproximateReceiveCount` incrementado; num desligamento, outro laço com long poll ainda aberto
  pode recebê-la e devolvê-la de novo, até uma entrega a mais por laço. Se a da frente esgotar as
  entregas, as de trás podem ir para a DLQ pelo redrive sem nunca terem falhado. Devolver a DLQ para
  a fila principal é seguro: a inbox e a idempotência impedem efeito duplicado. Essas entregas sem
  processamento também contam para o limite do erro inesperado: uma mensagem atrás de uma que falha
  pode chegar à primeira tentativa real já com 3 ou mais entregas (um único erro inesperado a manda
  para a DLQ como `INTERNAL_ERROR`), e o backoff de um transitório dela começa mais alto. Contar as
  falhas reais no banco resolveria, com mais schema e lógica para um caso raro.
- **Duplicata na DLQ fora da janela de 5 min.** Se o processo morrer entre o envio para a DLQ e o
  ack na fila principal, e a mensagem voltar depois da janela de deduplicação do SQS, ela aparece
  duas vezes na DLQ. Reprocessá-la continua seguro pela inbox e pela idempotência.
- **`statement_timeout` nas migrations.** As migrations usam a mesma configuração de conexão da
  aplicação, com `statement_timeout = 5s` (seção 9). Uma migration futura com um comando mais
  longo (um índice numa tabela grande, por exemplo) seria cancelada; ela precisa de
  `SET LOCAL statement_timeout = 0` no início, ou o script de migração precisa usar outro valor.

## 19. Próximos passos

**Performance (na ordem do gargalo atual):**
- **A cauda da outbox para wallets quentes.** O loop já não espera o intervalo quando publicou algo
  (seção 11), o que acelera a cauda; o que resta é a vazão por wallet quente, limitada a uma versão
  por ciclo de claim (seção 16). Candidato: permitir um prefixo contíguo de versões por wallet no
  claim, mantendo a ordem estrita e provando isso no banco.
- **Medir o custo do SQS emulado (LocalStack) isoladamente**, para separar quanto da latência de
  publicação é do serviço emulado e quanto é do banco/aplicação.
- **Restam poucos round-trips no caminho HTTP** (cerca de uma dezena de instruções por transação).
  Mover o `SET LOCAL lock_timeout` para o nível da conexão foi avaliado e rejeitado (a seção 17
  explica o porquê); outras oportunidades, se o teste de carga as apontar.

**Retenção de dados (prazo maior):**
- **Crescimento do ledger e do journal.** São append-only por regra; a retenção da outbox já limita
  a tabela de eventos, mas `wallet_ledger_entries` e `journal_entries` crescem sem limite.
  Candidatos: particionamento por período ou arquivamento para armazenamento frio, preservando a
  imutabilidade.
- **Connection pooling sob pressão.** Medir a espera por conexão sob carga e dimensionar o pool
  (hoje o padrão do MikroORM) contra o pico de concorrência.
