import { describe, expect, test } from 'bun:test';
import { parseWagerMessage } from '../../../src/interfaces/sqs/wager-message.schema';

const validMessage = () => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

const parse = (message: unknown) => parseWagerMessage(JSON.stringify(message));

describe('parseWagerMessage', () => {
  test('accepts the message from the contract', () => {
    const result = parse(validMessage());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.data.money.amount).toBe('25.00');
  });

  test('rejects a numeric amount', () => {
    const message = validMessage();
    (message.data.money as { amount: unknown }).amount = 25;
    expect(parse(message).ok).toBe(false);
  });

  test('rejects an unknown key in the envelope', () => {
    expect(parse({ ...validMessage(), extra: 1 }).ok).toBe(false);
  });

  test('rejects an unknown key in data', () => {
    const message = validMessage();
    expect(parse({ ...message, data: { ...message.data, extra: 1 } }).ok).toBe(false);
  });

  test('rejects a different type', () => {
    expect(parse({ ...validMessage(), type: 'Other' }).ok).toBe(false);
  });

  test('rejects data without idempotencyKey', () => {
    const { idempotencyKey: _omitted, ...data } = validMessage().data;
    expect(parse({ ...validMessage(), data }).ok).toBe(false);
  });

  test('rejects a malformed occurredAt', () => {
    expect(parse({ ...validMessage(), occurredAt: '29/07/2026 15:00' }).ok).toBe(false);
  });

  test('rejects a messageId longer than 255 characters', () => {
    expect(parse({ ...validMessage(), messageId: 'm'.repeat(256) }).ok).toBe(false);
  });

  test('rejects invalid JSON', () => {
    expect(parseWagerMessage('{').ok).toBe(false);
  });

  test('lowercases uppercase UUIDs', () => {
    const message = validMessage();
    message.data.walletId = message.data.walletId.toUpperCase();
    const result = parse(message);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.data.walletId).toBe(validMessage().data.walletId);
  });
});
