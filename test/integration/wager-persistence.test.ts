import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { JournalRepository } from '../../src/application/ports/journal.repository';
import { JOURNAL_REPOSITORY } from '../../src/application/ports/journal.repository';
import type { LedgerRepository } from '../../src/application/ports/ledger.repository';
import { LEDGER_REPOSITORY } from '../../src/application/ports/ledger.repository';
import type { TransactionRunner } from '../../src/application/ports/transaction-runner';
import { TRANSACTION_RUNNER } from '../../src/application/ports/transaction-runner';
import type { WagerTransactionRepository } from '../../src/application/ports/wager-transaction.repository';
import { WAGER_TRANSACTION_REPOSITORY } from '../../src/application/ports/wager-transaction.repository';
import type { WalletRepository } from '../../src/application/ports/wallet.repository';
import { WALLET_REPOSITORY } from '../../src/application/ports/wallet.repository';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { Money } from '../../src/domain/shared/money';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status';
import { JournalEntry } from '../../src/domain/wallet/journal-entry';
import { opposite } from '../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { isTransientDbError } from '../../src/infrastructure/persistence/pg-errors';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const CURRENCY = 'BRL';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let orm: MikroORM;
let t: TestApp;
let runner: TransactionRunner;
let wallets: WalletRepository;
let transactions: WagerTransactionRepository;
let ledger: LedgerRepository;
let journal: JournalRepository;

const money = (amount: string) => Money.from({ amount, currency: CURRENCY });

/** Wallet com 100.00 criada pelo caso de uso real (transação OPENING e crédito no ledger). */
function createWallet(): Promise<Wallet> {
  return t.app.get(CreateWalletUseCase).execute({
    playerId: PLAYER_ID,
    initialBalance: { amount: '100.00', currency: CURRENCY },
    correlationId: 'wager-persistence-test',
  });
}

function newTransaction(
  wallet: Wallet,
  p: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: money('25.00'),
    createdAt: new Date(),
    ...p,
  });
}

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp();
  runner = t.app.get<TransactionRunner>(TRANSACTION_RUNNER);
  wallets = t.app.get<WalletRepository>(WALLET_REPOSITORY);
  transactions = t.app.get<WagerTransactionRepository>(WAGER_TRANSACTION_REPOSITORY);
  ledger = t.app.get<LedgerRepository>(LEDGER_REPOSITORY);
  journal = t.app.get<JournalRepository>(JOURNAL_REPOSITORY);
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

describe('WalletRepository.lockById', () => {
  test('returns null for an unknown wallet', async () => {
    const found = await runner.run(() => wallets.lockById(Bun.randomUUIDv7()));
    expect(found).toBeNull();
  });

  test('returns the wallet rehydrated', async () => {
    const wallet = await createWallet();
    const locked = await runner.run(() => wallets.lockById(wallet.id));
    expect(locked?.balance.toJSON().amount).toBe('100.00');
    expect(locked?.version).toBe(wallet.version);
    // SQL direto devolve TIMESTAMPTZ como texto: o repositório precisa converter
    expect(locked?.createdAt).toBeInstanceOf(Date);
    expect(locked?.updatedAt).toBeInstanceOf(Date);
    expect(locked?.createdAt.getTime()).toBe(wallet.createdAt.getTime());
  });

  test('a second locker waits for the first transaction to commit', async () => {
    const wallet = await createWallet();
    let firstCommittedAt = 0;
    let secondLockedAt = 0;
    const first = runner.run(async () => {
      await wallets.lockById(wallet.id);
      await sleep(600);
      firstCommittedAt = Date.now();
    });
    await sleep(150);
    const second = runner.run(async () => {
      await wallets.lockById(wallet.id);
      secondLockedAt = Date.now();
    });
    await Promise.all([first, second]);
    expect(secondLockedAt).toBeGreaterThanOrEqual(firstCommittedAt);
  });

  test('lock timeout surfaces as a transient error', async () => {
    const wallet = await createWallet();
    const first = runner.run(async () => {
      await wallets.lockById(wallet.id);
      await sleep(3500);
    });
    await sleep(150);
    const error = await runner.run(() => wallets.lockById(wallet.id)).catch((e: unknown) => e);
    await first;
    expect(error).toBeInstanceOf(Error);
    expect(isTransientDbError(error)).toBe(true);
  });
});

describe('WalletRepository.save', () => {
  test('persists balance and version when the expected version matches', async () => {
    const wallet = await createWallet();
    await runner.run(async () => {
      const locked = await wallets.lockById(wallet.id);
      if (!locked) throw new Error('wallet not found');
      const expectedVersion = locked.version;
      const at = new Date();
      const win = newTransaction(locked, { kind: WagerTransactionKind.Win, money: money('10.00') });
      const entry = locked.credit({
        money: win.money,
        transactionId: win.id,
        entryId: Bun.randomUUIDv7(),
        at,
      });
      win.markProcessed({ at, balanceAfter: locked.balance, walletVersionAfter: locked.version });
      await wallets.save(locked, expectedVersion);
      await transactions.add(win);
      await ledger.append(entry);
      await journal.append(
        JournalEntry.create({
          id: Bun.randomUUIDv7(),
          transactionId: win.id,
          accountId: JournalEntry.accountId(win.providerId, entry.money.currency),
          direction: opposite(entry.direction),
          money: entry.money,
          createdAt: at,
        }),
      );
    });
    const reloaded = await runner.run(() => wallets.findById(wallet.id));
    expect(reloaded?.balance.toJSON().amount).toBe('110.00');
    expect(reloaded?.version).toBe(wallet.version + 1);
  });

  test('throws when the version changed under the lock', async () => {
    const wallet = await createWallet();
    const stale = Wallet.rehydrate({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version + 1,
      createdAt: wallet.createdAt,
      updatedAt: new Date(),
    });
    const attempt = runner.run(() => wallets.save(stale, wallet.version + 5));
    await expect(attempt).rejects.toBeInstanceOf(InvariantViolationError);
  });
});

describe('WagerTransactionRepository lookups', () => {
  test('findByIdempotencyKey and findByExternalId rehydrate money and balanceAfter', async () => {
    const wallet = await createWallet();
    const tx = newTransaction(wallet);
    tx.markProcessed({ at: new Date(), balanceAfter: money('75.00'), walletVersionAfter: 2 });
    await transactions.add(tx);

    const [byKey, byExternal] = await runner.run(async () => [
      await transactions.findByIdempotencyKey('provider-a', 'provider-a:ext-1'),
      await transactions.findByExternalId('provider-a', 'ext-1'),
    ]);
    for (const found of [byKey, byExternal]) {
      expect(found?.id).toBe(tx.id);
      expect(found?.money.toJSON().amount).toBe('25.00');
      expect(found?.balanceAfter?.toJSON().amount).toBe('75.00');
      expect(found?.walletVersionAfter).toBe(2);
      expect(found?.status).toBe(tx.status);
      expect(found?.processedAt).toBeInstanceOf(Date);
    }
  });

  test('returns null when nothing matches', async () => {
    const found = await runner.run(async () => [
      await transactions.findByIdempotencyKey('provider-a', 'nope'),
      await transactions.findByExternalId('provider-a', 'nope'),
    ]);
    expect(found).toEqual([null, null]);
  });

  test('lookups are scoped by provider', async () => {
    const wallet = await createWallet();
    await transactions.add(newTransaction(wallet));
    const found = await runner.run(async () => [
      await transactions.findByIdempotencyKey('provider-b', 'provider-a:ext-1'),
      await transactions.findByExternalId('provider-b', 'ext-1'),
    ]);
    expect(found).toEqual([null, null]);
  });

  test('isReversed is false until a PROCESSED reversal points at the transaction', async () => {
    const wallet = await createWallet();
    const bet = newTransaction(wallet);
    bet.markProcessed({ at: new Date(), balanceAfter: money('75.00'), walletVersionAfter: 2 });
    await transactions.add(bet);
    expect(await runner.run(() => transactions.isReversed(bet.id))).toBe(false);

    const refund = newTransaction(wallet, {
      externalTransactionId: 'ext-2',
      idempotencyKey: 'provider-a:ext-2',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-1',
    });
    refund.markProcessed({
      referenceTransactionId: bet.id,
      at: new Date(),
      balanceAfter: money('100.00'),
      walletVersionAfter: 3,
    });
    await transactions.add(refund);
    expect(await runner.run(() => transactions.isReversed(bet.id))).toBe(true);
  });

  test('a pending reversal does not count as reversed', async () => {
    const wallet = await createWallet();
    const bet = newTransaction(wallet);
    await transactions.add(bet);
    const refund = newTransaction(wallet, {
      externalTransactionId: 'ext-2',
      idempotencyKey: 'provider-a:ext-2',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-1',
    });
    refund.markPendingReference({ nextAttemptAt: new Date(Date.now() + 60_000) });
    await transactions.add(refund);
    expect(await runner.run(() => transactions.isReversed(bet.id))).toBe(false);
  });

  test('PENDING_REFERENCE keeps next_reference_attempt_at and rehydrates it', async () => {
    const wallet = await createWallet();
    const nextAttemptAt = new Date(Date.now() + 60_000);
    const refund = newTransaction(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'missing',
    });
    refund.markPendingReference({ nextAttemptAt });
    await transactions.add(refund);

    const [row] = await orm.em
      .getConnection()
      .execute<{ next_attempt: string | null }[]>(
        'SELECT next_reference_attempt_at AS next_attempt FROM wager_transactions WHERE id = ?',
        [refund.id],
      );
    expect(new Date(row?.next_attempt ?? 0).getTime()).toBe(nextAttemptAt.getTime());

    const found = await runner.run(() => transactions.findByExternalId('provider-a', 'ext-1'));
    expect(found?.nextReferenceAttemptAt?.getTime()).toBe(nextAttemptAt.getTime());
    expect(found?.balanceAfter).toBeUndefined();
    expect(found?.referenceExternalTransactionId).toBe('missing');
  });
});

describe('WagerTransactionRepository pending references', () => {
  const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  async function addPendingRefund(
    wallet: Wallet,
    p: { external: string; reference: string; providerId?: string; nextAttemptAt?: Date },
  ): Promise<WagerTransaction> {
    const providerId = p.providerId ?? 'provider-a';
    const refund = newTransaction(wallet, {
      providerId,
      externalTransactionId: p.external,
      idempotencyKey: `${providerId}:${p.external}`,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: p.reference,
    });
    refund.markPendingReference({ nextAttemptAt: p.nextAttemptAt ?? inMinutes(10) });
    await transactions.add(refund);
    return refund;
  }

  async function nextAttemptOf(id: string): Promise<Date> {
    const [row] = await orm.em
      .getConnection()
      .execute<{ next_attempt: string }[]>(
        'SELECT next_reference_attempt_at AS next_attempt FROM wager_transactions WHERE id = ?',
        [id],
      );
    return new Date(row?.next_attempt ?? 0);
  }

  test('findById rehydrates the transaction, including referenceAttempts', async () => {
    const wallet = await createWallet();
    const refund = await addPendingRefund(wallet, { external: 'refund-1', reference: 'bet-1' });
    const found = await runner.run(() => transactions.findById(refund.id));
    expect(found?.id).toBe(refund.id);
    expect(found?.referenceAttempts).toBe(0);
    expect(await runner.run(() => transactions.findById(Bun.randomUUIDv7()))).toBeNull();
  });

  test('update persists a reschedule (attempts and next attempt)', async () => {
    const wallet = await createWallet();
    const refund = await addPendingRefund(wallet, { external: 'refund-1', reference: 'bet-1' });
    const nextAttemptAt = inMinutes(5);
    refund.retryReferenceLater(nextAttemptAt);
    await runner.run(() => transactions.update(refund, new Date()));

    const found = await runner.run(() => transactions.findById(refund.id));
    expect(found?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(found?.referenceAttempts).toBe(1);
    expect(found?.nextReferenceAttemptAt?.getTime()).toBe(nextAttemptAt.getTime());
  });

  test('update stamps updated_at with the time it receives (the decision clock)', async () => {
    const wallet = await createWallet();
    const refund = await addPendingRefund(wallet, { external: 'refund-1', reference: 'bet-1' });
    const at = new Date('2030-01-02T03:04:05.000Z');
    refund.retryReferenceLater(inMinutes(5));
    await runner.run(() => transactions.update(refund, at));

    const [row] = await orm.em
      .getConnection()
      .execute<{ updated_at: string }[]>('SELECT updated_at FROM wager_transactions WHERE id = ?', [
        refund.id,
      ]);
    expect(new Date(row?.updated_at ?? 0).getTime()).toBe(at.getTime());
  });

  test('update persists the terminal fields when a pending transaction resolves', async () => {
    const wallet = await createWallet();
    const bet = newTransaction(wallet, { externalTransactionId: 'bet-1' });
    bet.markProcessed({ at: new Date(), balanceAfter: money('75.00'), walletVersionAfter: 2 });
    await transactions.add(bet);
    const refund = await addPendingRefund(wallet, { external: 'refund-1', reference: 'bet-1' });
    refund.reject('REFERENCE_NOT_FOUND', new Date());
    await runner.run(() => transactions.update(refund, new Date()));

    const found = await runner.run(() => transactions.findById(refund.id));
    expect(found?.status).toBe(WagerTransactionStatus.Rejected);
    expect(found?.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(found?.processedAt).toBeInstanceOf(Date);
    expect(found?.nextReferenceAttemptAt).toBeUndefined();
  });

  test('update of a row that is no longer pending throws InvariantViolationError', async () => {
    const wallet = await createWallet();
    const refund = await addPendingRefund(wallet, { external: 'refund-1', reference: 'bet-1' });
    const stale = await runner.run(() => transactions.findById(refund.id));
    refund.reject('REFERENCE_NOT_FOUND', new Date());
    await runner.run(() => transactions.update(refund, new Date()));

    if (!stale) throw new Error('transaction not found');
    stale.retryReferenceLater(inMinutes(5));
    await expect(runner.run(() => transactions.update(stale, new Date()))).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
  });

  test('wakeDependents only touches pending rows of that wallet/provider/reference', async () => {
    const wallet = await createWallet();
    const now = new Date();
    const later = inMinutes(10);
    const pending = { reference: 'bet-1', nextAttemptAt: later };
    const dependent = await addPendingRefund(wallet, { ...pending, external: 'r-1' });
    const otherReference = await addPendingRefund(wallet, {
      ...pending,
      external: 'r-2',
      reference: 'bet-2',
    });
    const otherProvider = await addPendingRefund(wallet, {
      ...pending,
      external: 'r-3',
      providerId: 'provider-b',
    });
    const alreadyDue = inMinutes(-1);
    const due = await addPendingRefund(wallet, {
      external: 'r-4',
      reference: 'bet-1',
      nextAttemptAt: alreadyDue,
    });

    await runner.run(() =>
      transactions.wakeDependents({
        walletId: wallet.id,
        providerId: 'provider-a',
        externalTransactionId: 'bet-1',
        now,
      }),
    );

    expect((await nextAttemptOf(dependent.id)).getTime()).toBe(now.getTime());
    expect((await nextAttemptOf(otherReference.id)).getTime()).toBe(later.getTime());
    expect((await nextAttemptOf(otherProvider.id)).getTime()).toBe(later.getTime());
    // já vencida: o filtro `> now` não reescreve
    expect((await nextAttemptOf(due.id)).getTime()).toBe(alreadyDue.getTime());
  });

  test('wakeDependents ignores pending rows of another wallet', async () => {
    const wallet = await createWallet();
    const other = await t.app.get(CreateWalletUseCase).execute({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4b9',
      initialBalance: { amount: '100.00', currency: CURRENCY },
      correlationId: 'wager-persistence-test',
    });
    const later = inMinutes(10);
    const foreign = await addPendingRefund(other, {
      external: 'r-1',
      reference: 'bet-1',
      nextAttemptAt: later,
    });

    await runner.run(() =>
      transactions.wakeDependents({
        walletId: wallet.id,
        providerId: 'provider-a',
        externalTransactionId: 'bet-1',
        now: new Date(),
      }),
    );

    expect((await nextAttemptOf(foreign.id)).getTime()).toBe(later.getTime());
  });

  test('claimDuePendingReferences returns due rows once and pushes them by the lease', async () => {
    const wallet = await createWallet();
    const now = new Date();
    const first = await addPendingRefund(wallet, {
      external: 'r-1',
      reference: 'bet-1',
      nextAttemptAt: new Date(now.getTime() - 2_000),
    });
    const second = await addPendingRefund(wallet, {
      external: 'r-2',
      reference: 'bet-2',
      nextAttemptAt: new Date(now.getTime() - 1_000),
    });
    await addPendingRefund(wallet, { external: 'r-3', reference: 'bet-3' });

    const claimed = await transactions.claimDuePendingReferences({
      now,
      limit: 10,
      leaseMs: 30_000,
    });

    expect(claimed).toEqual([
      { id: first.id, walletId: wallet.id },
      { id: second.id, walletId: wallet.id },
    ]);
    expect((await nextAttemptOf(first.id)).getTime()).toBe(now.getTime() + 30_000);
    expect(
      await transactions.claimDuePendingReferences({ now, limit: 10, leaseMs: 30_000 }),
    ).toEqual([]);
  });

  test('claimDuePendingReferences respects the limit', async () => {
    const wallet = await createWallet();
    const past = inMinutes(-1);
    await addPendingRefund(wallet, { external: 'r-1', reference: 'bet-1', nextAttemptAt: past });
    await addPendingRefund(wallet, { external: 'r-2', reference: 'bet-2', nextAttemptAt: past });
    const claimed = await transactions.claimDuePendingReferences({
      now: new Date(),
      limit: 1,
      leaseMs: 30_000,
    });
    expect(claimed).toHaveLength(1);
  });
});
