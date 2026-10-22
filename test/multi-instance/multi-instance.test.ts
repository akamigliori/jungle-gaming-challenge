import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Env } from '../../src/infrastructure/config/config';
import { CONSUMER_NAME } from '../../src/interfaces/sqs/wager-transactions.consumer';
import { resetDb, withTestDb } from '../integration/support/db';
import { assertLedgerInvariant } from '../integration/support/invariants';
import { createTestQueues, type TestQueues } from '../integration/support/queues';
import { waitFor } from '../integration/support/wait';
import {
  buildScenario,
  CURRENCY,
  INITIAL_BALANCE,
  POISON_BODY,
  type Scenario,
  type ScenarioWallet,
  type ScriptedMessage,
} from './scenario';
import { type Instance, killAll, startInstance } from './support/instances';

/**
 * Três processos reais da aplicação (`bun src/main.ts`) contra o mesmo Postgres e as mesmas filas
 * do LocalStack, com consumer, publisher da outbox e worker de pendências ligados. Durante o
 * processamento, uma instância leva `SIGKILL` e outra `SIGTERM`, e as duas são reiniciadas. No fim,
 * o estado tem de ser exatamente o que o roteiro determina: nada perdido, nada duplicado.
 */

const INSTANCES = 3;
const WALLETS = 10;
const HTTP_BET_REPEATS = 50;
/** Visibility curto para a mensagem em voo na instância morta voltar logo. */
const VISIBILITY_TIMEOUT_SECONDS = 5;
/** Alto o bastante para um `SIGKILL` + um `SIGTERM` nunca levarem mensagem saudável à DLQ. */
const MAX_RECEIVE_COUNT = 10;
const SIGTERM_DEADLINE_MS = 30_000;
const DRAIN_TIMEOUT_MS = 120_000;
const PROGRESS_POLL_MS = 50;
const KILL_AT_FRACTION = 1 / 3;
const TERM_AT_FRACTION = 2 / 3;
const MS_PER_SECOND = 1000;

let orm: MikroORM;
let queues: TestQueues;
const instances: Instance[] = [];

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

/** Ambiente comum aos processos: filas do teste, banco de teste e loops rápidos. */
function instanceEnv(): Env {
  return {
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DB_NAME: process.env.TEST_DB_NAME ?? 'wagering_test',
    SQS_TRANSACTIONS_QUEUE: queues.transactions,
    SQS_TRANSACTIONS_DLQ: queues.transactionsDlq,
    SQS_EVENTS_QUEUE: queues.events,
    SQS_CONSUMER_ENABLED: 'true',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    // long poll curto: o SIGTERM espera o que estiver em andamento
    SQS_WAIT_TIME_SECONDS: '1',
    SHUTDOWN_TIMEOUT_MS: '10000',
    OUTBOX_POLL_INTERVAL_MS: '100',
    // lease curto: o lote reservado pela instância morta volta logo para as outras
    OUTBOX_LEASE_MS: '3000',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
    // política de referência curta e sem desistência dentro do teste
    REFERENCE_RETRY_BASE_MS: '100',
    REFERENCE_RETRY_MAX_MS: '1000',
    REFERENCE_MAX_ATTEMPTS: '1000',
  };
}

async function start(n: number): Promise<Instance> {
  const instance = await startInstance(n, instanceEnv());
  instances[n - 1] = instance;
  return instance;
}

function instance(n: number): Instance {
  const found = instances[n - 1];
  if (!found) throw new Error(`instance ${n} not started`);
  return found;
}

/** Espalha as requisições entre as instâncias. */
const baseUrlFor = (i: number) => instance((i % INSTANCES) + 1).baseUrl;

async function createWallet(i: number): Promise<ScenarioWallet> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${baseUrlFor(i)}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: INITIAL_BALANCE, currency: CURRENCY },
    }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return { id, playerId };
}

/** Grupos em paralelo; dentro do grupo, em sequência (a ordem FIFO por wallet é a do roteiro). */
async function sendAll(messages: ScriptedMessage[]): Promise<void> {
  const groups = new Map<string, ScriptedMessage[]>();
  for (const m of messages) groups.set(m.groupId, [...(groups.get(m.groupId) ?? []), m]);
  await Promise.all(
    [...groups.values()].map(async (group) => {
      for (const m of group) await queues.send(m.body, { groupId: m.groupId, dedupId: m.dedupId });
    }),
  );
}

interface HttpBetResult {
  status: number;
  transactionId: string;
}

async function submitHttpBetRepeatedly(scenario: Scenario): Promise<HttpBetResult[]> {
  const { idempotencyKey, body } = scenario.httpBet;
  return Promise.all(
    Array.from({ length: HTTP_BET_REPEATS }, async (_, i) => {
      const res = await fetch(`${baseUrlFor(i)}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { transactionId: string };
      return { status: res.status, transactionId: json.transactionId };
    }),
  );
}

async function countOf(query: string, params: unknown[] = []): Promise<number> {
  const [row] = await sql<{ n: number }>(query, params);
  return row?.n ?? 0;
}

const inboxCount = () =>
  countOf('SELECT COUNT(*)::INT AS n FROM inbox_messages WHERE consumer_name = ?', [CONSUMER_NAME]);

async function waitInboxAtLeast(target: number, description: string): Promise<void> {
  await waitFor(async () => (await inboxCount()) >= target, description, {
    timeoutMs: DRAIN_TIMEOUT_MS,
    intervalMs: PROGRESS_POLL_MS,
  });
}

/** Fila principal vazia (visíveis + em voo), nenhuma pendência de referência, outbox publicada. */
async function drained(expectedInbox: number): Promise<boolean> {
  if ((await queues.depth('transactions')) > 0) return false;
  const pending = await countOf(
    `SELECT COUNT(*)::INT AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
  );
  const unpublished = await countOf(
    'SELECT COUNT(*)::INT AS n FROM outbox_messages WHERE published_at IS NULL',
  );
  return pending === 0 && unpublished === 0 && (await inboxCount()) === expectedInbox;
}

beforeAll(async () => {
  orm = await withTestDb();
  await resetDb(orm);
  queues = await createTestQueues({
    visibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
    maxReceiveCount: MAX_RECEIVE_COUNT,
  });
});

afterAll(async () => {
  // também em falha: nenhum processo da aplicação fica vivo depois da suíte
  await killAll();
  await queues?.destroy();
  await orm?.close(true);
});

describe('three instances with SIGKILL, SIGTERM and restart', () => {
  test("the final state is the script's: nothing lost, nothing duplicated", async () => {
    await Promise.all(Array.from({ length: INSTANCES }, (_, i) => start(i + 1)));
    const wallets = await Promise.all(Array.from({ length: WALLETS }, (_, i) => createWallet(i)));
    const scenario = buildScenario(wallets);
    const expectedInbox = scenario.validMessageIds.size;

    const startedAt = performance.now();
    const sending = sendAll(scenario.messages);
    const httpResults = await submitHttpBetRepeatedly(scenario);

    // SIGKILL no meio do processamento: o que estava em voo volta pelo visibility timeout
    await waitInboxAtLeast(Math.ceil(expectedInbox * KILL_AT_FRACTION), 'a third processed');
    const killedAt = await inboxCount();
    await instance(2).kill('SIGKILL');
    await start(2);

    // SIGTERM mais adiante: o processo termina o que tem em mão e sai com 0 dentro do prazo
    await waitInboxAtLeast(Math.ceil(expectedInbox * TERM_AT_FRACTION), 'two thirds processed');
    const terminatedAt = await inboxCount();
    const termAt = performance.now();
    const exitCode = await instance(3).kill('SIGTERM');
    const termMs = performance.now() - termAt;
    expect(exitCode).toBe(0);
    expect(termMs).toBeLessThan(SIGTERM_DEADLINE_MS);
    await start(3);

    await sending;
    await waitFor(() => drained(expectedInbox), 'queue drained and state settled', {
      timeoutMs: DRAIN_TIMEOUT_MS,
      intervalMs: PROGRESS_POLL_MS * 4,
    });
    const elapsedSeconds = (performance.now() - startedAt) / MS_PER_SECOND;

    // invariantes do ledger (saldo = Σ lançamentos, versões contínuas, cadeia de saldos)
    await assertLedgerInvariant(orm);

    // saldo de cada wallet igual ao calculado pelo roteiro
    const balances = await sql<{ id: string; balance: string }>(
      'SELECT id, balance::TEXT AS balance FROM wallets',
    );
    expect(new Map(balances.map((b) => [b.id, b.balance]))).toEqual(scenario.expectedBalance);

    // cada operação gravada uma única vez, e todas processadas
    expect(
      await sql(
        `SELECT provider_id, idempotency_key, COUNT(*) AS n
           FROM wager_transactions
          GROUP BY provider_id, idempotency_key
         HAVING COUNT(*) > 1`,
      ),
    ).toEqual([]);
    const byStatus = await sql<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::INT AS n FROM wager_transactions WHERE kind <> 'OPENING' GROUP BY status`,
    );
    expect(byStatus).toEqual([{ status: 'PROCESSED', n: scenario.operationCount }]);

    // uma linha de inbox por messageId válido (as reentregas não somam)
    expect(await inboxCount()).toBe(expectedInbox);

    // DLQ com exatamente a mensagem venenosa
    const deadLetters = await queues.receiveAll('transactionsDlq');
    expect(deadLetters.map((m) => m.Body)).toEqual([POISON_BODY]);

    // a mesma BET 50× por HTTP, nas três instâncias: uma transação, um débito
    const transactionIds = new Set(httpResults.map((r) => r.transactionId));
    expect(transactionIds.size).toBe(1);
    expect(httpResults.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(
      await countOf(
        `SELECT COUNT(*)::INT AS n
           FROM wallet_ledger_entries l
           JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE t.provider_id = ? AND t.external_transaction_id = ?`,
        [scenario.httpBet.body.providerId, scenario.httpBet.body.externalTransactionId],
      ),
    ).toBe(1);

    // todo evento da outbox chegou à fila de eventos (ao menos uma vez)
    const outboxIds = (await sql<{ id: string }>('SELECT id FROM outbox_messages')).map(
      (r) => r.id,
    );
    const published = new Set(
      (await queues.receiveAll('events')).map(
        (m) => (JSON.parse(m.Body ?? '{}') as { eventId?: string }).eventId,
      ),
    );
    expect(outboxIds.filter((id) => !published.has(id))).toEqual([]);

    const rate = (expectedInbox / elapsedSeconds).toFixed(1);
    console.log(
      `multi-instance: ${expectedInbox} messages + ${HTTP_BET_REPEATS} HTTP requests drained in ` +
        `${elapsedSeconds.toFixed(1)} s (${rate} messages/s, SIGKILL at ${killedAt} and SIGTERM at ${terminatedAt} processed, ` +
        `SIGTERM exit in ${Math.round(termMs)} ms)`,
    );
  });
});
