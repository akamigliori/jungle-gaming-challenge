import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvariantViolationError,
} from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import {
  BalanceLimitExceededError,
  InsufficientFundsError,
  ReversalInsufficientFundsError,
} from '../../../src/domain/wallet/wallet-errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-01-01T00:00:00Z');
const move = (money: Money, n = 1) => ({ money, transactionId: `t${n}`, entryId: `e${n}`, at });

const open = (initialBalance: Money) =>
  Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance,
    openingTransactionId: 't0',
    openingEntryId: 'e0',
    at,
  });

describe('Wallet', () => {
  test('open with 100.00: version 1, balance 100.00, one CREDIT entry 0.00→100.00 walletVersion 1', () => {
    const { wallet, openingEntry } = open(brl('100.00'));
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).not.toBeNull();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('100.00');
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe('t0');
    expect(openingEntry?.id).toBe('e0');
  });

  test('open with 0.00: version 1, openingEntry null', () => {
    const { wallet, openingEntry } = open(brl('0.00'));
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(openingEntry).toBeNull();
  });

  test('open rejects negative initial balance', () => {
    expect(() => open(brl('1.00').negate())).toThrow(InvariantViolationError);
  });

  test('debit 30 from 100: balance 70.00, version 2, DEBIT entry 100.00→70.00 walletVersion 2', () => {
    const { wallet } = open(brl('100.00'));
    const entry = wallet.debit(move(brl('30.00')));
    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.walletId).toBe('w1');
  });

  test('debit more than balance (WAGER) throws InsufficientFundsError; balance and version unchanged', () => {
    const { wallet } = open(brl('100.00'));
    expect(() => wallet.debit(move(brl('100.01')))).toThrow(InsufficientFundsError);
    expect(() => wallet.debit(move(brl('100.01')), 'WAGER')).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('debit more than balance (REVERSAL) throws ReversalInsufficientFundsError', () => {
    const { wallet } = open(brl('100.00'));
    expect(() => wallet.debit(move(brl('100.01')), 'REVERSAL')).toThrow(
      ReversalInsufficientFundsError,
    );
    expect(wallet.version).toBe(1);
  });

  test('debit exactly the balance leaves 0.00', () => {
    const { wallet } = open(brl('100.00'));
    wallet.debit(move(brl('100.00')));
    expect(wallet.balance.toJSON().amount).toBe('0.00');
  });

  test('credit beyond the NUMERIC(20,2) range throws BalanceLimitExceededError, wallet intact', () => {
    const { wallet } = open(brl('999999999999999999.99'));
    expect(() => wallet.credit(move(brl('0.01')))).toThrow(BalanceLimitExceededError);
    expect(wallet.balance.toJSON().amount).toBe('999999999999999999.99');
    expect(wallet.version).toBe(1);
  });

  test('credit/debit in another currency throws CurrencyMismatchError', () => {
    const { wallet } = open(brl('100.00'));
    expect(() => wallet.credit(move(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(move(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate does not validate (accepts state as-is) and keeps version', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('5.00').subtract(brl('9.00')),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.isNegative()).toBe(true);
  });

  test('sequence open 100, debit 30, credit 50 → 120.00, version 3, sum of entries equals balance', () => {
    const later = new Date('2026-01-02T00:00:00Z');
    const { wallet, openingEntry } = open(brl('100.00'));
    const d = wallet.debit(move(brl('30.00'), 1));
    const c = wallet.credit({ ...move(brl('50.00'), 2), at: later });
    expect(wallet.balance.toJSON().amount).toBe('120.00');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(later);
    const entries = [openingEntry, d, c];
    let sum = Money.zero('BRL');
    for (const e of entries) {
      if (!e) throw new Error('missing entry');
      sum = e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money);
    }
    expect(sum.equals(wallet.balance)).toBe(true);
  });
});
