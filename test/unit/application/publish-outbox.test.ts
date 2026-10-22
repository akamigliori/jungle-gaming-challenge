import { describe, expect, test } from 'bun:test';
import { PublishOutboxUseCase } from '../../../src/application/messaging/publish-outbox.use-case';
import type { EventPublisher } from '../../../src/application/ports/event-publisher';
import type {
  ClaimDueParams,
  OutboxRepository,
} from '../../../src/application/ports/outbox.repository';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';

const now = new Date('2026-10-21T12:00:00Z');

function message(id: string, aggregateId: string): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WalletBalanceChanged',
    payload: { eventId: id },
    occurredAt: now,
    attempts: 0,
    nextAttemptAt: now,
  });
}

/** Outbox em memória que registra as chamadas do caso de uso. */
class RecordingOutbox implements OutboxRepository {
  claims: ClaimDueParams[] = [];
  published: string[] = [];
  rescheduled: {
    id: string;
    attempts: number;
    nextAttemptAt?: Date;
    error: string;
    claimedUntil: Date;
  }[] = [];
  postponed: { ids: string[]; until: Date; claimedUntil: Date }[] = [];
  failMarkFor = new Set<string>();

  constructor(private readonly batch: OutboxMessage[]) {}

  async enqueue(): Promise<void> {}

  async claimDue(params: ClaimDueParams): Promise<OutboxMessage[]> {
    this.claims.push(params);
    return this.batch;
  }

  async markPublished(id: string): Promise<void> {
    if (this.failMarkFor.has(id)) throw new Error('db down');
    this.published.push(id);
  }

  async reschedule(
    m: OutboxMessage,
    { error, claimedUntil }: { error: string; claimedUntil: Date },
  ): Promise<void> {
    this.rescheduled.push({
      id: m.id,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt,
      error,
      claimedUntil,
    });
  }

  async postpone(ids: string[], p: { until: Date; claimedUntil: Date }): Promise<void> {
    this.postponed.push({ ids, ...p });
  }
}

function useCase(outbox: OutboxRepository, publisher: EventPublisher) {
  return new PublishOutboxUseCase({
    outbox,
    publisher,
    clock: { now: () => now },
    batchSize: 50,
    leaseMs: 30_000,
    random: () => 1,
  });
}

describe('PublishOutboxUseCase', () => {
  test('claims with now/batchSize/lease and publishes each wallet in order', async () => {
    const outbox = new RecordingOutbox([
      message('a1', 'wa'),
      message('b1', 'wb'),
      message('a2', 'wa'),
      message('a3', 'wa'),
    ]);
    const sent: string[] = [];
    const result = await useCase(outbox, {
      publish: async (m) => {
        sent.push(m.id);
      },
    }).runOnce();

    expect(result).toEqual({ published: 4, failed: 0, failures: [] });
    expect(outbox.claims).toEqual([{ now, limit: 50, leaseMs: 30_000 }]);
    expect(sent.filter((id) => id.startsWith('a'))).toEqual(['a1', 'a2', 'a3']);
    expect(outbox.published.sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  test('a failing publish is rescheduled with backoff and does not stop other wallets', async () => {
    const outbox = new RecordingOutbox([message('a1', 'wa'), message('b1', 'wb')]);
    const result = await useCase(outbox, {
      publish: async (m) => {
        if (m.id === 'a1') throw new Error('sqs down');
      },
    }).runOnce();

    expect(result).toMatchObject({ published: 1, failed: 1 });
    expect(result.failures).toEqual([
      {
        eventId: 'a1',
        eventType: 'WalletBalanceChanged',
        aggregateId: 'wa',
        attempts: 1,
        error: new Error('sqs down'),
      },
    ]);
    expect(outbox.published).toEqual(['b1']);
    expect(outbox.rescheduled).toEqual([
      {
        id: 'a1',
        attempts: 1,
        nextAttemptAt: new Date(now.getTime() + 1000),
        error: 'sqs down',
        claimedUntil: now,
      },
    ]);
  });

  test('a failure stops that wallet for the cycle: the next ones are postponed to the same retry time', async () => {
    const outbox = new RecordingOutbox([
      message('a1', 'wa'),
      message('a2', 'wa'),
      message('a3', 'wa'),
    ]);
    const sent: string[] = [];
    const result = await useCase(outbox, {
      publish: async (m) => {
        sent.push(m.id);
        if (m.id === 'a1') throw new Error('sqs down');
      },
    }).runOnce();

    expect(result).toMatchObject({ published: 0, failed: 1 });
    expect(sent).toEqual(['a1']);
    expect(outbox.published).toEqual([]);
    expect(outbox.postponed).toEqual([
      { ids: ['a2', 'a3'], until: new Date(now.getTime() + 1000), claimedUntil: now },
    ]);
  });

  test('a database error while marking rejects the cycle only after the other wallets finished', async () => {
    const outbox = new RecordingOutbox([message('a1', 'wa'), message('b1', 'wb')]);
    outbox.failMarkFor.add('a1');

    await expect(useCase(outbox, { publish: async () => {} }).runOnce()).rejects.toThrow('db down');
    expect(outbox.published).toEqual(['b1']);
  });

  test('empty batch -> nothing published', async () => {
    const outbox = new RecordingOutbox([]);
    expect(await useCase(outbox, { publish: async () => {} }).runOnce()).toEqual({
      published: 0,
      failed: 0,
      failures: [],
    });
  });
});
