import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { JournalEntry } from '../../../src/domain/wallet/journal-entry';
import { LedgerDirection, opposite } from '../../../src/domain/wallet/ledger-direction';

const at = new Date('2026-10-20T12:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('opposite', () => {
  test('flips DEBIT to CREDIT and back', () => {
    expect(opposite(LedgerDirection.Debit)).toBe(LedgerDirection.Credit);
    expect(opposite(LedgerDirection.Credit)).toBe(LedgerDirection.Debit);
  });
});

describe('JournalEntry', () => {
  test('accountId builds house:{provider}:{currency}', () => {
    expect(JournalEntry.accountId('provider-a', 'BRL')).toBe('house:provider-a:BRL');
  });

  test('create stores the state as is', () => {
    const entry = JournalEntry.create({
      id: 'j1',
      transactionId: 't1',
      accountId: 'house:provider-a:BRL',
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      createdAt: at,
    });
    expect(entry.id).toBe('j1');
    expect(entry.transactionId).toBe('t1');
    expect(entry.accountId).toBe('house:provider-a:BRL');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toJSON().amount).toBe('10.00');
    expect(entry.createdAt).toEqual(at);
  });

  test('create with non-positive money → InvariantViolationError', () => {
    expect(() =>
      JournalEntry.create({
        id: 'j1',
        transactionId: 't1',
        accountId: 'house:provider-a:BRL',
        direction: LedgerDirection.Debit,
        money: brl('0.00'),
        createdAt: at,
      }),
    ).toThrow(InvariantViolationError);
  });

  test('rehydrate preserves the persisted state', () => {
    const entry = JournalEntry.rehydrate({
      id: 'j1',
      transactionId: 't1',
      accountId: 'house:provider-a:BRL',
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      createdAt: at,
    });
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.toJSON().amount).toBe('10.00');
  });
});
