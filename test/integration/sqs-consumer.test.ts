import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { LockWaitTimeoutException } from '@mikro-orm/core';
import { EntityManager, type MikroORM } from '@mikro-orm/postgresql';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../src/application/ports/wallet.repository';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { APP_CONFIG, type AppConfig } from '../../src/infrastructure/config/config';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository';
import { createSqsClient, SQS_CLIENT } from '../../src/infrastructure/sqs/sqs.client';
import { CONSUMER_NAME } from '../../src/interfaces/sqs/wager-transactions.consumer';
import { createTestApp, type OverrideProviders, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';
import { createTestQueues, type TestQueues } from './support/queues';
import { waitFor } from './support/wait';

const VISIBILITY_TIMEOUT_SECONDS = 2;
const MAX_RECEIVE_COUNT = 3;
const PROVIDER_ID = 'provider-a';

let orm: MikroORM;
let queues: TestQueues;
let t: TestApp;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

/** Dono de cada wallet criada, para as mensagens usarem o jogador certo. */
const playerOf = new Map<string, string>();

async function createWallet(amount = '100.00'): Promise<string> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${t.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  playerOf.set(id, playerId);
  return id;
}

interface BetOptions {
  externalTransactionId?: string;
  amount?: unknown;
}

function betData(walletId: string, o: BetOptions = {}) {
  const externalTransactionId = o.externalTransactionId ?? `bet-${crypto.randomUUID()}`;
  return {
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: playerOf.get(walletId) ?? crypto.randomUUID(),
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: o.amount ?? '25.00', currency: 'BRL' },
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
  };
}

function envelope(data: Record<string, unknown>, messageId: string = crypto.randomUUID()) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  };
}

async function transactionsOf(externalTransactionId: string) {
  return sql<{ status: string; wallet_id: string }>(
    'SELECT status, wallet_id FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
    [PROVIDER_ID, externalTransactionId],
  );
}

async function inboxRows(messageId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    'SELECT COUNT(*)::INT AS n FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
    [CONSUMER_NAME, messageId],
  );
  return row?.n ?? 0;
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql<{ balance: string }>(
    'SELECT balance::TEXT AS balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return row?.balance ?? '';
}

async function debitsOf(walletId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    `SELECT COUNT(*)::INT AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
    [walletId],
  );
  return row?.n ?? 0;
}

async function waitProcessed(externalTransactionId: string): Promise<void> {
  await waitFor(
    async () => (await transactionsOf(externalTransactionId)).length > 0,
    `transaction ${externalTransactionId}`,
  );
}

async function waitQueueEmpty(q: TestQueues = queues): Promise<void> {
  await waitFor(async () => (await q.depth('transactions')) === 0, 'empty transactions queue');
}

/** Drena a DLQ até `count` mensagens chegarem. */
async function waitDeadLetters(count: number, q: TestQueues = queues): Promise<Message[]> {
  const received: Message[] = [];
  await waitFor(async () => {
    received.push(...(await q.receiveAll('transactionsDlq')));
    return received.length >= count;
  }, `${count} dead-lettered messages`);
  return received;
}

const failureCodeOf = (m: Message | undefined) => m?.MessageAttributes?.failureCode?.StringValue;

beforeAll(async () => {
  orm = await withTestDb();
  // o consumer roda em segundo plano: o banco é limpo uma vez, antes de ele subir
  await resetDb(orm);
  queues = await createTestQueues({
    visibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
    maxReceiveCount: MAX_RECEIVE_COUNT,
  });
  t = await createTestApp({
    SQS_CONSUMER_ENABLED: 'true',
    SQS_TRANSACTIONS_QUEUE: queues.transactions,
    SQS_TRANSACTIONS_DLQ: queues.transactionsDlq,
    SQS_EVENTS_QUEUE: queues.events,
    SQS_WAIT_TIME_SECONDS: '1',
  });
});

afterEach(async () => {
  await assertLedgerInvariant(orm);
});

afterAll(async () => {
  await t.close();
  await queues.destroy();
  await orm.close(true);
});

describe('SQS consumer', () => {
  test('a valid message is processed, recorded in the inbox and removed from the queue', async () => {
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);

    await queues.send(message, { groupId: walletId });

    await waitProcessed(data.externalTransactionId);
    await waitQueueEmpty();
    expect(await transactionsOf(data.externalTransactionId)).toEqual([
      { status: 'PROCESSED', wallet_id: walletId },
    ]);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
  });

  test('a redelivered message (same messageId) debits once and both deliveries are acked', async () => {
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);

    await queues.send(message, { groupId: walletId });
    await waitProcessed(data.externalTransactionId);
    await waitQueueEmpty();
    await queues.send(message, { groupId: walletId, dedupId: `${message.messageId}-again` });
    await waitQueueEmpty();

    expect(await debitsOf(walletId)).toBe(1);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await queues.receiveAll('transactionsDlq')).toEqual([]);
  });

  test('the same messageId with a different payload goes to the DLQ as IDEMPOTENCY_CONFLICT', async () => {
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);
    await queues.send(message, { groupId: walletId });
    await waitProcessed(data.externalTransactionId);

    const conflicting = envelope(
      { ...data, money: { amount: '30.00', currency: 'BRL' } },
      message.messageId,
    );
    await queues.send(conflicting, { groupId: walletId, dedupId: crypto.randomUUID() });

    const [dead] = await waitDeadLetters(1);
    expect(failureCodeOf(dead)).toBe('IDEMPOTENCY_CONFLICT');
    expect(dead?.Body).toBe(JSON.stringify(conflicting));
    expect(dead?.Attributes?.MessageGroupId).toBe(walletId);
    expect(dead?.MessageAttributes?.failedAt?.StringValue).toBeString();
    await waitQueueEmpty();
    expect(await debitsOf(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
  });

  test('invalid messages go to the DLQ on the first delivery and nothing is written', async () => {
    const walletId = await createWallet();
    const numericAmount = betData(walletId, { amount: 25 });
    const unknownWallet = betData(crypto.randomUUID());
    const numericMessage = envelope(numericAmount);
    const unknownWalletMessage = envelope(unknownWallet);

    await queues.send('{', { groupId: crypto.randomUUID(), dedupId: crypto.randomUUID() });
    await queues.send(numericMessage, { groupId: walletId });
    await queues.send(unknownWalletMessage, { groupId: unknownWallet.walletId });

    const dead = await waitDeadLetters(3);
    const codeByBody = new Map(dead.map((m) => [m.Body, failureCodeOf(m)]));
    expect(codeByBody.get('{')).toBe('INVALID_PAYLOAD');
    expect(codeByBody.get(JSON.stringify(numericMessage))).toBe('INVALID_PAYLOAD');
    expect(codeByBody.get(JSON.stringify(unknownWalletMessage))).toBe('WALLET_NOT_FOUND');
    await waitQueueEmpty();
    expect(await transactionsOf(numericAmount.externalTransactionId)).toEqual([]);
    expect(await transactionsOf(unknownWallet.externalTransactionId)).toEqual([]);
    expect(await inboxRows(numericMessage.messageId)).toBe(0);
    expect(await inboxRows(unknownWalletMessage.messageId)).toBe(0);
    expect(await balanceOf(walletId)).toBe('100.00');
  });

  test('the same bet via HTTP and then via SQS debits once and the message is acked', async () => {
    const walletId = await createWallet();
    const { idempotencyKey, ...body } = betData(walletId);
    const res = await fetch(`${t.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);

    const message = envelope({ ...body, idempotencyKey });
    await queues.send(message, { groupId: walletId });

    await waitFor(async () => (await inboxRows(message.messageId)) === 1, 'inbox row');
    await waitQueueEmpty();
    expect(await transactionsOf(body.externalTransactionId)).toHaveLength(1);
    expect(await debitsOf(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await queues.receiveAll('transactionsDlq')).toEqual([]);
  });
});

/** Execuções do caso de uso por entrega: ele mesmo refaz até 3 vezes um erro transitório. */
const USE_CASE_ATTEMPTS_PER_DELIVERY = 3;
/** Lock lento o bastante para o shutdown acontecer no meio do processamento. */
const SLOW_LOCK_MS = 1500;
/** Visibility longo: o que voltar para a fila antes disso foi devolvido pelo consumer. */
const LONG_VISIBILITY_TIMEOUT_SECONDS = 30;
const SHORT_WAIT_TIME_SECONDS = 1;
/** Long poll que ainda está aberto quando o shutdown começa. */
const SHUTDOWN_POLL_WAIT_TIME_SECONDS = 2;
/** Folga para o shutdown chegar ao consumer (os hooks anteriores do Nest rodam antes). */
const SHUTDOWN_STARTED_MS = 300;

const lockTimeout = () =>
  new LockWaitTimeoutException(Object.assign(new Error('lock timeout'), { code: '55P03' }));

/**
 * Repositório de wallet real com o `lockById` interceptado: `lockById(id, lock)` decide se lança,
 * espera ou chama o lock de verdade.
 */
function interceptLock(
  lockById: (walletId: string, lock: () => Promise<Wallet | null>) => Promise<Wallet | null>,
): OverrideProviders {
  return (builder) =>
    builder.overrideProvider(WALLET_REPOSITORY).useFactory({
      inject: [EntityManager],
      factory: (em: EntityManager): WalletRepository => {
        const real = new MikroOrmWalletRepository(em);
        return {
          add: (wallet) => real.add(wallet),
          findById: (id) => real.findById(id),
          save: (wallet, expectedVersion) => real.save(wallet, expectedVersion),
          lockById: (id) => lockById(id, () => real.lockById(id)),
        };
      },
    });
}

/** Cliente SQS real que finge confirmar o `DeleteMessage`: simula a morte entre COMMIT e ack. */
const swallowDeletes: OverrideProviders = (builder) =>
  builder.overrideProvider(SQS_CLIENT).useFactory({
    inject: [APP_CONFIG],
    factory: (config: AppConfig): SQSClient => {
      const sqs = createSqsClient(config);
      return new Proxy(sqs, {
        get(target, property) {
          if (property !== 'send') return Reflect.get(target, property, target);
          return (command: unknown, options?: unknown) =>
            command instanceof DeleteMessageCommand
              ? Promise.resolve({})
              : (target.send as (c: unknown, o?: unknown) => Promise<unknown>)(command, options);
        },
      });
    },
  });

/** Cliente SQS real que avisa quando o primeiro long poll é enviado. */
function notifyFirstReceive(onReceive: () => void): OverrideProviders {
  return (builder) =>
    builder.overrideProvider(SQS_CLIENT).useFactory({
      inject: [APP_CONFIG],
      factory: (config: AppConfig): SQSClient => {
        const sqs = createSqsClient(config);
        return new Proxy(sqs, {
          get(target, property) {
            if (property !== 'send') return Reflect.get(target, property, target);
            return (command: unknown, options?: unknown) => {
              if (command instanceof ReceiveMessageCommand) onReceive();
              return (target.send as (c: unknown, o?: unknown) => Promise<unknown>)(
                command,
                options,
              );
            };
          },
        });
      },
    });
}

async function wagerRows(walletId: string) {
  return sql<{ external_transaction_id: string; status: string; failure_code: string | null }>(
    'SELECT external_transaction_id, status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = ? ORDER BY created_at, id',
    [walletId, 'BET'],
  );
}

describe('SQS consumer — order, retries, crash and shutdown', () => {
  let ownQueues: TestQueues[] = [];
  let apps: TestApp[] = [];

  async function newQueues(visibilityTimeout = VISIBILITY_TIMEOUT_SECONDS): Promise<TestQueues> {
    const q = await createTestQueues({ visibilityTimeout, maxReceiveCount: MAX_RECEIVE_COUNT });
    ownQueues.push(q);
    return q;
  }

  /** Instância com o consumer ligado nas filas `q`; as mensagens já devem estar na fila. */
  async function startConsumer(
    q: TestQueues,
    overrides?: OverrideProviders,
    waitTimeSeconds = SHORT_WAIT_TIME_SECONDS,
  ): Promise<TestApp> {
    const app = await createTestApp(
      {
        SQS_CONSUMER_ENABLED: 'true',
        SQS_TRANSACTIONS_QUEUE: q.transactions,
        SQS_TRANSACTIONS_DLQ: q.transactionsDlq,
        SQS_EVENTS_QUEUE: q.events,
        // o shutdown espera o long poll em andamento terminar: espera curta deixa o app.close() rápido
        SQS_WAIT_TIME_SECONDS: String(waitTimeSeconds),
      },
      overrides,
    );
    apps.push(app);
    return app;
  }

  /** Desliga a instância no meio do teste (como um `SIGTERM`). */
  async function stop(app: TestApp): Promise<void> {
    apps = apps.filter((other) => other !== app);
    await app.close();
  }

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await Promise.all(ownQueues.map((q) => q.destroy()));
    apps = [];
    ownQueues = [];
  });

  test('a transient failure stops the wallet group: the next message waits and FIFO order holds', async () => {
    const q = await newQueues();
    const walletId = await createWallet('100.00');
    const first = betData(walletId, { amount: '80.00' });
    const second = betData(walletId, { amount: '30.00' });
    await q.send(envelope(first), { groupId: walletId });
    await q.send(envelope(second), { groupId: walletId });

    let calls = 0;
    await startConsumer(
      q,
      interceptLock(async (_id, lock) => {
        calls += 1;
        // a 1ª entrega esgota as tentativas do caso de uso e volta para a fila com backoff
        if (calls <= USE_CASE_ATTEMPTS_PER_DELIVERY) throw lockTimeout();
        return lock();
      }),
    );

    await waitFor(async () => (await wagerRows(walletId)).length === 2, 'both bets recorded');
    await waitQueueEmpty(q);
    expect(await wagerRows(walletId)).toEqual([
      {
        external_transaction_id: first.externalTransactionId,
        status: 'PROCESSED',
        failure_code: null,
      },
      {
        external_transaction_id: second.externalTransactionId,
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
      },
    ]);
    expect(await balanceOf(walletId)).toBe('20.00');
  });

  test('a transient failure that clears up is processed on a later delivery, without the DLQ', async () => {
    const q = await newQueues();
    const walletId = await createWallet();
    const data = betData(walletId);
    await q.send(envelope(data), { groupId: walletId });

    let calls = 0;
    await startConsumer(
      q,
      interceptLock(async (_id, lock) => {
        calls += 1;
        // as 2 primeiras entregas falham; a 3ª encontra o banco de volta
        if (calls <= 2 * USE_CASE_ATTEMPTS_PER_DELIVERY) throw lockTimeout();
        return lock();
      }),
    );

    await waitProcessed(data.externalTransactionId);
    await waitQueueEmpty(q);
    expect(await transactionsOf(data.externalTransactionId)).toEqual([
      { status: 'PROCESSED', wallet_id: walletId },
    ]);
    expect(calls).toBe(2 * USE_CASE_ATTEMPTS_PER_DELIVERY + 1);
    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await q.receiveAll('transactionsDlq')).toEqual([]);
  });

  test('an unexpected error goes to the DLQ as INTERNAL_ERROR on the 3rd delivery', async () => {
    const q = await newQueues();
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);
    await q.send(message, { groupId: walletId });

    let deliveries = 0;
    await startConsumer(
      q,
      interceptLock(async () => {
        // erro não transitório: o caso de uso não refaz, então cada chamada é uma entrega
        deliveries += 1;
        throw new InvariantViolationError('simulated bug');
      }),
    );

    const [dead] = await waitDeadLetters(1, q);
    expect(failureCodeOf(dead)).toBe('INTERNAL_ERROR');
    expect(dead?.Body).toBe(JSON.stringify(message));
    await waitQueueEmpty(q);
    expect(deliveries).toBe(MAX_RECEIVE_COUNT);
    expect(await transactionsOf(data.externalTransactionId)).toEqual([]);
    expect(await inboxRows(message.messageId)).toBe(0);
    expect(await balanceOf(walletId)).toBe('100.00');
  });

  test('an instance that dies after COMMIT and before the ack: another one acks it without a second effect', async () => {
    const q = await newQueues();
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);
    await q.send(message, { groupId: walletId });

    const crashing = await startConsumer(q, swallowDeletes);
    await waitProcessed(data.externalTransactionId);
    await stop(crashing);
    // sem ack, a mensagem continua na fila e reaparece depois do visibility timeout
    expect(await q.depth('transactions')).toBe(1);

    await startConsumer(q);
    await waitQueueEmpty(q);

    const [transaction] = await sql<{ id: string; status: string }>(
      'SELECT id, status FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
      [PROVIDER_ID, data.externalTransactionId],
    );
    expect(transaction?.status).toBe('PROCESSED');
    expect(await debitsOf(walletId)).toBe(1);
    expect(await inboxRows(message.messageId)).toBe(1);
    const events = await sql<{ event_type: string; n: number }>(
      `SELECT event_type, COUNT(*)::INT AS n FROM outbox_messages
       WHERE payload->'data'->>'transactionId' = ? GROUP BY event_type ORDER BY event_type`,
      [transaction?.id],
    );
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', n: 1 },
      { event_type: 'WalletBalanceChanged', n: 1 },
    ]);
    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await q.receiveAll('transactionsDlq')).toEqual([]);
  });

  test('on shutdown the message in progress finishes and is acked; unstarted ones go back to the queue', async () => {
    const q = await newQueues(LONG_VISIBILITY_TIMEOUT_SECONDS);
    const walletId = await createWallet();
    const inProgress = betData(walletId);
    const unstarted = betData(walletId);
    await q.send(envelope(inProgress), { groupId: walletId });
    await q.send(envelope(unstarted), { groupId: walletId });

    let started = 0;
    const stopping = await startConsumer(
      q,
      interceptLock(async (_id, lock) => {
        started += 1;
        await Bun.sleep(SLOW_LOCK_MS);
        return lock();
      }),
    );
    await waitFor(() => started === 1, 'processing started');
    await stop(stopping);

    expect(started).toBe(1);
    expect(await transactionsOf(inProgress.externalTransactionId)).toEqual([
      { status: 'PROCESSED', wallet_id: walletId },
    ]);
    expect(await transactionsOf(unstarted.externalTransactionId)).toEqual([]);
    // a em andamento recebeu ack; a não iniciada está visível bem antes dos 30 s do visibility
    expect(await q.depth('transactions')).toBe(1);
    expect(await q.visible('transactions')).toBe(1);

    await startConsumer(q);
    await waitProcessed(unstarted.externalTransactionId);
    await waitQueueEmpty(q);
    expect(await balanceOf(walletId)).toBe('50.00');
  });

  test('shutdown lets the long poll in progress finish: a message it receives goes back visible', async () => {
    const q = await newQueues(LONG_VISIBILITY_TIMEOUT_SECONDS);
    const walletId = await createWallet();
    const data = betData(walletId);
    const polling = Promise.withResolvers<void>();

    const stopping = await startConsumer(
      q,
      notifyFirstReceive(() => polling.resolve()),
      SHUTDOWN_POLL_WAIT_TIME_SECONDS,
    );
    await polling.promise;
    // a mensagem chega com o shutdown já em curso, bem antes de o long poll de 2 s vencer: ou ele a
    // recebe e o grupo a devolve com visibilidade 0, ou o laço já parou e ela nem é recebida
    const closing = stop(stopping);
    await Bun.sleep(SHUTDOWN_STARTED_MS);
    await q.send(envelope(data), { groupId: walletId });
    await closing;

    // um long poll abortado poderia recebê-la sem ninguém ler: ficaria escondida por 30 s
    expect(await transactionsOf(data.externalTransactionId)).toEqual([]);
    expect(await q.depth('transactions')).toBe(1);
    expect(await q.visible('transactions')).toBe(1);

    await startConsumer(q);
    await waitProcessed(data.externalTransactionId);
    await waitQueueEmpty(q);
    expect(await balanceOf(walletId)).toBe('75.00');
  });
});
