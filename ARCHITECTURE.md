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

Nos códigos `REJECTED` marcados como "corrigir" (`CURRENCY_MISMATCH`, `PLAYER_MISMATCH`,
`REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`), a transação rejeitada é
terminal: reenviar o payload corrigido com a mesma chave ou o mesmo `externalTransactionId`
devolve `409`. A correção deve ir como uma nova transação (novo `externalTransactionId` e nova
`Idempotency-Key`).

Códigos usados apenas na API HTTP (não são `failureCode` de transação): `WALLET_ALREADY_EXISTS`,
`NOT_FOUND`, `UNAUTHORIZED`, `SERVICE_UNAVAILABLE`.

## 4. O que é gravado vs. só erro HTTP

- **Não gravados** — falham antes de existir uma transação válida; não geram evento na outbox e
  ficam visíveis em log/métrica: `INVALID_PAYLOAD`, `INVALID_MONEY`, `REFERENCE_REQUIRED` (`400`),
  `WALLET_NOT_FOUND` (`404`), `IDEMPOTENCY_CONFLICT` (`409`). Comportamento planejado para o consumer SQS (ainda não
  implementado): são erros de negócio, e a mensagem é confirmada (ack) sem efeito.
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
entrada do processamento (o consumer SQS vai chamar o mesmo caso de uso). Antes de abrir a
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

| Tipo | Efeito | Referência |
|---|---|---|
| `BET` | débito; sem saldo → `INSUFFICIENT_FUNDS` | não aceita |
| `WIN` | crédito | opcional; se informada, precisa ser uma `BET` |
| `LOSS` | nenhum movimento (`PROCESSED`, sem ledger, só `WagerTransactionProcessed`) | opcional; se informada, precisa ser uma `BET` |
| `REFUND` | crédito do valor da `BET` | obrigatória, só `BET` |
| `ROLLBACK` | inverso da referência (desfaz `BET` com crédito, `WIN`/`REFUND` com débito); débito sem saldo → `REVERSAL_INSUFFICIENT_FUNDS` | obrigatória: `BET`, `WIN` ou `REFUND` |

A referência é resolvida por `(provider_id, reference_external_transaction_id)` e verificada nesta
ordem; a primeira regra violada decide o `failureCode`:

- ainda não existe → `202 PENDING_REFERENCE` (grava `next_reference_attempt_at`);
- de outro player, wallet, rodada ou moeda → `REFERENCE_MISMATCH`;
- tipo não permitido pela tabela acima → `INVALID_REFERENCE_KIND` (ex.: `REFUND` de um `WIN`, ou
  `ROLLBACK` de um `LOSS`: o `LOSS` não moveu saldo, não há o que desfazer);
- referência não está `PROCESSED` → `REFERENCE_NOT_PROCESSED`;
- referência já revertida → `ALREADY_REVERSED`. Vale também para `WIN`/`LOSS`: pagar o `WIN` de
  uma aposta já estornada pagaria duas vezes;
- só em `REFUND`/`ROLLBACK`: valor diferente do valor da referência → `AMOUNT_MISMATCH`.

`WIN`/`LOSS` sem referência são aceitos sem vínculo (o provedor nem sempre informa a aposta).

### HTTP

| Rota | Resposta |
|---|---|
| `POST /wagering/transactions` (header `Idempotency-Key` obrigatório, até 255 caracteres) | `201` `PROCESSED`, `202` `PENDING_REFERENCE`, `422` `REJECTED`, `409` conflito de idempotência, `400`/`404` como na seção 5, `503` + `Retry-After` em falha transitória |
| `GET /wagering/transactions/:transactionId` | `200` com a transação, `404 NOT_FOUND` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `200` com a transação, `404 NOT_FOUND` |

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

Por que não lock otimista: o caso crítico é a *hot wallet* (muitas apostas simultâneas no mesmo
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

**Pior caso de espera.** O `lock_timeout` limita *cada* espera por lock, não a transação inteira,
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
execução ainda roda. A `maxReceiveCount` da redrive policy é 10. Os nomes das filas são
configuráveis por `SQS_TRANSACTIONS_QUEUE`, `SQS_TRANSACTIONS_DLQ` e `SQS_EVENTS_QUEUE`.

**Pool de conexões.** Cada instância usa o pool padrão do MikroORM (knex: no máximo 10 conexões).
Requisições além disso esperam por uma conexão livre antes de abrir a transação, então essa espera
não consome o `lock_timeout`. Os testes de concorrência disparam 200 requisições simultâneas
contra uma instância com esse pool, sem erro. Com N instâncias, N × 10 conexões precisam caber no
`max_connections` do Postgres (100 por padrão).

**Como é testado** (`test/concurrency/wagering-races.test.ts`, requisições HTTP reais disparadas
juntas com `Promise.all` contra Postgres real): saldo `100.00` com duas apostas de `80.00` em 10
rodadas; a mesma aposta 50 vezes em paralelo; a mesma chave em duas wallets; `REFUND` e `ROLLBACK`
da mesma `BET` ao mesmo tempo; 10 wallets com 20 apostas cada. Além das respostas HTTP, os testes
conferem no banco o saldo, o ledger, as transações gravadas e os eventos na outbox. Há ainda um
teste de que o lock é por wallet e não global: outra conexão segura o `FOR UPDATE` da wallet A e, enquanto isso, uma aposta
na wallet B recebe `201` em menos de 1 s. Para validar que os testes detectam a falta do lock, o
`FOR UPDATE` foi removido manualmente numa verificação pontual: quatro dos seis testes falharam (o
da mesma chave em duas wallets depende só da `UNIQUE`, e o do lock por wallet não depende do lock
da aplicação). Depois de cada teste que grava pela aplicação, um helper confere em SQL que o
saldo de cada wallet é igual à soma do seu ledger, que as versões do ledger são contínuas e que a
cadeia de saldos fecha (o `balance_before` de cada lançamento é o `balance_after` do anterior, e o
primeiro parte de zero). A suíte de schema fica de fora: ela grava linhas soltas de propósito para
provocar cada constraint.

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
  Uma transação `PENDING_REFERENCE` devolve o seu estado
  atual (`202` enquanto pendente); quando o processamento das pendências existir e a resolver, o
  replay passa a devolver o resultado final. O replay nunca tenta resolver a referência na hora.
- **Falha no COMMIT.** Se a conexão cai durante o `COMMIT`, o cliente não sabe se a transação foi
  gravada. Se não foi, o reenvio processa normalmente; se foi, o reenvio encontra a original e
  devolve um replay. Em qualquer caso existe exatamente um efeito no saldo e no ledger.

## 11. Outbox e publicação de eventos

**Gravação.** Os eventos entram na tabela `outbox_messages` na mesma transação SQL do saldo, do
ledger e da transação de aposta. Se a transação faz rollback, o evento não existe; se faz commit,
ele fica gravado mesmo que o processo morra no instante seguinte. Nada é enviado à fila de dentro
da transação: o envio só acontece depois, a partir do que já está confirmado no banco.

**Publisher.** Cada instância roda um loop (`OutboxPublisherWorker`) que chama
`PublishOutboxUseCase.runOnce()` a cada `OUTBOX_POLL_INTERVAL_MS` (250 ms). Um ciclo:

1. **Reserva** (transação curta e própria):
   `SELECT ... FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= $agora
   ORDER BY occurred_at, id LIMIT $lote FOR UPDATE SKIP LOCKED` e, na mesma transação,
   `next_attempt_at = $agora + lease` (30 s) para as linhas escolhidas; `COMMIT`.
2. **Publica** fora de qualquer transação, em `wagering-events.fifo`, com
   `MessageGroupId = aggregateId` (a wallet) e `MessageDeduplicationId = eventId`; o corpo é o
   envelope JSON gravado no `payload`. Eventos da mesma wallet saem um de cada vez, na ordem do
   lote; wallets diferentes saem em paralelo.
3. **Registra** o resultado, em escritas curtas e separadas: sucesso →
   `UPDATE ... SET published_at = $agora WHERE id = $id AND published_at IS NULL`; falha →
   `attempts + 1`, `next_attempt_at` com backoff exponencial e jitter (1 s, 2 s, 4 s ... até 5 min)
   e `last_error` (até 500 caracteres). Uma falha não impede as outras wallets do lote, mas para a
   wallet dela neste ciclo: as mensagens seguintes da mesma wallet são adiadas para o mesmo
   horário da nova tentativa, sem contar tentativa, para não saírem antes da que falhou.
   As duas escritas só valem enquanto a reserva ainda é de quem escreve
   (`next_attempt_at <= fim do lease reservado`): se o lease venceu e outra instância reservou a
   linha de novo, uma falha atrasada não sobrescreve o lease nem o `attempts` dela.

Lote cheio publicado → o próximo ciclo começa na hora (ainda há fila); ciclo com falhas espera o
intervalo normal, para não varrer a outbox sem pausa enquanto o SQS está fora. Erro no ciclo (banco fora, por
exemplo) é logado, sem o conteúdo dos eventos, e o loop continua. No shutdown, o worker para antes
de o pool do Postgres e o cliente SQS serem fechados e espera o ciclo em andamento terminar.

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
(`attempts = 1`, nova tentativa no futuro, `last_error`, demais wallets publicadas); falha parando
a wallet no ciclo e publicando-a em ordem no seguinte; falha atrasada que não sobrescreve a reserva
de outra instância; dois
publishers concorrentes sobre 100 eventos (todos recebidos, cada linha reservada por um único
publisher, nenhuma pendente); reserva abandonada não é pega antes do lease e é publicada depois; e
o worker ligado publicando os eventos de uma wallet nova de ponta a ponta. Os testes controlam o
relógio (`Clock` injetado) para avançar além do lease sem esperar.

**Ordem: melhor esforço.** Dentro de um ciclo, eventos da mesma wallet saem na ordem gravada, e o
`MessageGroupId` por wallet mantém essa ordem dentro da fila FIFO. Dentro de um mesmo lote, uma
falha adia o evento que falhou e os seguintes da mesma wallet, que voltam juntos no ciclo seguinte.
Mas um evento posterior da mesma wallet (gravado depois da falha, ou fora do `LIMIT` do lote) pode
ser publicado no ciclo seguinte antes do que falhou, que ainda espera o backoff. Com vários
publishers, eventos da mesma wallet também podem sair fora de ordem (dois lotes da mesma
wallet reservados por instâncias diferentes; um lease vencido no meio de um envio lento). Por isso
`WalletBalanceChanged` carrega `walletVersion`, que o consumidor usa para ordenar ou descartar
eventos antigos. A garantia final de ordem é o `wallet_version` do ledger, não a fila.

## 12. Autenticação

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

## 13. Observabilidade e health checks

- Logs JSON (pino) com uma linha por requisição. O header `x-correlation-id` é aceito (se for um
  valor curto e seguro) ou gerado como UUIDv7, devolvido na resposta e incluído como
  `correlationId` em todas as linhas de log da requisição. `authorization`, cookies e o corpo da
  requisição são omitidos dos logs.
- `GET /health/live`: processo vivo, sem consultar dependências.
- `GET /health/ready`: `SELECT 1` no Postgres e `GetQueueUrl` nas três filas, em paralelo, cada
  verificação com timeout de 2 s; `503` indicando qual dependência está `down`. O cliente SQS não
  faz retry interno e tem timeout de conexão e de requisição, para não travar a verificação.

## 14. Limitações conhecidas

- `TRUNCATE` não dispara os triggers de linha que tornam o ledger append-only. Ele é usado apenas
  nos testes para limpar o banco; em produção o usuário da aplicação não deve ter permissão de
  `TRUNCATE`.
- Autenticação ainda não implementada (ver seção 12).
- Transações `PENDING_REFERENCE` são gravadas e respondidas com `202`, mas ainda não há um
  processo que as reprocesse quando a referência chega.
- O publisher da outbox tenta indefinidamente (backoff até 5 min) e não tem DLQ própria: um evento
  que nunca consegue ser publicado fica pendente, com `attempts` e `last_error` visíveis na tabela.
- O lease usa o relógio de cada instância (`Clock`), não o do banco: relógios das instâncias
  precisam estar sincronizados (NTP) com folga bem menor que o lease de 30 s. Um desvio maior só
  causa publicação duplicada (tratada pela deduplicação), nunca perda.
- Um crédito que levaria o saldo além de `NUMERIC(20,2)` não é validado no domínio: aparece como
  erro do banco (`500`) e nada é gravado.
- As linhas publicadas da outbox nunca são removidas; falta um job de retenção.
- Um lote reservado é publicado em sequência por wallet; se o SQS ficar lento (no pior caso cerca
  de 2,5 s por envio: 1 s para abrir a conexão mais 1,5 s esperando a resposta) e uma wallet tiver
  muitos eventos no mesmo lote, o envio pode passar do lease e outra instância reservar as mesmas
  linhas — resultado: duplicatas, absorvidas pela deduplicação.
- `@mikro-orm/nestjs` 6.1.2 declara peer dependencies para Nest `^10 || ^11`, e o projeto roda
  Nest 12. A integração funciona e é coberta pelos testes de integração; se uma versão futura
  quebrar, a alternativa é registrar à mão um provider de `MikroORM` (`MikroORM.init` +
  `orm.close()` no shutdown), sem o módulo.

## 15. Próximos passos

- **Métrica de outbox lag** (idade do evento pendente mais antigo) e de falhas de publicação, para
  alertar quando o SQS estiver fora ou um evento travar em retry.
- **Ordem estrita de eventos por wallet**: publicar por agregado em ordem de `wallet_version`
  (coluna de sequência na outbox e claim por agregado), em vez do melhor esforço atual.
- **Revisitar `403` vs `401`** quando a autenticação real estiver ativa: hoje o filtro de erros
  traduz ambos para o código `UNAUTHORIZED`. O desejado é token inválido ou ausente → `401`, e
  token válido de um provedor diferente do `providerId` do corpo → `403`, com código próprio.
