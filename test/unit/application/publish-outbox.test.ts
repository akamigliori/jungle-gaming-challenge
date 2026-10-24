import { describe, expect, test } from 'bun:test';
import { PublishOutboxUseCase } from '../../../src/application/messaging/publish-outbox.use-case';
import type {
  BatchPublishResult,
  EventPublisher,
} from '../../../src/application/ports/event-publisher';
import type {
  ClaimDueParams,
  OutboxRepository,
} from '../../../src/application/ports/outbox.repository';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { noopMetrics } from '../../support/noop-metrics';

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
  failMarkFor = new Set<string>();

  constructor(private readonly batch: OutboxMessage[]) {}

  async enqueue(): Promise<void> {}
  async enqueueMany(): Promise<void> {}

  async claimDue(params: ClaimDueParams): Promise<OutboxMessage[]> {
    this.claims.push(params);
    return this.batch;
  }

  async markPublished(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (this.failMarkFor.has(id)) throw new Error('db down');
    this.published.push(...ids);
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

  async deletePublishedOlderThan(): Promise<number> {
    return 0;
  }
}

function useCase(outbox: OutboxRepository, publisher: EventPublisher) {
  return new PublishOutboxUseCase({
    outbox,
    publisher,
    clock: { now: () => now },
    metrics: noopMetrics,
    batchSize: 50,
    leaseMs: 30_000,
    random: () => 1,
  });
}

describe('PublishOutboxUseCase', () => {
  test('claims with now/batchSize/lease and publishes all messages in one batch', async () => {
    const outbox = new RecordingOutbox([
      message('a1', 'wa'),
      message('b1', 'wb'),
      message('a2', 'wa'),
      message('a3', 'wa'),
    ]);
    const chunks: OutboxMessage[][] = [];
    const result = await useCase(outbox, {
      publishBatch: async (msgs) => {
        chunks.push(msgs);
        return { published: msgs.map((m) => m.id), failed: [] };
      },
    }).runOnce();

    expect(result).toEqual({ published: 4, failed: 0, failures: [] });
    expect(outbox.claims).toEqual([{ now, limit: 50, leaseMs: 30_000 }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.map((m) => m.id)).toEqual(['a1', 'b1', 'a2', 'a3']);
    expect(outbox.published).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  test('a failing entry is rescheduled with backoff and the others are published', async () => {
    const outbox = new RecordingOutbox([message('a1', 'wa'), message('b1', 'wb')]);
    const result = await useCase(outbox, {
      publishBatch: async (): Promise<BatchPublishResult> => ({
        published: ['b1'],
        failed: [{ id: 'a1', error: 'sqs down' }],
      }),
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

  test('a whole-batch send failure reschedules every message', async () => {
    const outbox = new RecordingOutbox([message('a1', 'wa'), message('b1', 'wb')]);
    const result = await useCase(outbox, {
      publishBatch: async () => {
        throw new Error('sqs down');
      },
    }).runOnce();

    expect(result).toMatchObject({ published: 0, failed: 2 });
    expect(outbox.published).toEqual([]);
    expect(outbox.rescheduled.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
  });

  test('sends the claimed batch in chunks of up to 10', async () => {
    const messages = Array.from({ length: 25 }, (_, i) => message(`m${i}`, `w${i}`));
    const outbox = new RecordingOutbox(messages);
    const chunkSizes: number[] = [];
    await useCase(outbox, {
      publishBatch: async (msgs) => {
        chunkSizes.push(msgs.length);
        return { published: msgs.map((m) => m.id), failed: [] };
      },
    }).runOnce();

    expect(chunkSizes).toEqual([10, 10, 5]);
    expect(outbox.published).toHaveLength(25);
  });

  test('a database error while marking rejects the cycle', async () => {
    const outbox = new RecordingOutbox([message('a1', 'wa'), message('b1', 'wb')]);
    outbox.failMarkFor.add('a1');

    await expect(
      useCase(outbox, {
        publishBatch: async (msgs) => ({ published: msgs.map((m) => m.id), failed: [] }),
      }).runOnce(),
    ).rejects.toThrow('db down');
  });

  test('empty batch -> nothing published', async () => {
    const outbox = new RecordingOutbox([]);
    expect(
      await useCase(outbox, {
        publishBatch: async () => ({ published: [], failed: [] }),
      }).runOnce(),
    ).toEqual({ published: 0, failed: 0, failures: [] });
  });
});
