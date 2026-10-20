import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';

const receivedAt = new Date('2026-10-20T12:00:00Z');

describe('InboxMessage', () => {
  test('receive -> not processed; markProcessed -> processed; second markProcessed throws', () => {
    const msg = InboxMessage.receive({
      messageId: 'm1',
      consumerName: 'wager-consumer',
      payloadHash: 'h1',
      receivedAt,
    });
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();

    const at = new Date('2026-10-20T12:00:01Z');
    msg.markProcessed(at);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(at);
    expect(() => msg.markProcessed(at)).toThrow(InvariantViolationError);
  });

  test('rehydrate keeps processedAt as-is', () => {
    const at = new Date('2026-10-20T12:00:01Z');
    const msg = InboxMessage.rehydrate({
      messageId: 'm1',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt,
      processedAt: at,
    });
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(at);
  });
});
