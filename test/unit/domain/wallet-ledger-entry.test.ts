import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvariantViolationError,
} from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const props = (over: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) => ({
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  direction: LedgerDirection.Credit,
  money: brl('100.00'),
  balanceBefore: brl('0.00'),
  balanceAfter: brl('100.00'),
  walletVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('WalletLedgerEntry', () => {
  test('create accepts balanced CREDIT and DEBIT', () => {
    const credit = WalletLedgerEntry.create(props());
    expect(credit.isBalanced()).toBe(true);
    const debit = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
      }),
    );
    expect(debit.isBalanced()).toBe(true);
    expect(debit.balanceAfter.toJSON().amount).toBe('70.00');
  });

  test('create throws InvariantViolationError when unbalanced', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Debit,
          money: brl('30.00'),
          balanceBefore: brl('100.00'),
          balanceAfter: brl('80.00'),
        }),
      ),
    ).toThrow(InvariantViolationError);
  });

  test('create throws on non-positive money, negative balanceAfter, mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0.00'), balanceAfter: brl('0.00') })),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Debit,
          money: brl('30.00'),
          balanceBefore: brl('10.00'),
          balanceAfter: brl('10.00').subtract(brl('30.00')),
        }),
      ),
    ).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create(props({ balanceBefore: usd('0.00') }))).toThrow(
      CurrencyMismatchError,
    );
  });

  test('has no setters/mutating methods', () => {
    expect(Object.getOwnPropertyNames(WalletLedgerEntry.prototype).sort()).toEqual([
      'constructor',
      'isBalanced',
    ]);
  });

  test('rehydrate keeps state without validating', () => {
    const e = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('999.00') }));
    expect(e.isBalanced()).toBe(false);
    expect(e.walletVersion).toBe(1);
  });
});
