import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CLOCK, type Clock } from '../../src/application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from '../../src/application/ports/id-generator';
import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from '../../src/application/ports/inbox.repository';
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
  type ProcessWagerDeps,
  ProcessWagerTransactionUseCase,
} from '../../src/application/wager/process-wager-transaction.use-case';
import { IdempotencyConflictError } from '../../src/application/wager/wager-errors';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { WalletNotFoundError } from '../../src/application/wallet/wallet-errors';
import { InvalidPayloadError } from '../../src/domain/shared/domain-error';
import { ReferenceRequiredError } from '../../src/domain/wager/wager-errors';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status';
import {
  isTransientDbError,
  isWagerUniqueViolation,
} from '../../src/infrastructure/persistence/pg-errors';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const OTHER_PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2';
const UNKNOWN_WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let orm: MikroORM;
let t: TestApp;
let useCase: ProcessWagerTransactionUseCase;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

interface Counts {
  transactions: number;
  ledger: number;
  outbox: number;
}

/** Transações de aposta (sem as OPENING), lançamentos do ledger e eventos na outbox. */
async function counts(): Promise<Counts> {
  const [row] = await sql<Record<keyof Counts, string>>(`
    SELECT (SELECT COUNT(*) FROM wager_transactions WHERE kind <> 'OPENING') AS transactions,
           (SELECT COUNT(*) FROM wallet_ledger_entries) AS ledger,
           (SELECT COUNT(*) FROM outbox_messages) AS outbox`);
  return {
    transactions: Number(row?.transactions),
    ledger: Number(row?.ledger),
    outbox: Number(row?.outbox),
  };
}

async function walletRow(id: string) {
  const [row] = await sql<{ balance: string; version: number }>(
    'SELECT balance, version FROM wallets WHERE id = ?',
    [id],
  );
  return row;
}

async function outboxTypesFor(transactionId: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }>(
    `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?
      ORDER BY event_type`,
    [transactionId],
  );
  return rows.map((r) => r.event_type);
}

async function createWallet(amount = '100.00', playerId = PLAYER_ID, currency = 'BRL') {
  const wallet = await t.app.get(CreateWalletUseCase).execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: 'create-wallet',
  });
  return wallet.id;
}

function command(walletId: string, over: Partial<ProcessWagerCommand> = {}): ProcessWagerCommand {
  const externalTransactionId = over.externalTransactionId ?? 'bet-1';
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
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

/** Monta o caso de uso com os adaptadores reais do app, trocando só as dependências indicadas. */
function buildUseCase(over: Partial<ProcessWagerDeps>): ProcessWagerTransactionUseCase {
  return new ProcessWagerTransactionUseCase({
    transactionRunner: t.app.get<TransactionRunner>(TRANSACTION_RUNNER),
    wallets: t.app.get<WalletRepository>(WALLET_REPOSITORY),
    transactions: t.app.get<WagerTransactionRepository>(WAGER_TRANSACTION_REPOSITORY),
    ledger: t.app.get<LedgerRepository>(LEDGER_REPOSITORY),
    inbox: t.app.get<InboxRepository>(INBOX_REPOSITORY),
    outbox: t.app.get<OutboxRepository>(OUTBOX_REPOSITORY),
    ids: t.app.get<IdGenerator>(ID_GENERATOR),
    clock: t.app.get<Clock>(CLOCK),
    isTransient: isTransientDbError,
    isUniqueViolation: isWagerUniqueViolation,
    ...over,
  });
}

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp();
  useCase = t.app.get(ProcessWagerTransactionUseCase);
});

afterAll(async () => {
  await t.close();
  await orm.close();
});

beforeEach(async () => {
  await resetDb(orm);
});

afterEach(async () => {
  await assertLedgerInvariant(orm);
});

describe('ProcessWagerTransactionUseCase — new transactions', () => {
  test('uppercase walletId and playerId are normalised: processed against the lowercase wallet', async () => {
    const walletId = await createWallet();

    const result = await useCase.execute(
      command(walletId, { walletId: walletId.toUpperCase(), playerId: PLAYER_ID.toUpperCase() }),
    );

    expect(result.idempotentReplay).toBe(false);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.transaction.walletId).toBe(walletId);
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });
  });

  test('BET processed → wallet debited; tx + DEBIT ledger + 2 outbox events', async () => {
    const walletId = await createWallet();

    const result = await useCase.execute(command(walletId));

    expect(result.idempotentReplay).toBe(false);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.transaction.balanceAfter?.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });

    const [tx] = await sql('SELECT * FROM wager_transactions WHERE id = ?', [
      result.transaction.id,
    ]);
    expect(tx).toMatchObject({
      provider_id: 'provider-a',
      external_transaction_id: 'bet-1',
      idempotency_key: 'provider-a:bet-1',
      kind: 'BET',
      amount: '25.00',
      status: 'PROCESSED',
      balance_after: '75.00',
      wallet_version_after: 2,
      failure_code: null,
    });
    const ledger = await sql('SELECT * FROM wallet_ledger_entries WHERE transaction_id = ?', [
      result.transaction.id,
    ]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      direction: 'DEBIT',
      amount: '25.00',
      balance_before: '100.00',
      balance_after: '75.00',
      wallet_version: 2,
    });
    expect(await outboxTypesFor(result.transaction.id)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const [event] = await sql<{ payload: { correlationId: string } }>(
      `SELECT payload FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? LIMIT 1`,
      [result.transaction.id],
    );
    expect(event?.payload.correlationId).toBe('corr-1');
  });

  test('BET without funds → REJECTED INSUFFICIENT_FUNDS; only tx + 1 outbox; wallet intact', async () => {
    const walletId = await createWallet();
    const before = await counts();

    const result = await useCase.execute(
      command(walletId, { money: { amount: '150.00', currency: 'BRL' } }),
    );

    expect(result.idempotentReplay).toBe(false);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
    expect(await counts()).toEqual({
      transactions: before.transactions + 1,
      ledger: before.ledger,
      outbox: before.outbox + 1,
    });
    expect(await outboxTypesFor(result.transaction.id)).toEqual(['WagerTransactionRejected']);
    const [tx] = await sql('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [
      result.transaction.id,
    ]);
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('LOSS → PROCESSED without ledger nor balance change; only WagerTransactionProcessed', async () => {
    const walletId = await createWallet();

    const result = await useCase.execute(
      command(walletId, { externalTransactionId: 'loss-1', kind: WagerTransactionKind.Loss }),
    );

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
    expect(await outboxTypesFor(result.transaction.id)).toEqual(['WagerTransactionProcessed']);
  });

  test('REFUND of a processed BET credits once; a second REFUND is REJECTED ALREADY_REVERSED', async () => {
    const walletId = await createWallet();
    const bet = await useCase.execute(command(walletId));
    const refund = (externalTransactionId: string) =>
      command(walletId, {
        externalTransactionId,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet-1',
      });

    const first = await useCase.execute(refund('refund-1'));
    const second = await useCase.execute(refund('refund-2'));

    expect(first.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(first.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(first.transaction.balanceAfter?.toJSON().amount).toBe('100.00');
    expect(second.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.transaction.failureCode).toBe('ALREADY_REVERSED');
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  test('REFUND with an unknown reference → PENDING_REFERENCE; replay returns its current state', async () => {
    const walletId = await createWallet();
    const cmd = command(walletId, {
      externalTransactionId: 'refund-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'missing-bet',
    });

    const result = await useCase.execute(cmd);
    const replay = await useCase.execute(cmd);

    expect(result.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.transaction.nextReferenceAttemptAt).toBeInstanceOf(Date);
    expect(await outboxTypesFor(result.transaction.id)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(result.transaction.id);
    expect(replay.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('ProcessWagerTransactionUseCase — idempotency', () => {
  test('replay with the same payload returns the original balanceAfter even after another BET', async () => {
    const walletId = await createWallet();
    const original = await useCase.execute(command(walletId));
    await useCase.execute(command(walletId, { externalTransactionId: 'bet-2' }));
    const before = await counts();

    const replay = await useCase.execute(command(walletId, { correlationId: 'retry' }));

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(original.transaction.id);
    expect(replay.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.transaction.balanceAfter?.toJSON().amount).toBe('75.00');
    expect(await walletRow(walletId)).toEqual({ balance: '50.00', version: 3 });
    expect(await counts()).toEqual(before);
  });

  test('replay of a REJECTED transaction returns the original rejection', async () => {
    const walletId = await createWallet();
    const cmd = command(walletId, { money: { amount: '150.00', currency: 'BRL' } });
    const original = await useCase.execute(cmd);

    const replay = await useCase.execute(cmd);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(original.transaction.id);
    expect(replay.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('same key with a different amount → IdempotencyConflictError; nothing written', async () => {
    const walletId = await createWallet();
    await useCase.execute(command(walletId));
    const before = await counts();

    const attempt = useCase.execute(
      command(walletId, { money: { amount: '30.00', currency: 'BRL' } }),
    );

    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await counts()).toEqual(before);
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });
  });

  test('same externalTransactionId with another key → IdempotencyConflictError', async () => {
    const walletId = await createWallet();
    await useCase.execute(command(walletId));
    const before = await counts();

    const attempt = useCase.execute(command(walletId, { idempotencyKey: 'another-key' }));

    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await counts()).toEqual(before);
  });

  test('a lost race on the UNIQUE index rolls back and re-runs once, ending in a replay', async () => {
    const walletId = await createWallet();
    const original = await useCase.execute(command(walletId));
    const real = t.app.get<WagerTransactionRepository>(WAGER_TRANSACTION_REPOSITORY);
    // simula a corrida: na 1ª execução as consultas de idempotência ainda não enxergam a original,
    // então o INSERT viola a UNIQUE; na 2ª elas a encontram
    let hidden = true;
    const racing: WagerTransactionRepository = {
      add: (tx) => {
        hidden = false;
        return real.add(tx);
      },
      findByIdempotencyKey: (p, k) =>
        hidden ? Promise.resolve(null) : real.findByIdempotencyKey(p, k),
      findByExternalId: (p, e) => (hidden ? Promise.resolve(null) : real.findByExternalId(p, e)),
      isReversed: (id) => real.isReversed(id),
    };
    const racingUseCase = buildUseCase({ transactions: racing });
    const before = await counts();

    const result = await racingUseCase.execute(command(walletId));

    expect(result.idempotentReplay).toBe(true);
    expect(result.transaction.id).toBe(original.transaction.id);
    // o UPDATE da wallet da 1ª execução foi desfeito junto com o INSERT que falhou
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });
    expect(await counts()).toEqual(before);
  });

  test('same BET 10× in parallel → one PROCESSED, nine replays, one DEBIT', async () => {
    const walletId = await createWallet();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => useCase.execute(command(walletId))),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    for (const r of results) expect(r.transaction.balanceAfter?.toJSON().amount).toBe('75.00');
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });
    expect(await counts()).toEqual({ transactions: 1, ledger: 2, outbox: 4 });
  });

  test('same key on two different wallets in parallel → one PROCESSED, one IdempotencyConflictError', async () => {
    const walletA = await createWallet();
    const walletB = await createWallet('100.00', OTHER_PLAYER_ID);

    const results = await Promise.allSettled([
      useCase.execute(command(walletA)),
      useCase.execute(command(walletB, { playerId: OTHER_PLAYER_ID })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyConflictError);
    expect(await counts()).toEqual({ transactions: 1, ledger: 3, outbox: 6 });
  });
});

describe('ProcessWagerTransactionUseCase — validation and failures', () => {
  test('unknown wallet → WalletNotFoundError; nothing written', async () => {
    const attempt = useCase.execute(command(UNKNOWN_WALLET_ID));

    await expect(attempt).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await counts()).toEqual({ transactions: 0, ledger: 0, outbox: 0 });
  });

  test.each([
    ['kind OPENING', { kind: WagerTransactionKind.Opening }],
    ['providerId internal', { providerId: 'internal' }],
  ])('%s → InvalidPayloadError', async (_, over) => {
    const walletId = await createWallet();
    const before = await counts();

    await expect(useCase.execute(command(walletId, over))).rejects.toBeInstanceOf(
      InvalidPayloadError,
    );
    expect(await counts()).toEqual(before);
  });

  test('REFUND without reference → ReferenceRequiredError', async () => {
    const walletId = await createWallet();

    const attempt = useCase.execute(command(walletId, { kind: WagerTransactionKind.Refund }));

    await expect(attempt).rejects.toBeInstanceOf(ReferenceRequiredError);
  });

  test('when the outbox insert fails, no tx/ledger/outbox row remains and the balance is intact', async () => {
    const walletId = await createWallet();
    const before = await counts();
    const failingOutbox: Pick<OutboxRepository, 'enqueue'> = {
      enqueue: () => Promise.reject(new Error('outbox unavailable')),
    };
    const broken = await createTestApp({}, (builder) =>
      builder.overrideProvider(OUTBOX_REPOSITORY).useValue(failingOutbox),
    );
    try {
      const attempt = broken.app.get(ProcessWagerTransactionUseCase).execute(command(walletId));

      await expect(attempt).rejects.toThrow('outbox unavailable');
      expect(await counts()).toEqual(before);
      expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
    } finally {
      await broken.close();
    }
  });

  test('wallet lock held beyond lock_timeout → transient failure retried, BET applied once', async () => {
    const walletId = await createWallet();
    const runner = t.app.get<TransactionRunner>(TRANSACTION_RUNNER);
    const wallets = t.app.get<WalletRepository>(WALLET_REPOSITORY);
    const holder = runner.run(async () => {
      await wallets.lockById(walletId);
      await sleep(2500);
    });
    await sleep(100);
    const transientErrors: unknown[] = [];
    const observed = buildUseCase({
      isTransient: (error) => {
        const transient = isTransientDbError(error);
        if (transient) transientErrors.push(error);
        return transient;
      },
    });

    const result = await observed.execute(command(walletId));
    await holder;

    // a 1ª execução estourou o lock_timeout (2 s) e foi refeita do zero
    expect(transientErrors).toHaveLength(1);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });
    expect(await counts()).toEqual({ transactions: 1, ledger: 2, outbox: 4 });
  });
});

describe('ProcessWagerTransactionUseCase — inbox', () => {
  const receipt = (over: Partial<{ messageId: string; payloadHash: string }> = {}) => ({
    consumerName: 'transactions-consumer',
    messageId: 'msg-1',
    payloadHash: 'a'.repeat(64),
    ...over,
  });

  const inboxRows = () =>
    sql<{ message_id: string; processed_at: Date | null; received_at: Date }>(
      'SELECT message_id, received_at, processed_at FROM inbox_messages',
    );

  test('command with a receipt writes the inbox row together with transaction, ledger and outbox', async () => {
    const walletId = await createWallet();

    const result = await useCase.execute({ ...command(walletId), inbox: receipt() });

    expect(result.idempotentReplay).toBe(false);
    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_id).toBe('msg-1');
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(rows[0]?.processed_at).toEqual(rows[0]?.received_at as Date);
    expect(await counts()).toEqual({ transactions: 1, ledger: 2, outbox: 4 });
  });

  test('same command and receipt again → replay; one inbox row and one ledger effect', async () => {
    const walletId = await createWallet();
    const cmd = { ...command(walletId), inbox: receipt() };
    await useCase.execute(cmd);

    const replay = await useCase.execute(cmd);

    expect(replay.idempotentReplay).toBe(true);
    expect(await inboxRows()).toHaveLength(1);
    expect(await counts()).toEqual({ transactions: 1, ledger: 2, outbox: 4 });
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });
  });

  test('same messageId with another payloadHash → IdempotencyConflictError; nothing written', async () => {
    const walletId = await createWallet();
    await useCase.execute({ ...command(walletId), inbox: receipt() });
    const before = await counts();

    const attempt = useCase.execute({
      ...command(walletId, { externalTransactionId: 'bet-2' }),
      inbox: receipt({ payloadHash: 'b'.repeat(64) }),
    });

    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await inboxRows()).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });

  test('two parallel calls with the same receipt → one ledger effect and both resolve', async () => {
    const walletId = await createWallet();
    const cmd = { ...command(walletId), inbox: receipt() };

    const results = await Promise.all([useCase.execute(cmd), useCase.execute(cmd)]);

    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(1);
    expect(await inboxRows()).toHaveLength(1);
    expect(await counts()).toEqual({ transactions: 1, ledger: 2, outbox: 4 });
    expect(await walletRow(walletId)).toEqual({ balance: '75.00', version: 2 });
  });

  test('when the outbox insert fails, no inbox row remains', async () => {
    const walletId = await createWallet();
    const failingOutbox: Pick<OutboxRepository, 'enqueue'> = {
      enqueue: () => Promise.reject(new Error('outbox unavailable')),
    };
    const broken = await createTestApp({}, (builder) =>
      builder.overrideProvider(OUTBOX_REPOSITORY).useValue(failingOutbox),
    );
    try {
      const attempt = broken.app
        .get(ProcessWagerTransactionUseCase)
        .execute({ ...command(walletId), inbox: receipt() });

      await expect(attempt).rejects.toThrow('outbox unavailable');
      expect(await inboxRows()).toHaveLength(0);
    } finally {
      await broken.close();
    }
  });
});

describe('assertLedgerInvariant', () => {
  test('detects a wallet whose balance diverges from its ledger', async () => {
    const walletId = await createWallet();
    await sql('UPDATE wallets SET balance = 99.99 WHERE id = ?', [walletId]);

    await expect(assertLedgerInvariant(orm)).rejects.toThrow(walletId);
    await resetDb(orm);
  });
});
