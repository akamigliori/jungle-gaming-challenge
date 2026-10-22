import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money';
import {
  DEFAULT_REFERENCE_RETRY,
  referenceRetryDelayMs,
} from '../../../src/domain/wager/reference-retry';
import {
  decideWager,
  type ReferenceView,
  reevaluatePendingWager,
} from '../../../src/domain/wager/wager-decision';
import { InvalidTransactionStateError } from '../../../src/domain/wager/wager-errors';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { WagerTransactionKind as K } from '../../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus as S } from '../../../src/domain/wager/wager-transaction-status';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';

const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const at = new Date('2026-01-01T00:00:00Z');
const PLAYER = 'player-1';
const WALLET = 'wallet-1';
const ROUND = 'round-1';

const newWallet = () =>
  Wallet.rehydrate({
    id: WALLET,
    playerId: PLAYER,
    currency: 'BRL',
    balance: money('100.00'),
    version: 1,
    createdAt: at,
    updatedAt: at,
  });

interface TxOver {
  id?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  amount?: string;
  currency?: string;
  ref?: string;
}

const makeTx = (kind: K, amount: string, over: TxOver = {}) =>
  WagerTransaction.create({
    id: over.id ?? 'tx-new',
    providerId: 'prov',
    externalTransactionId: `ext-${over.id ?? 'new'}`,
    idempotencyKey: `key-${over.id ?? 'new'}`,
    payloadHash: 'hash',
    walletId: over.walletId ?? WALLET,
    playerId: over.playerId ?? PLAYER,
    roundId: over.roundId ?? ROUND,
    gameId: 'g-1',
    kind,
    money: money(over.amount ?? amount, over.currency),
    referenceExternalTransactionId: over.ref,
    createdAt: at,
  });

const processedRef = (kind: K, amount: string, over: TxOver = {}, alreadyReversed = false) => {
  const ref = makeTx(kind, amount, {
    id: 'tx-ref',
    ref: kind === K.Refund || kind === K.Rollback ? 'ext-x' : undefined,
    ...over,
  });
  ref.markProcessed({ at, balanceAfter: money('0.00'), walletVersionAfter: 1 });
  return { transaction: ref, alreadyReversed } satisfies ReferenceView;
};

const run = (
  tx: WagerTransaction,
  reference: ReferenceView | null = null,
  wallet = newWallet(),
) => ({
  wallet,
  decision: decideWager({
    tx,
    wallet,
    reference,
    at,
    entryId: 'entry-1',
    retry: DEFAULT_REFERENCE_RETRY,
  }),
});

describe('decideWager BET', () => {
  test('debits the wallet and processes', () => {
    const tx = makeTx(K.Bet, '25.00');
    const { wallet, decision } = run(tx);
    expect(decision.outcome).toBe('PROCESSED');
    if (decision.outcome !== 'PROCESSED') throw new Error('unreachable');
    expect(decision.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(tx.status).toBe(S.Processed);
    expect(tx.balanceAfter?.toJSON().amount).toBe('75.00');
    expect(tx.walletVersionAfter).toBe(2);
  });

  test('insufficient funds rejects and leaves the wallet intact', () => {
    const tx = makeTx(K.Bet, '100.01');
    const { wallet, decision } = run(tx);
    expect(decision).toEqual({ outcome: 'REJECTED', code: 'INSUFFICIENT_FUNDS' });
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.balanceAfter?.toJSON().amount).toBe('100.00');
    expect(tx.walletVersionAfter).toBe(1);
  });

  test('currency different from the wallet -> CURRENCY_MISMATCH', () => {
    const tx = makeTx(K.Bet, '10.00', { currency: 'USD' });
    const { decision } = run(tx);
    expect(decision).toEqual({ outcome: 'REJECTED', code: 'CURRENCY_MISMATCH' });
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.walletVersionAfter).toBeUndefined();
  });

  test('other player -> PLAYER_MISMATCH, checked before currency', () => {
    const tx = makeTx(K.Bet, '10.00', { playerId: 'other', currency: 'USD' });
    expect(run(tx).decision).toEqual({ outcome: 'REJECTED', code: 'PLAYER_MISMATCH' });
  });
});

describe('decideWager WIN', () => {
  test('without reference credits the wallet', () => {
    const tx = makeTx(K.Win, '50.00');
    const { wallet, decision } = run(tx);
    expect(decision.outcome).toBe('PROCESSED');
    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  test('with reference to a PROCESSED BET of the same round links it', () => {
    const tx = makeTx(K.Win, '50.00', { ref: 'ext-ref' });
    const { wallet, decision } = run(tx, processedRef(K.Bet, '10.00'));
    expect(decision.outcome).toBe('PROCESSED');
    expect(tx.referenceTransactionId).toBe('tx-ref');
    expect(wallet.balance.toJSON().amount).toBe('150.00');
  });

  test('amount is not checked against the referenced BET', () => {
    const tx = makeTx(K.Win, '999.00', { ref: 'ext-ref' });
    expect(run(tx, processedRef(K.Bet, '10.00')).decision.outcome).toBe('PROCESSED');
  });

  test('BET already reversed -> ALREADY_REVERSED', () => {
    const tx = makeTx(K.Win, '50.00', { ref: 'ext-ref' });
    const { wallet, decision } = run(tx, processedRef(K.Bet, '10.00', {}, true));
    expect(decision).toEqual({ outcome: 'REJECTED', code: 'ALREADY_REVERSED' });
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('missing reference -> PENDING_REFERENCE with next attempt', () => {
    const tx = makeTx(K.Win, '50.00', { ref: 'ext-ref' });
    const { decision } = run(tx, null);
    expect(decision).toEqual({ outcome: 'PENDING_REFERENCE', referenceFound: false });
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.nextReferenceAttemptAt).toEqual(
      new Date(at.getTime() + referenceRetryDelayMs(0, DEFAULT_REFERENCE_RETRY)),
    );
    expect(tx.balanceAfter).toBeUndefined();
  });

  test('reference to a WIN -> INVALID_REFERENCE_KIND', () => {
    const tx = makeTx(K.Win, '50.00', { ref: 'ext-ref' });
    expect(run(tx, processedRef(K.Win, '10.00')).decision).toEqual({
      outcome: 'REJECTED',
      code: 'INVALID_REFERENCE_KIND',
    });
  });

  test('rejected BET -> REFERENCE_NOT_PROCESSED', () => {
    const tx = makeTx(K.Win, '50.00', { ref: 'ext-ref' });
    const bet = makeTx(K.Bet, '10.00', { id: 'tx-ref' });
    bet.reject('INSUFFICIENT_FUNDS', at);
    expect(run(tx, { transaction: bet, alreadyReversed: false }).decision).toEqual({
      outcome: 'REJECTED',
      code: 'REFERENCE_NOT_PROCESSED',
    });
  });

  test('BET from another round -> REFERENCE_MISMATCH', () => {
    const tx = makeTx(K.Win, '50.00', { ref: 'ext-ref' });
    expect(run(tx, processedRef(K.Bet, '10.00', { roundId: 'other' })).decision).toEqual({
      outcome: 'REJECTED',
      code: 'REFERENCE_MISMATCH',
    });
  });
});

describe('decideWager credit overflow', () => {
  const nearMax = () =>
    Wallet.rehydrate({
      id: WALLET,
      playerId: PLAYER,
      currency: 'BRL',
      balance: money('999999999999999999.99'),
      version: 1,
      createdAt: at,
      updatedAt: at,
    });

  test('WIN that would exceed the balance limit -> REJECTED BALANCE_LIMIT_EXCEEDED', () => {
    const tx = makeTx(K.Win, '1.00', { ref: 'ext-ref' });
    const { wallet, decision } = run(tx, processedRef(K.Bet, '1.00'), nearMax());
    expect(decision).toEqual({ outcome: 'REJECTED', code: 'BALANCE_LIMIT_EXCEEDED' });
    expect(tx.status).toBe(S.Rejected);
    expect(wallet.balance.toJSON().amount).toBe('999999999999999999.99');
    expect(wallet.version).toBe(1);
  });

  test('pending REFUND that would exceed the limit is terminated as REJECTED', () => {
    const tx = makeTx(K.Refund, '50.00', { ref: 'ext-ref' });
    tx.markPendingReference({ nextAttemptAt: at });
    const decision = reevaluatePendingWager({
      tx,
      wallet: nearMax(),
      reference: processedRef(K.Bet, '50.00'),
      at,
      entryId: 'entry-1',
      retry: DEFAULT_REFERENCE_RETRY,
    });
    expect(decision).toEqual({ outcome: 'REJECTED', code: 'BALANCE_LIMIT_EXCEEDED' });
    expect(tx.status).toBe(S.Rejected);
  });
});

describe('decideWager LOSS', () => {
  test('processes with no ledger entry and leaves the wallet intact', () => {
    const tx = makeTx(K.Loss, '10.00');
    const { wallet, decision } = run(tx);
    expect(decision).toEqual({ outcome: 'PROCESSED', entry: null });
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(tx.balanceAfter?.toJSON().amount).toBe('100.00');
    expect(tx.walletVersionAfter).toBe(1);
  });

  test('with a valid reference links it; with a reversed BET -> ALREADY_REVERSED', () => {
    const ok = makeTx(K.Loss, '10.00', { ref: 'ext-ref' });
    expect(run(ok, processedRef(K.Bet, '10.00')).decision.outcome).toBe('PROCESSED');
    expect(ok.referenceTransactionId).toBe('tx-ref');
    const reversed = makeTx(K.Loss, '10.00', { ref: 'ext-ref' });
    expect(run(reversed, processedRef(K.Bet, '10.00', {}, true)).decision).toEqual({
      outcome: 'REJECTED',
      code: 'ALREADY_REVERSED',
    });
  });
});

describe('decideWager REFUND', () => {
  const refund = (over: TxOver = {}) => makeTx(K.Refund, '30.00', { ref: 'ext-ref', ...over });

  test('credits the referenced BET amount', () => {
    const tx = refund();
    const { wallet, decision } = run(tx, processedRef(K.Bet, '30.00'));
    expect(decision.outcome).toBe('PROCESSED');
    if (decision.outcome !== 'PROCESSED') throw new Error('unreachable');
    expect(decision.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('130.00');
    expect(tx.referenceTransactionId).toBe('tx-ref');
  });

  test('reference to a WIN -> INVALID_REFERENCE_KIND', () => {
    expect(run(refund(), processedRef(K.Win, '30.00')).decision).toEqual({
      outcome: 'REJECTED',
      code: 'INVALID_REFERENCE_KIND',
    });
  });

  test('different amount -> AMOUNT_MISMATCH', () => {
    expect(run(refund(), processedRef(K.Bet, '29.99')).decision).toEqual({
      outcome: 'REJECTED',
      code: 'AMOUNT_MISMATCH',
    });
  });

  test('already reversed -> ALREADY_REVERSED', () => {
    expect(run(refund(), processedRef(K.Bet, '30.00', {}, true)).decision).toEqual({
      outcome: 'REJECTED',
      code: 'ALREADY_REVERSED',
    });
  });

  test('missing reference -> PENDING_REFERENCE', () => {
    expect(run(refund(), null).decision).toEqual({
      outcome: 'PENDING_REFERENCE',
      referenceFound: false,
    });
  });

  test.each([
    ['player', { playerId: 'other' }],
    ['wallet', { walletId: 'other' }],
    ['round', { roundId: 'other' }],
    ['currency', { currency: 'USD' }],
  ])('reference from another %s -> REFERENCE_MISMATCH', (_field, over) => {
    expect(run(refund(), processedRef(K.Bet, '30.00', over)).decision).toEqual({
      outcome: 'REJECTED',
      code: 'REFERENCE_MISMATCH',
    });
  });

  test('mismatch is checked before kind', () => {
    expect(run(refund(), processedRef(K.Win, '30.00', { roundId: 'other' })).decision).toEqual({
      outcome: 'REJECTED',
      code: 'REFERENCE_MISMATCH',
    });
  });
});

describe('decideWager ROLLBACK', () => {
  const rollback = (amount: string) => makeTx(K.Rollback, amount, { ref: 'ext-ref' });

  test('of a BET credits the wallet', () => {
    const { wallet, decision } = run(rollback('30.00'), processedRef(K.Bet, '30.00'));
    expect(decision.outcome).toBe('PROCESSED');
    expect(wallet.balance.toJSON().amount).toBe('130.00');
  });

  test('of a WIN debits the wallet', () => {
    const tx = rollback('50.00');
    const { wallet, decision } = run(tx, processedRef(K.Win, '50.00'));
    expect(decision.outcome).toBe('PROCESSED');
    if (decision.outcome !== 'PROCESSED') throw new Error('unreachable');
    expect(decision.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(tx.balanceAfter?.toJSON().amount).toBe('50.00');
  });

  test('of a WIN with insufficient balance -> REVERSAL_INSUFFICIENT_FUNDS', () => {
    const tx = rollback('150.00');
    const { wallet, decision } = run(tx, processedRef(K.Win, '150.00'));
    expect(decision).toEqual({ outcome: 'REJECTED', code: 'REVERSAL_INSUFFICIENT_FUNDS' });
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(tx.balanceAfter?.toJSON().amount).toBe('100.00');
    expect(tx.walletVersionAfter).toBe(1);
  });

  test('of a REFUND debits the wallet', () => {
    const { wallet, decision } = run(rollback('30.00'), processedRef(K.Refund, '30.00'));
    expect(decision.outcome).toBe('PROCESSED');
    expect(wallet.balance.toJSON().amount).toBe('70.00');
  });

  test('of a LOSS -> INVALID_REFERENCE_KIND', () => {
    expect(run(rollback('30.00'), processedRef(K.Loss, '30.00')).decision).toEqual({
      outcome: 'REJECTED',
      code: 'INVALID_REFERENCE_KIND',
    });
  });
});

describe('decideWager with pending references', () => {
  const pendingRef = (kind: K, status: S) => {
    const ref = makeTx(kind, '50.00', {
      id: 'tx-ref',
      ref: kind === K.Refund || kind === K.Rollback ? 'ext-x' : undefined,
    });
    if (status === S.PendingReference) ref.markPendingReference({ nextAttemptAt: at });
    if (status === S.Rejected) ref.reject('INSUFFICIENT_FUNDS', at);
    if (status === S.Failed) ref.fail('INSUFFICIENT_FUNDS', at);
    return { transaction: ref, alreadyReversed: false } satisfies ReferenceView;
  };
  const rollback = () => makeTx(K.Rollback, '50.00', { ref: 'ext-ref' });

  test('reference still PENDING_REFERENCE -> PENDING_REFERENCE with referenceFound', () => {
    const tx = rollback();
    const { decision } = run(tx, pendingRef(K.Win, S.PendingReference));
    expect(decision).toEqual({ outcome: 'PENDING_REFERENCE', referenceFound: true });
    expect(tx.status).toBe(S.PendingReference);
  });

  test('reference PENDING -> PENDING_REFERENCE with referenceFound', () => {
    const { decision } = run(rollback(), pendingRef(K.Win, S.Pending));
    expect(decision).toEqual({ outcome: 'PENDING_REFERENCE', referenceFound: true });
  });

  test.each([S.Rejected, S.Failed])('reference %s -> REFERENCE_NOT_PROCESSED', (status) => {
    expect(run(rollback(), pendingRef(K.Win, status)).decision).toEqual({
      outcome: 'REJECTED',
      code: 'REFERENCE_NOT_PROCESSED',
    });
  });

  test('tx already PENDING_REFERENCE with missing reference returns without mutating', () => {
    const tx = rollback();
    tx.markPendingReference({ nextAttemptAt: at });
    const { decision } = run(tx, null);
    expect(decision).toEqual({ outcome: 'PENDING_REFERENCE', referenceFound: false });
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt).toEqual(at);
  });

  test('tx already PENDING_REFERENCE with reference now PROCESSED -> PROCESSED', () => {
    const tx = rollback();
    tx.markPendingReference({ nextAttemptAt: at });
    const { decision } = run(tx, processedRef(K.Win, '50.00'));
    expect(decision.outcome).toBe('PROCESSED');
    expect(tx.status).toBe(S.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });
});

describe('decideWager retry policy', () => {
  test('the first wait comes from the policy passed in, not from the default', () => {
    const tx = makeTx(K.Refund, '50.00', { ref: 'ext-ref' });
    const retry = { baseMs: 100, maxMs: 400, maxAttempts: 3 };
    decideWager({ tx, wallet: newWallet(), reference: null, at, entryId: 'entry-1', retry });
    expect(tx.nextReferenceAttemptAt).toEqual(new Date(at.getTime() + 100));
  });
});

describe('reevaluatePendingWager', () => {
  const retry = { baseMs: 100, maxMs: 400, maxAttempts: 3 };
  const pendingRefund = (attempts = 0) => {
    const tx = makeTx(K.Refund, '50.00', { ref: 'ext-ref' });
    tx.markPendingReference({ nextAttemptAt: at });
    for (let i = 0; i < attempts; i += 1) tx.retryReferenceLater(at);
    return tx;
  };
  const reevaluate = (
    tx: WagerTransaction,
    reference: ReferenceView | null,
    wallet = newWallet(),
  ) => ({
    wallet,
    decision: reevaluatePendingWager({ tx, wallet, reference, at, entryId: 'entry-1', retry }),
  });
  const unresolvedBet = () => {
    const bet = makeTx(K.Bet, '50.00', { id: 'tx-ref' });
    return { transaction: bet, alreadyReversed: false } satisfies ReferenceView;
  };

  test('reference still missing -> counts the attempt and waits base * 2^attempts', () => {
    const tx = pendingRefund();
    const { decision } = reevaluate(tx, null);
    expect(decision).toEqual({ outcome: 'PENDING_REFERENCE', referenceFound: false });
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toEqual(new Date(at.getTime() + 200));
  });

  test('the wait is capped by maxMs', () => {
    const tx = pendingRefund(1);
    const longer = { baseMs: 100, maxMs: 150, maxAttempts: 10 };
    reevaluatePendingWager({
      tx,
      wallet: newWallet(),
      reference: null,
      at,
      entryId: 'entry-1',
      retry: longer,
    });
    expect(tx.nextReferenceAttemptAt).toEqual(new Date(at.getTime() + 150));
  });

  test('last attempt with the reference missing -> REJECTED REFERENCE_NOT_FOUND', () => {
    const tx = pendingRefund(2);
    const { wallet, decision } = reevaluate(tx, null);
    expect(decision).toEqual({ outcome: 'REJECTED', code: 'REFERENCE_NOT_FOUND' });
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.balanceAfter?.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('last attempt with the reference found but unresolved -> REFERENCE_NOT_PROCESSED', () => {
    const tx = pendingRefund(2);
    expect(reevaluate(tx, unresolvedBet()).decision).toEqual({
      outcome: 'REJECTED',
      code: 'REFERENCE_NOT_PROCESSED',
    });
  });

  test('reference now PROCESSED -> applies the movement', () => {
    const tx = pendingRefund(1);
    const { wallet, decision } = reevaluate(tx, processedRef(K.Bet, '50.00'));
    expect(decision.outcome).toBe('PROCESSED');
    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(tx.status).toBe(S.Processed);
  });

  test('a business rule still applies (amount mismatch)', () => {
    const tx = pendingRefund();
    expect(reevaluate(tx, processedRef(K.Bet, '10.00')).decision).toEqual({
      outcome: 'REJECTED',
      code: 'AMOUNT_MISMATCH',
    });
  });

  test('a transaction that is not PENDING_REFERENCE is refused', () => {
    const tx = makeTx(K.Refund, '50.00', { ref: 'ext-ref' });
    expect(() => reevaluate(tx, null)).toThrow(InvalidTransactionStateError);
  });
});
