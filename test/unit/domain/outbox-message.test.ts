import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const occurredAt = new Date('2026-10-20T12:00:00Z');

function makeEvent(): WalletBalanceChanged {
  const { wallet } = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx0',
    openingEntryId: 'e0',
    at: occurredAt,
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
    createdAt: occurredAt,
  });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'ev1',
    correlationId: 'c1',
    occurredAt,
  });
}

describe('OutboxMessage', () => {
  test('enqueue -> pending, due at occurredAt, attempts 0, payload equals event.toJSON()', () => {
    const event = makeEvent();
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe('ev1');
    expect(msg.aggregateId).toBe('w1');
    expect(msg.eventType).toBe('WalletBalanceChanged');
    expect(msg.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect(msg.occurredAt).toEqual(occurredAt);
    expect(msg.attempts).toBe(0);
    expect(msg.nextAttemptAt).toEqual(occurredAt);
    expect(msg.publishedAt).toBeUndefined();
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(occurredAt)).toBe(true);
  });

  test('enqueue with a walletVersion stores it; without, it stays undefined', () => {
    const event = makeEvent();
    expect(OutboxMessage.enqueue(event, 2).walletVersion).toBe(2);
    expect(OutboxMessage.enqueue(event).walletVersion).toBeUndefined();
  });

  test('scheduleRetry with random=()=>1 -> delays 1s, 2s, 4s ... capped at 300s', () => {
    const msg = OutboxMessage.enqueue(makeEvent());
    const now = new Date('2026-10-20T13:00:00Z');
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      msg.scheduleRetry(now, () => 1);
      delays.push((msg.nextAttemptAt as Date).getTime() - now.getTime());
    }
    expect(msg.attempts).toBe(12);
    expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(delays[8]).toBe(256_000);
    expect(delays.slice(9)).toEqual([300_000, 300_000, 300_000]);
  });

  test('scheduleRetry with random=()=>0 -> half of the delay', () => {
    const msg = OutboxMessage.enqueue(makeEvent());
    const now = new Date('2026-10-20T13:00:00Z');
    msg.scheduleRetry(now, () => 0);
    expect((msg.nextAttemptAt as Date).getTime() - now.getTime()).toBe(500);
    msg.scheduleRetry(now, () => 0);
    expect((msg.nextAttemptAt as Date).getTime() - now.getTime()).toBe(1000);
  });

  test('isDue(now) false before nextAttemptAt, false after markPublished', () => {
    const msg = OutboxMessage.enqueue(makeEvent());
    const now = new Date('2026-10-20T13:00:00Z');
    msg.scheduleRetry(now, () => 1);
    expect(msg.isDue(now)).toBe(false);
    expect(msg.isDue(new Date(now.getTime() + 1000))).toBe(true);

    const at = new Date(now.getTime() + 2000);
    msg.markPublished(at);
    expect(msg.publishedAt).toEqual(at);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(new Date(now.getTime() + 10_000))).toBe(false);
  });
});

describe('OutboxMessage.rehydrate / markPublished', () => {
  const state = {
    id: 'ev9',
    aggregateId: 'w9',
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: 'ev9' },
    occurredAt,
    attempts: 3,
    nextAttemptAt: new Date('2026-10-20T12:05:00Z'),
  };

  test('rehydrate keeps the persisted state as is', () => {
    const msg = OutboxMessage.rehydrate(state);
    expect(msg.id).toBe('ev9');
    expect(msg.aggregateId).toBe('w9');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.payload).toEqual({ eventId: 'ev9' });
    expect(msg.attempts).toBe(3);
    expect(msg.nextAttemptAt).toEqual(new Date('2026-10-20T12:05:00Z'));
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(new Date('2026-10-20T12:04:59Z'))).toBe(false);
    expect(msg.isDue(new Date('2026-10-20T12:05:00Z'))).toBe(true);
  });

  test('rehydrate keeps the persisted walletVersion', () => {
    const msg = OutboxMessage.rehydrate({ ...state, walletVersion: 3 });
    expect(msg.walletVersion).toBe(3);
    expect(OutboxMessage.rehydrate(state).walletVersion).toBeUndefined();
  });

  test('rehydrate of a published message -> not pending', () => {
    const publishedAt = new Date('2026-10-20T12:06:00Z');
    const msg = OutboxMessage.rehydrate({ ...state, publishedAt });
    expect(msg.publishedAt).toEqual(publishedAt);
    expect(msg.isPending()).toBe(false);
  });

  test('markPublished twice -> InvariantViolationError, first publishedAt kept', () => {
    const msg = OutboxMessage.rehydrate(state);
    const first = new Date('2026-10-20T12:06:00Z');
    msg.markPublished(first);
    expect(() => msg.markPublished(new Date('2026-10-20T12:07:00Z'))).toThrow(
      InvariantViolationError,
    );
    expect(msg.publishedAt).toEqual(first);
  });
});
