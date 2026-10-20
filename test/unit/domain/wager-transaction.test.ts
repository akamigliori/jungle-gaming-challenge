import { describe, expect, test } from 'bun:test';
import {
  InvalidMoneyError,
  InvariantViolationError,
} from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import {
  InvalidTransactionStateError,
  ReferenceNotAllowedError,
  ReferenceRequiredError,
} from '../../../src/domain/wager/wager-errors';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../src/domain/wager/wager-transaction';
import { WagerTransactionKind as K } from '../../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus as S } from '../../../src/domain/wager/wager-transaction-status';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');

const props = (over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'prov',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1',
  payloadHash: 'hash-1',
  walletId: 'w-1',
  playerId: 'p-1',
  roundId: 'r-1',
  gameId: 'g-1',
  kind: K.Bet,
  money: brl('25.00'),
  createdAt: at,
  ...over,
});
const make = (kind: K, ref?: string) =>
  WagerTransaction.create(props({ kind, referenceExternalTransactionId: ref }));

const outcome = { balanceAfter: brl('10.00'), walletVersionAfter: 2 };

const apply = (tx: WagerTransaction, action: string) => {
  switch (action) {
    case 'markProcessed':
      return tx.markProcessed({ at, ...outcome });
    case 'reject':
      return tx.reject('INSUFFICIENT_FUNDS', at);
    case 'fail':
      return tx.fail('INTERNAL_ERROR', at);
    default:
      return tx.markPendingReference();
  }
};

const inState = (status: S): WagerTransaction => {
  const tx = make(K.Bet);
  if (status === S.PendingReference) tx.markPendingReference();
  if (status === S.Processed) tx.markProcessed({ at, ...outcome });
  if (status === S.Rejected) tx.reject('INSUFFICIENT_FUNDS', at);
  if (status === S.Failed) tx.fail('INTERNAL_ERROR', at);
  return tx;
};

describe('WagerTransaction creation', () => {
  test('create starts PENDING', () => {
    const tx = make(K.Bet);
    expect(tx.status).toBe(S.Pending);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
  });

  test('REFUND/ROLLBACK without reference -> ReferenceRequiredError', () => {
    expect(() => make(K.Refund)).toThrow(ReferenceRequiredError);
    expect(() => make(K.Rollback)).toThrow(ReferenceRequiredError);
    expect(make(K.Refund, 'ext-0').requiresReference()).toBe(true);
  });

  test('BET with reference -> ReferenceNotAllowedError; WIN and LOSS may carry a reference', () => {
    expect(() => make(K.Bet, 'ext-0')).toThrow(ReferenceNotAllowedError);
    expect(make(K.Win, 'ext-0').referenceExternalTransactionId).toBe('ext-0');
    expect(make(K.Loss, 'ext-0').referenceExternalTransactionId).toBe('ext-0');
    expect(new ReferenceNotAllowedError('x').code).toBe('INVALID_PAYLOAD');
    expect(new ReferenceRequiredError('x').code).toBe('REFERENCE_REQUIRED');
  });

  test('non-positive money -> InvalidMoneyError', () => {
    expect(() => WagerTransaction.create(props({ money: brl('0.00') }))).toThrow(InvalidMoneyError);
  });

  test('create rejects kind OPENING; opening() builds internal tx with provider "internal"', () => {
    expect(() => make(K.Opening)).toThrow(InvariantViolationError);
    const tx = WagerTransaction.opening({
      id: 'o-1',
      walletId: 'w-1',
      playerId: 'p-1',
      money: brl('100.00'),
      payloadHash: 'h',
      at,
    });
    expect(tx.status).toBe(S.Pending);
    expect(tx.kind).toBe(K.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.externalTransactionId).toBe('w-1');
    expect(tx.idempotencyKey).toBe('opening:w-1');
    expect(tx.roundId).toBe('opening');
    expect(tx.gameId).toBe('internal');
    expect(tx.payloadHash).toBe('h');
  });

  test('rehydrate restores every field without validation', () => {
    const tx = WagerTransaction.rehydrate({
      ...props({ kind: K.Refund }),
      status: S.Rejected,
      failureCode: 'AMOUNT_MISMATCH',
      processedAt: at,
      balanceAfter: brl('5.00'),
      walletVersionAfter: 3,
      referenceTransactionId: 'tx-0',
    });
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe('AMOUNT_MISMATCH');
    expect(tx.balanceAfter?.toString()).toBe('5.00 BRL');
    expect(tx.walletVersionAfter).toBe(3);
    expect(tx.referenceTransactionId).toBe('tx-0');
  });
});

describe('WagerTransaction transitions', () => {
  test.each([
    [S.Pending, 'markProcessed', S.Processed],
    [S.Pending, 'reject', S.Rejected],
    [S.Pending, 'fail', S.Failed],
    [S.Pending, 'markPendingReference', S.PendingReference],
    [S.PendingReference, 'markProcessed', S.Processed],
    [S.PendingReference, 'reject', S.Rejected],
    [S.PendingReference, 'fail', S.Failed],
  ])('%s --%s--> %s', (from, action, to) => {
    const tx = inState(from);
    apply(tx, action);
    expect(tx.status).toBe(to);
  });

  test.each([S.Processed, S.Rejected, S.Failed])(
    'every transition from %s throws InvalidTransactionStateError',
    (terminal) => {
      for (const action of ['markProcessed', 'reject', 'fail', 'markPendingReference']) {
        const tx = inState(terminal);
        expect(tx.isTerminal()).toBe(true);
        expect(() => apply(tx, action)).toThrow(InvalidTransactionStateError);
        expect(tx.status).toBe(terminal);
      }
    },
  );

  test('PENDING_REFERENCE --markPendingReference--> throws', () => {
    const tx = inState(S.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('markProcessed sets processedAt and balanceAfter; reject sets failureCode', () => {
    const ok = make(K.Refund, 'ext-0');
    ok.markProcessed({ referenceTransactionId: 'tx-0', at, ...outcome });
    expect(ok.processedAt).toEqual(at);
    expect(ok.balanceAfter?.toString()).toBe('10.00 BRL');
    expect(ok.walletVersionAfter).toBe(2);
    expect(ok.referenceTransactionId).toBe('tx-0');
    expect(ok.failureCode).toBeUndefined();

    const bad = make(K.Bet);
    bad.reject('INSUFFICIENT_FUNDS', at, outcome);
    expect(bad.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(bad.processedAt).toEqual(at);
    expect(bad.balanceAfter?.toString()).toBe('10.00 BRL');
    expect(bad.walletVersionAfter).toBe(2);
  });
});

describe('WagerTransaction queries', () => {
  const opening = () =>
    WagerTransaction.opening({
      id: 'o',
      walletId: 'w',
      playerId: 'p',
      money: brl('1.00'),
      payloadHash: 'h',
      at,
    });

  test('ledgerDirectionFor', () => {
    expect(make(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(K.Refund, 'e').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(opening().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rb = make(K.Rollback, 'e');
    expect(rb.ledgerDirectionFor(make(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(make(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(make(K.Refund, 'e'))).toBe(LedgerDirection.Debit);
    expect(() => make(K.Loss).ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test('affectsBalance false only for LOSS; requiresReference true only for REFUND/ROLLBACK', () => {
    for (const kind of Object.values(K)) {
      const tx =
        kind === K.Opening
          ? opening()
          : make(kind, kind === K.Refund || kind === K.Rollback ? 'e' : undefined);
      expect(tx.affectsBalance()).toBe(kind !== K.Loss);
      expect(tx.requiresReference()).toBe(kind === K.Refund || kind === K.Rollback);
    }
  });

  test('matchesPayload compares hashes', () => {
    const tx = make(K.Bet);
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('other')).toBe(false);
  });
});
