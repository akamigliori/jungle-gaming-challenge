import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../../src/application/ports/clock';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '../../src/application/ports/outbox.repository';
import { loadConfig } from '../../src/infrastructure/config/config';
import type { WorkerLogger } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { OutboxRetentionWorker } from '../../src/infrastructure/workers/outbox-retention.worker';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';

let orm: MikroORM;
let t: TestApp;
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

const noopLogger: WorkerLogger = {
  info: (() => {}) as WorkerLogger['info'],
  warn: (() => {}) as WorkerLogger['warn'],
  error: (() => {}) as WorkerLogger['error'],
};

/** Grava um evento na outbox com o `publishedAt` (ou `null`) e `occurredAt` dados. */
async function seedOutboxEvent(publishedAt: Date | null, at: Date): Promise<string> {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
     VALUES (?, ?, 'WalletBalanceChanged', '{}'::JSONB, ?, 0, ?, ?)`,
    [id, crypto.randomUUID(), at, at, publishedAt],
  );
  return id;
}

async function publishedIds(): Promise<string[]> {
  const rows = await sql<{ id: string }>('SELECT id FROM outbox_messages ORDER BY published_at');
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp();
  outbox = t.app.get<OutboxRepository>(OUTBOX_REPOSITORY);
});

afterAll(async () => {
  await t.close();
  await orm.close(true);
});

beforeEach(async () => {
  await resetDb(orm);
});

describe('outbox retention', () => {
  test('deletes only published events older than the cutoff, leaving recent and unpublished ones', async () => {
    const clock = new FakeClock(new Date());
    const now = clock.now();
    const old = await seedOutboxEvent(new Date(now.getTime() - 1000), now);
    const recent = await seedOutboxEvent(new Date(now.getTime() - 100), now);
    const unpublished = await seedOutboxEvent(null, new Date(now.getTime() - 10_000));

    const deleted = await outbox.deletePublishedOlderThan(new Date(now.getTime() - 500), 100);

    expect(deleted).toBe(1);
    const remaining = await publishedIds();
    expect(remaining.sort()).toEqual([recent, unpublished].sort());
    expect(remaining).not.toContain(old);
  });

  test('deletes oldest first and respects the batch limit across calls', async () => {
    const clock = new FakeClock(new Date());
    const now = clock.now();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedOutboxEvent(new Date(now.getTime() - 5000 + i), now));
    }

    const cutoff = now;
    expect(await outbox.deletePublishedOlderThan(cutoff, 2)).toBe(2);
    expect(await outbox.deletePublishedOlderThan(cutoff, 2)).toBe(2);
    expect(await outbox.deletePublishedOlderThan(cutoff, 2)).toBe(1);
    expect(await publishedIds()).toHaveLength(0);
  });

  test('unpublished events are never deleted, even when very old', async () => {
    const clock = new FakeClock(new Date());
    const now = clock.now();
    await seedOutboxEvent(null, new Date(now.getTime() - 1_000_000));

    expect(await outbox.deletePublishedOlderThan(now, 100)).toBe(0);
    expect(await publishedIds()).toHaveLength(1);
  });

  test('the worker computes the cutoff as now - maxAgeMs and deletes accordingly', async () => {
    const clock = new FakeClock(new Date());
    const now = clock.now();
    // publicado há 1 hora: elegível quando maxAgeMs for menor que 1 hora
    await seedOutboxEvent(new Date(now.getTime() - 3_600_000), now);

    const worker = new OutboxRetentionWorker(
      outbox,
      clock,
      loadConfig({ ...process.env, LOG_LEVEL: 'silent', OUTBOX_RETENTION_MAX_AGE_MS: '1000' }),
      noopLogger,
    );

    expect(await worker.runOnce()).toEqual({ deleted: 1 });
    expect(await publishedIds()).toHaveLength(0);
  });
});
