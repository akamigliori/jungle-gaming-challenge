import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxUseCase } from '../../src/application/messaging/publish-outbox.use-case';
import type { Clock } from '../../src/application/ports/clock';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '../../src/application/ports/outbox.repository';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { loadConfig } from '../../src/infrastructure/config/config';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs.client';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { noopMetrics } from '../support/noop-metrics';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';

const LEASE_MS = 30_000;
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });

let orm: MikroORM;
let t: TestApp;
let sqs: SQSClient;
let queueUrl: string;
let outbox: OutboxRepository;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

/** Relógio controlado pelo teste: só anda quando o teste manda. */
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface ReceivedEvent {
  eventId: string;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  body: Record<string, unknown>;
}

/**
 * Lê (e apaga) as mensagens da fila de eventos até `expected` mensagens ou até
 * `emptyPolls` leituras seguidas sem nada.
 */
async function receiveEvents(expected: number, emptyPolls = 2): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  let empty = 0;
  while (received.length < expected && empty < emptyPolls) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    if (Messages.length === 0) {
      empty += 1;
      continue;
    }
    empty = 0;
    for (const m of Messages) {
      const body = JSON.parse(m.Body ?? '{}') as Record<string, unknown>;
      received.push({
        eventId: String(body.eventId),
        groupId: m.Attributes?.MessageGroupId,
        deduplicationId: m.Attributes?.MessageDeduplicationId,
        body,
      });
    }
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
  return received;
}

interface SeededEvent {
  id: string;
  aggregateId: string;
}

/** Grava `count` eventos pendentes na outbox, distribuídos entre `aggregates` wallets. */
async function seedOutbox(count: number, at: Date, aggregates = 1): Promise<SeededEvent[]> {
  const walletIds = Array.from({ length: aggregates }, () => crypto.randomUUID());
  const events: SeededEvent[] = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    const aggregateId = walletIds[i % aggregates] as string;
    const occurredAt = new Date(at.getTime() - (count - i));
    const payload = {
      eventId: id,
      eventType: 'WalletBalanceChanged',
      aggregateId,
      correlationId: 'c1',
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data: { walletId: aggregateId, walletVersion: i + 1 },
    };
    await sql(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES (?, ?, 'WalletBalanceChanged', ?::JSONB, ?, 0, ?)`,
      [id, aggregateId, JSON.stringify(payload), occurredAt, occurredAt],
    );
    events.push({ id, aggregateId });
  }
  return events;
}

interface OutboxRow {
  id: string;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
  last_error: string | null;
}

async function outboxRows(): Promise<OutboxRow[]> {
  const rows = await sql<Record<string, unknown>>(
    'SELECT id, attempts, next_attempt_at, published_at, last_error FROM outbox_messages ORDER BY occurred_at, id',
  );
  // consultas SQL diretas devolvem TIMESTAMPTZ como texto
  return rows.map((r) => ({
    id: r.id as string,
    attempts: r.attempts as number,
    next_attempt_at: new Date(r.next_attempt_at as string),
    published_at: r.published_at === null ? null : new Date(r.published_at as string),
    last_error: r.last_error as string | null,
  }));
}

function newPublisher(clock: Clock, publisher?: EventPublisher, batchSize = 50) {
  return new PublishOutboxUseCase({
    outbox,
    publisher: publisher ?? new SqsEventPublisher(sqs, config),
    clock,
    metrics: noopMetrics,
    batchSize,
    leaseMs: LEASE_MS,
  });
}

/** Roda o publisher até um ciclo não encontrar nada para publicar. */
async function drain(useCase: PublishOutboxUseCase): Promise<number> {
  let published = 0;
  for (;;) {
    const r = await useCase.runOnce();
    published += r.published;
    if (r.published + r.failed === 0) return published;
  }
}

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp();
  outbox = t.app.get<OutboxRepository>(OUTBOX_REPOSITORY);
  sqs = createSqsClient(config);
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.sqs.queues.events }),
  );
  queueUrl = QueueUrl as string;
});

afterAll(async () => {
  await t.close();
  sqs.destroy();
  await orm.close(true);
});

beforeEach(async () => {
  await resetDb(orm);
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
});

afterEach(async () => {
  await assertLedgerInvariant(orm);
});

describe('outbox publisher', () => {
  test('publishes a pending event once (group = wallet, dedup = eventId) and marks it published', async () => {
    const clock = new FakeClock(new Date());
    const [event] = await seedOutbox(1, clock.now());

    expect(await newPublisher(clock).runOnce()).toMatchObject({ published: 1, failed: 0 });

    const received = await receiveEvents(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.eventId).toBe(event?.id as string);
    expect(received[0]?.groupId).toBe(event?.aggregateId);
    expect(received[0]?.deduplicationId).toBe(event?.id);
    expect(received[0]?.body.eventType).toBe('WalletBalanceChanged');

    const [row] = await outboxRows();
    expect(row?.published_at).toEqual(clock.now());
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBeNull();
  });

  test('a wallet with an unpublished balance event only claims its head (lowest wallet_version)', async () => {
    const clock = new FakeClock(new Date());
    const now = clock.now();
    const walletId = crypto.randomUUID();
    const v1 = crypto.randomUUID();
    const v2 = crypto.randomUUID();
    const insert = (id: string, version: number) =>
      sql(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, wallet_version)
         VALUES (?, ?, 'WalletBalanceChanged', '{}'::JSONB, ?, 0, ?, ?)`,
        [id, walletId, now, now, version],
      );
    await insert(v1, 1);
    await insert(v2, 2);

    const first = await outbox.claimDue({ now, limit: 10, leaseMs: LEASE_MS });
    expect(first.map((m) => m.id)).toEqual([v1]);
    expect(first[0]?.walletVersion).toBe(1);

    await outbox.markPublished(v1, now);
    const second = await outbox.claimDue({ now, limit: 10, leaseMs: LEASE_MS });
    expect(second.map((m) => m.id)).toEqual([v2]);
    expect(second[0]?.walletVersion).toBe(2);
  });

  test('publishes balance events in wallet_version order even when occurred_at is out of order', async () => {
    const clock = new FakeClock(new Date());
    const base = clock.now().getTime();
    const walletId = crypto.randomUUID();
    // ocorre fora de ordem: v1 com occurred_at mais novo, v3 com o mais antigo — só a versão ordena
    const seeds = [
      { version: 1, occurredAt: new Date(base - 1000) },
      { version: 2, occurredAt: new Date(base - 2000) },
      { version: 3, occurredAt: new Date(base - 3000) },
    ];
    for (const s of seeds) {
      const id = crypto.randomUUID();
      const payload = {
        eventId: id,
        eventType: 'WalletBalanceChanged',
        aggregateId: walletId,
        correlationId: 'c1',
        occurredAt: s.occurredAt.toISOString(),
        version: 1,
        data: { walletId, walletVersion: s.version },
      };
      await sql(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, wallet_version)
         VALUES (?, ?, 'WalletBalanceChanged', ?::JSONB, ?, 0, ?, ?)`,
        [id, walletId, JSON.stringify(payload), s.occurredAt, clock.now(), s.version],
      );
    }

    expect(await drain(newPublisher(clock))).toBe(3);
    const received = await receiveEvents(3);
    const versions = received.map((r) => (r.body.data as { walletVersion: number }).walletVersion);
    expect(versions).toEqual([1, 2, 3]);
  });

  test('a second run does not republish what was already published', async () => {
    const clock = new FakeClock(new Date());
    await seedOutbox(3, clock.now());
    const useCase = newPublisher(clock);

    expect(await useCase.runOnce()).toMatchObject({ published: 3, failed: 0 });
    clock.advance(LEASE_MS * 10);
    expect(await useCase.runOnce()).toMatchObject({ published: 0, failed: 0 });

    expect(await receiveEvents(4)).toHaveLength(3);
  });

  test('publisher failure -> attempts 1, retry in the future, last_error set; the rest of the batch is still published', async () => {
    const clock = new FakeClock(new Date());
    const [failing, ...others] = await seedOutbox(3, clock.now(), 3);
    const real = new SqsEventPublisher(sqs, config);
    const flaky: EventPublisher = {
      publishBatch: async (messages) => {
        const toSend = messages.filter((m) => m.id !== failing?.id);
        const { published, failed } = await real.publishBatch(toSend);
        return {
          published,
          failed: [
            ...failed,
            ...(failing ? [{ id: failing.id, error: `sqs unavailable ${'x'.repeat(1000)}` }] : []),
          ],
        };
      },
    };

    expect(await newPublisher(clock, flaky).runOnce()).toMatchObject({ published: 2, failed: 1 });

    const rows = new Map((await outboxRows()).map((r) => [r.id, r]));
    const failed = rows.get(failing?.id as string);
    expect(failed?.published_at).toBeNull();
    expect(failed?.attempts).toBe(1);
    expect(failed?.next_attempt_at.getTime()).toBeGreaterThan(clock.now().getTime());
    expect(failed?.last_error).toStartWith('sqs unavailable');
    expect(failed?.last_error).toHaveLength(500);
    for (const e of others) expect(rows.get(e.id)?.published_at).toEqual(clock.now());

    const received = await receiveEvents(3);
    expect(received.map((r) => r.eventId).sort()).toEqual(others.map((e) => e.id).sort());

    // depois do backoff a mensagem volta a ser elegível e é publicada
    clock.advance(LEASE_MS);
    expect(await newPublisher(clock).runOnce()).toMatchObject({ published: 1, failed: 0 });
    expect((await receiveEvents(1)).map((r) => r.eventId)).toEqual([failing?.id as string]);
  });

  test('two concurrent publishers over 100 events -> every event received, none claimed twice, none left pending', async () => {
    const clock = new FakeClock(new Date());
    const events = await seedOutbox(100, clock.now(), 10);
    const a = newPublisher(clock, undefined, 10);
    const b = newPublisher(clock, undefined, 10);

    const [publishedByA, publishedByB] = await Promise.all([drain(a), drain(b)]);

    // SKIP LOCKED + lease: cada linha foi reservada por um único publisher
    expect(publishedByA + publishedByB).toBe(100);
    const pending = await sql<{ n: string }>(
      'SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(Number(pending[0]?.n)).toBe(0);

    const received = await receiveEvents(100);
    const receivedIds = new Set(received.map((r) => r.eventId));
    for (const e of events) expect(receivedIds.has(e.id)).toBe(true);
  });

  test('lease: a claimed batch that is never published is not re-claimed before the lease expires, and is published after it', async () => {
    const clock = new FakeClock(new Date());
    const [event] = await seedOutbox(1, clock.now());

    // a instância "morre" logo depois de reservar o lote (commit do claim, nada publicado)
    const claimed = await outbox.claimDue({ now: clock.now(), limit: 50, leaseMs: LEASE_MS });
    expect(claimed.map((m) => m.id)).toEqual([event?.id as string]);

    const survivor = newPublisher(clock);
    clock.advance(LEASE_MS - 1);
    expect(await survivor.runOnce()).toMatchObject({ published: 0, failed: 0 });
    expect(await receiveEvents(1, 1)).toHaveLength(0);

    clock.advance(1);
    expect(await survivor.runOnce()).toMatchObject({ published: 1, failed: 0 });
    expect((await receiveEvents(1)).map((r) => r.eventId)).toEqual([event?.id as string]);
    const [row] = await outboxRows();
    expect(row?.published_at).toEqual(clock.now());
  });

  test('a late failure from an expired lease does not overwrite the new claim nor its attempts', async () => {
    const clock = new FakeClock(new Date());
    await seedOutbox(1, clock.now());

    // A reserva, demora mais que o lease; B reserva de novo
    const [stale] = await outbox.claimDue({ now: clock.now(), limit: 1, leaseMs: LEASE_MS });
    const staleClaim = stale?.nextAttemptAt as Date;
    clock.advance(LEASE_MS);
    await outbox.claimDue({ now: clock.now(), limit: 1, leaseMs: LEASE_MS });
    const newLease = new Date(clock.now().getTime() + LEASE_MS);

    // só então a falha de A chega
    stale?.scheduleRetry(clock.now(), () => 1);
    await outbox.reschedule(stale as OutboxMessage, {
      error: 'late failure',
      claimedUntil: staleClaim,
    });

    const [row] = await outboxRows();
    expect(row?.next_attempt_at).toEqual(newLease);
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBeNull();
  });

  test('a failure reschedules the message and does not block the rest of the batch', async () => {
    const clock = new FakeClock(new Date());
    const [first] = await seedOutbox(2, clock.now());
    const real = new SqsEventPublisher(sqs, config);
    let failOnce = true;
    const flaky: EventPublisher = {
      publishBatch: async (messages) => {
        const failNow = failOnce && messages.some((m) => m.id === first?.id);
        if (failNow) failOnce = false;
        const toSend = failNow ? messages.filter((m) => m.id !== first?.id) : messages;
        const { published, failed } = await real.publishBatch(toSend);
        return {
          published,
          failed: [
            ...failed,
            ...(failNow ? [{ id: first?.id as string, error: 'sqs unavailable' }] : []),
          ],
        };
      },
    };
    const useCase = newPublisher(clock, flaky);

    expect(await useCase.runOnce()).toMatchObject({ published: 1, failed: 1 });
    expect(await receiveEvents(1)).toHaveLength(1);
    const rows = await outboxRows();
    expect(rows.map((r) => r.attempts)).toEqual([1, 0]);

    clock.advance(LEASE_MS);
    expect(await useCase.runOnce()).toMatchObject({ published: 1, failed: 0 });
    expect((await receiveEvents(1)).map((r) => r.eventId)).toEqual([first?.id as string]);
  });

  test('markPublished is idempotent: a late second mark does not fail nor overwrite the first', async () => {
    const clock = new FakeClock(new Date());
    const [event] = await seedOutbox(1, clock.now());
    const first = clock.now();

    await outbox.markPublished(event?.id as string, first);
    clock.advance(1000);
    await outbox.markPublished(event?.id as string, clock.now());

    const [row] = await outboxRows();
    expect(row?.published_at).toEqual(first);
  });
});

describe('outbox publisher worker', () => {
  test('enabled worker publishes the events of a new wallet end to end and stops on close', async () => {
    const app = await createTestApp({ OUTBOX_PUBLISHER_ENABLED: 'true' });
    try {
      const res = await fetch(`${app.baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId: PLAYER_ID,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      expect(res.status).toBe(201);
      const { id: walletId } = (await res.json()) as { id: string };

      const received = await receiveEvents(2, 5);
      expect(received.map((r) => r.body.eventType).sort()).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      for (const r of received) expect(r.groupId).toBe(walletId);
    } finally {
      await app.close();
    }
    const pending = await sql<{ n: string }>(
      'SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(Number(pending[0]?.n)).toBe(0);
  });
});
