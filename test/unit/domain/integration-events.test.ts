import { describe, expect, test } from 'bun:test';
import { WagerTransactionPendingReference } from '../../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-20T12:00:00Z');
const ctx = { eventId: 'ev1', correlationId: 'corr1', occurredAt: at };

const newTx = (kind = WagerTransactionKind.Bet, reference?: string) =>
  WagerTransaction.create({
    id: 't1',
    providerId: 'prov',
    externalTransactionId: 'ext1',
    idempotencyKey: 'k1',
    payloadHash: 'h',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl('30.00'),
    referenceExternalTransactionId: reference,
    createdAt: at,
  });

describe('integration events', () => {
  test('WalletBalanceChanged.toJSON has eventType, version 1, ISO occurredAt and MoneyProps strings (no Money instance)', () => {
    const { wallet } = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      initialBalance: brl('100.00'),
      openingTransactionId: 'tx0',
      openingEntryId: 'e0',
      at,
    });
    const entry = WalletLedgerEntry.create({
      id: 'e1',
      walletId: 'w1',
      transactionId: 't1',
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('70.00'),
      walletVersion: 2,
      createdAt: at,
    });
    const event = WalletBalanceChanged.from(wallet, entry, { ...ctx, causationId: 'cause1' });
    const json = JSON.parse(JSON.stringify(event.toJSON()));
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w1');
    expect(json.causationId).toBe('cause1');
    expect(json.occurredAt).toBe('2026-10-20T12:00:00.000Z');
    expect(json.data.money).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(json.data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(json.data.balanceAfter).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(json.data.direction).toBe('DEBIT');
    expect(json.data.transactionId).toBe('t1');
    expect(json.data.walletId).toBe('w1');
  });

  test('toJSON omits causationId when undefined', () => {
    const tx = newTx();
    tx.reject('INSUFFICIENT_FUNDS', at);
    const json = WagerTransactionRejected.from(tx, ctx).toJSON();
    expect('causationId' in json).toBe(false);
  });

  test('WagerTransactionProcessed carries transaction data, balanceAfter and reference', () => {
    const tx = newTx(WagerTransactionKind.Bet);
    tx.markProcessed({ at, balanceAfter: brl('70.00'), walletVersionAfter: 2 });
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('w1');
    expect(event.data).toEqual({
      transactionId: 't1',
      providerId: 'prov',
      externalTransactionId: 'ext1',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
    });
    expect('referenceTransactionId' in event.data).toBe(false);

    const win = newTx(WagerTransactionKind.Refund, 'ext0');
    win.markProcessed({
      referenceTransactionId: 'tref',
      at,
      balanceAfter: brl('100.00'),
      walletVersionAfter: 3,
    });
    expect(WagerTransactionProcessed.from(win, ctx).data.referenceTransactionId).toBe('tref');
  });

  test('WagerTransactionProcessed.from throws when transaction is not processed', () => {
    expect(() => WagerTransactionProcessed.from(newTx(), ctx)).toThrow(InvariantViolationError);
  });

  test('WagerTransactionRejected carries failureCode', () => {
    const tx = newTx();
    tx.reject('INSUFFICIENT_FUNDS', at);
    const event = WagerTransactionRejected.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('w1');
    expect(event.data).toEqual({
      transactionId: 't1',
      providerId: 'prov',
      externalTransactionId: 'ext1',
      walletId: 'w1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(() => WagerTransactionRejected.from(newTx(), ctx)).toThrow(InvariantViolationError);
  });

  test('WagerTransactionPendingReference carries the missing reference', () => {
    const tx = newTx(WagerTransactionKind.Refund, 'ext0');
    tx.markPendingReference();
    const event = WagerTransactionPendingReference.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.version).toBe(1);
    expect(event.data).toEqual({
      transactionId: 't1',
      providerId: 'prov',
      externalTransactionId: 'ext1',
      walletId: 'w1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext0',
    });
  });

  test('each event subclass exposes its eventType on the type, not passed by caller', () => {
    const tx = newTx(WagerTransactionKind.Refund, 'ext0');
    tx.markPendingReference();
    const event = WagerTransactionPendingReference.from(tx, ctx);
    const type: 'WagerTransactionPendingReference' = event.eventType;
    const version: 1 = event.version;
    expect(type).toBe('WagerTransactionPendingReference');
    expect(version).toBe(1);
  });
});
