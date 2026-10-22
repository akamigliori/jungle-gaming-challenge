import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CLOCK, type Clock } from '../../src/application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from '../../src/application/ports/id-generator';
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
} from '../../src/application/ports/ledger.repository';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '../../src/application/ports/outbox.repository';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../src/application/ports/transaction-runner';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../../src/application/ports/wager-transaction.repository';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../src/application/ports/wallet.repository';
import {
  type ProcessWagerCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/wager/process-wager-transaction.use-case';
import { ResolvePendingReferenceUseCase } from '../../src/application/wager/resolve-pending-reference.use-case';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status';
import { isTransientDbError } from '../../src/infrastructure/persistence/pg-errors';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';
import { createTestQueues, type TestQueues } from './support/queues';
import { waitFor } from './support/wait';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const PROVIDER_ID = 'provider-a';
const POLL_INTERVAL_MS = 200;
/** Política curta: esperas de 100, 200 e 400 ms; a 3ª reavaliação desiste. */
const SHORT_RETRY = {
  REFERENCE_RETRY_BASE_MS: '100',
  REFERENCE_RETRY_MAX_MS: '400',
  REFERENCE_MAX_ATTEMPTS: '3',
};
const RETRY_POLICY = { baseMs: 100, maxMs: 400, maxAttempts: 3 };

let orm: MikroORM;
let t: TestApp;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

async function createWallet(amount = '100.00'): Promise<string> {
  const wallet = await t.app.get(CreateWalletUseCase).execute({
    playerId: PLAYER_ID,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'create-wallet',
  });
  return wallet.id;
}

function command(walletId: string, over: Partial<ProcessWagerCommand> = {}): ProcessWagerCommand {
  const externalTransactionId = over.externalTransactionId ?? 'bet-1';
  return {
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: 'corr-1',
    ...over,
  };
}

const refundOf = (walletId: string, reference: string, external = `refund-of-${reference}`) =>
  command(walletId, {
    externalTransactionId: external,
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: reference,
  });

function submit(cmd: ProcessWagerCommand) {
  return t.app.get(ProcessWagerTransactionUseCase).execute(cmd);
}

interface Row {
  status: string;
  failure_code: string | null;
  reference_attempts: number;
  processed_at: string | null;
}

async function rowOf(id: string): Promise<Row | undefined> {
  const [row] = await sql<Row>(
    `SELECT status, failure_code, reference_attempts, processed_at
       FROM wager_transactions WHERE id = ?`,
    [id],
  );
  return row;
}

async function nextAttemptOf(id: string): Promise<number> {
  const [row] = await sql<{ next_attempt: string }>(
    'SELECT next_reference_attempt_at AS next_attempt FROM wager_transactions WHERE id = ?',
    [id],
  );
  return new Date(row?.next_attempt ?? 0).getTime();
}

async function waitStatus(id: string, status: string, timeoutMs?: number): Promise<Row> {
  let last: Row | undefined;
  await waitFor(
    async () => {
      last = await rowOf(id);
      return last?.status === status;
    },
    `transaction ${id} ${status}`,
    { timeoutMs, intervalMs: 20 },
  );
  if (!last) throw new Error('unreachable');
  return last;
}

/**
 * Empurra a próxima tentativa de uma pendência recém-criada para daqui a 1 hora: só um "acordar"
 * pode trazê-la de volta no tempo do teste. Falha se o worker já a tiver tocado.
 */
async function postpone(id: string): Promise<void> {
  const rows = await sql(
    `UPDATE wager_transactions SET next_reference_attempt_at = NOW() + INTERVAL '1 hour'
      WHERE id = ? AND status = 'PENDING_REFERENCE' AND reference_attempts = 0
      RETURNING id`,
    [id],
  );
  expect(rows).toHaveLength(1);
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql<{ balance: string }>(
    'SELECT balance::TEXT AS balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return row?.balance ?? '';
}

async function outboxOf(transactionId: string) {
  return sql<{ event_type: string; correlation_id: string }>(
    `SELECT event_type, payload->>'correlationId' AS correlation_id FROM outbox_messages
      WHERE payload->'data'->>'transactionId' = ? ORDER BY event_type`,
    [transactionId],
  );
}

async function ledgerCountOf(transactionId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    'SELECT COUNT(*)::INT AS n FROM wallet_ledger_entries WHERE transaction_id = ?',
    [transactionId],
  );
  return row?.n ?? 0;
}

async function ledgerVersionOf(transactionId: string): Promise<number> {
  const [row] = await sql<{ v: number }>(
    'SELECT wallet_version AS v FROM wallet_ledger_entries WHERE transaction_id = ?',
    [transactionId],
  );
  return row?.v ?? -1;
}

beforeAll(async () => {
  orm = await withTestDb();
});

afterAll(async () => {
  await orm.close(true);
});

describe('pending references resolved by the worker', () => {
  let queues: TestQueues;

  beforeAll(async () => {
    queues = await createTestQueues({ visibilityTimeout: 2, maxReceiveCount: 3 });
    t = await createTestApp({
      ...SHORT_RETRY,
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      PENDING_REFERENCE_POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
      SQS_CONSUMER_ENABLED: 'true',
      SQS_TRANSACTIONS_QUEUE: queues.transactions,
      SQS_TRANSACTIONS_DLQ: queues.transactionsDlq,
      SQS_EVENTS_QUEUE: queues.events,
      SQS_WAIT_TIME_SECONDS: '1',
    });
  });

  // entre os testes a fila está vazia e o worker, no máximo, reservando: o TRUNCATE só espera
  beforeEach(async () => {
    await resetDb(orm);
  });

  afterEach(async () => {
    await assertLedgerInvariant(orm);
  });

  afterAll(async () => {
    await t.close();
    await queues.destroy();
  });

  test('REFUND before its BET → the BET wakes it and the REFUND is PROCESSED with its events', async () => {
    const walletId = await createWallet();
    const refund = await submit(refundOf(walletId, 'bet-1'));
    expect(refund.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    await postpone(refund.transaction.id);

    const bet = await submit(command(walletId));
    expect(bet.transaction.status).toBe(WagerTransactionStatus.Processed);

    await waitStatus(refund.transaction.id, 'PROCESSED');
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await ledgerCountOf(refund.transaction.id)).toBe(1);
    const events = await outboxOf(refund.transaction.id);
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    // o evento da resolução é correlacionado pela própria transação pendente
    const resolution = events.filter((e) => e.event_type !== 'WagerTransactionPendingReference');
    expect(resolution.map((e) => e.correlation_id)).toEqual([
      refund.transaction.id,
      refund.transaction.id,
    ]);
  });

  test('a reference that never arrives → REJECTED REFERENCE_NOT_FOUND after the attempt limit', async () => {
    const walletId = await createWallet();
    const refund = await submit(refundOf(walletId, 'never-sent'));

    const row = await waitStatus(refund.transaction.id, 'REJECTED', 5000);
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    // duas reavaliações reagendaram; a terceira desistiu sem contar
    expect(row.reference_attempts).toBe(2);
    expect((await outboxOf(refund.transaction.id)).map((e) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(walletId)).toBe('100.00');
  });

  test('chain: WIN(BET) and ROLLBACK(WIN) before the BET → both PROCESSED, in order', async () => {
    const walletId = await createWallet();
    const win = await submit(
      command(walletId, {
        externalTransactionId: 'win-1',
        kind: WagerTransactionKind.Win,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    // a referência existe, mas ainda está pendente: o ROLLBACK espera em vez de ser rejeitado
    const rollback = await submit(
      command(walletId, {
        externalTransactionId: 'rollback-1',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win-1',
      }),
    );
    expect(win.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rollback.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    await postpone(win.transaction.id);
    await postpone(rollback.transaction.id);

    await submit(command(walletId));

    await waitStatus(rollback.transaction.id, 'PROCESSED');
    expect((await rowOf(win.transaction.id))?.status).toBe('PROCESSED');
    expect(await ledgerVersionOf(win.transaction.id)).toBeLessThan(
      await ledgerVersionOf(rollback.transaction.id),
    );
    // 100 − 25 (BET) + 40 (WIN) − 40 (ROLLBACK do WIN)
    expect(await balanceOf(walletId)).toBe('75.00');
  });

  test('a reference that ends REJECTED → the dependent is woken and becomes REFERENCE_NOT_PROCESSED without waiting for the backoff', async () => {
    const walletId = await createWallet();
    const refund = await submit(refundOf(walletId, 'bet-1'));
    await postpone(refund.transaction.id);

    const bet = await submit(command(walletId, { money: { amount: '150.00', currency: 'BRL' } }));
    expect(bet.transaction.status).toBe(WagerTransactionStatus.Rejected);

    // a pendência foi empurrada para daqui a 1 hora: só o "acordar" a traz de volta a tempo
    const row = await waitStatus(refund.transaction.id, 'REJECTED', 3000);
    expect(row.failure_code).toBe('REFERENCE_NOT_PROCESSED');
    expect(row.reference_attempts).toBe(0);
  });

  test('via SQS: REFUND then BET in the same group → both PROCESSED', async () => {
    const walletId = await createWallet();
    const envelope = (data: ProcessWagerCommand) => {
      const { correlationId: _ignored, ...body } = data;
      return {
        messageId: crypto.randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: body,
      };
    };
    await queues.send(envelope(refundOf(walletId, 'bet-1')), { groupId: walletId });
    await queues.send(envelope(command(walletId)), { groupId: walletId });

    const byExternal = async (external: string) => {
      const [row] = await sql<{ status: string }>(
        'SELECT status FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
        [PROVIDER_ID, external],
      );
      return row?.status;
    };
    await waitFor(
      async () => (await byExternal('refund-of-bet-1')) === 'PROCESSED',
      'REFUND processed',
    );
    expect(await byExternal('bet-1')).toBe('PROCESSED');
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await queues.receiveAll('transactionsDlq')).toEqual([]);
  });
});

describe('ResolvePendingReferenceUseCase', () => {
  beforeAll(async () => {
    t = await createTestApp(SHORT_RETRY);
  });

  beforeEach(async () => {
    await resetDb(orm);
  });

  afterEach(async () => {
    await assertLedgerInvariant(orm);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Outra instância do caso de uso sobre os mesmos adaptadores, como se fosse outro processo. */
  function anotherInstance(): ResolvePendingReferenceUseCase {
    return new ResolvePendingReferenceUseCase({
      transactionRunner: t.app.get<TransactionRunner>(TRANSACTION_RUNNER),
      wallets: t.app.get<WalletRepository>(WALLET_REPOSITORY),
      transactions: t.app.get<WagerTransactionRepository>(WAGER_TRANSACTION_REPOSITORY),
      ledger: t.app.get<LedgerRepository>(LEDGER_REPOSITORY),
      outbox: t.app.get<OutboxRepository>(OUTBOX_REPOSITORY),
      ids: t.app.get<IdGenerator>(ID_GENERATOR),
      clock: t.app.get<Clock>(CLOCK),
      isTransient: isTransientDbError,
      referenceRetry: RETRY_POLICY,
    });
  }

  test('two instances on the same due pending → one credit, the other is skipped', async () => {
    const walletId = await createWallet();
    const refund = await submit(refundOf(walletId, 'bet-1'));
    await submit(command(walletId));
    const target = { transactionId: refund.transaction.id, walletId };

    const results = await Promise.all([
      t.app.get(ResolvePendingReferenceUseCase).execute(target),
      anotherInstance().execute(target),
    ]);

    expect([...results].sort()).toEqual(['resolved', 'skipped']);
    expect(await ledgerCountOf(refund.transaction.id)).toBe(1);
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(
      (await outboxOf(refund.transaction.id)).filter(
        (e) => e.event_type === 'WagerTransactionProcessed',
      ),
    ).toHaveLength(1);
  });

  test('a reschedule writes no event and wakes nobody', async () => {
    const walletId = await createWallet();
    const refund = await submit(refundOf(walletId, 'bet-1'));
    const rollback = await submit(
      command(walletId, {
        externalTransactionId: 'rollback-1',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: refund.transaction.externalTransactionId,
      }),
    );
    await postpone(rollback.transaction.id);
    const rollbackNextAttempt = await nextAttemptOf(rollback.transaction.id);
    const before = Date.now();

    const result = await t.app
      .get(ResolvePendingReferenceUseCase)
      .execute({ transactionId: refund.transaction.id, walletId });

    expect(result).toBe('rescheduled');
    const row = await rowOf(refund.transaction.id);
    expect(row?.status).toBe('PENDING_REFERENCE');
    expect(row?.reference_attempts).toBe(1);
    // segunda espera da política: base × 2^1
    expect(await nextAttemptOf(refund.transaction.id)).toBeGreaterThanOrEqual(before + 200);
    expect((await outboxOf(refund.transaction.id)).map((e) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(await nextAttemptOf(rollback.transaction.id)).toBe(rollbackNextAttempt);
  });

  test('a transaction that is no longer pending is skipped', async () => {
    const walletId = await createWallet();
    const bet = await submit(command(walletId));
    const result = await t.app
      .get(ResolvePendingReferenceUseCase)
      .execute({ transactionId: bet.transaction.id, walletId });
    expect(result).toBe('skipped');
  });

  test('replay of a pending transaction resolved later returns the final state', async () => {
    const walletId = await createWallet();
    const cmd = refundOf(walletId, 'bet-1');
    const refund = await submit(cmd);
    await submit(command(walletId));
    await t.app
      .get(ResolvePendingReferenceUseCase)
      .execute({ transactionId: refund.transaction.id, walletId });

    const replay = await submit(cmd);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.transaction.balanceAfter?.toJSON().amount).toBe('100.00');
  });

  test('the configured policy drives the first wait as well', async () => {
    const walletId = await createWallet();
    const before = Date.now();
    const refund = await submit(refundOf(walletId, 'bet-1'));
    const wait = (await nextAttemptOf(refund.transaction.id)) - before;
    // base de 100 ms, não os 2 s do padrão
    expect(wait).toBeGreaterThanOrEqual(100);
    expect(wait).toBeLessThan(1000);
  });
});
