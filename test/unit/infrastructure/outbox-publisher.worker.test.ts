import { describe, expect, test } from 'bun:test';
import type {
  PublishOutboxResult,
  PublishOutboxUseCase,
} from '../../../src/application/messaging/publish-outbox.use-case';
import { type AppConfig, loadConfig } from '../../../src/infrastructure/config/config';
import {
  OutboxPublisherWorker,
  type WorkerLogger,
} from '../../../src/infrastructure/workers/outbox-publisher.worker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a condição ficar verdadeira (sem depender de quantos ciclos cabem num tempo fixo). */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(2);
  }
}

/** Intervalo longo: qualquer ciclo extra observado só pode ter vindo de um reinício imediato. */
const LONG_POLL = { OUTBOX_POLL_INTERVAL_MS: '60000' };

function config(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ OUTBOX_POLL_INTERVAL_MS: '10', OUTBOX_BATCH_SIZE: '2', ...env });
}

function logger() {
  const errors: unknown[] = [];
  const warns: unknown[] = [];
  const log: WorkerLogger = {
    info: (() => {}) as WorkerLogger['info'],
    error: ((obj: unknown) => errors.push(obj)) as WorkerLogger['error'],
    warn: ((obj: unknown) => warns.push(obj)) as WorkerLogger['warn'],
  };
  return { log, errors, warns };
}

function fakeUseCase(run: () => Promise<PublishOutboxResult>) {
  let calls = 0;
  const useCase = {
    runOnce: () => {
      calls += 1;
      return run();
    },
  } as unknown as PublishOutboxUseCase;
  return { useCase, calls: () => calls };
}

describe('OutboxPublisherWorker', () => {
  test('disabled -> never runs', async () => {
    const fake = fakeUseCase(async () => ({ published: 0, failed: 0, failures: [] }));
    const worker = new OutboxPublisherWorker(
      fake.useCase,
      config({ OUTBOX_PUBLISHER_ENABLED: 'false' }),
      logger().log,
    );
    worker.onApplicationBootstrap();
    await sleep(40);
    await worker.beforeApplicationShutdown();
    expect(fake.calls()).toBe(0);
  });

  test('a failing cycle is logged and the loop keeps running', async () => {
    const fake = fakeUseCase(async () => {
      throw new Error('db down');
    });
    const { log, errors } = logger();
    const worker = new OutboxPublisherWorker(fake.useCase, config(), log);
    worker.onApplicationBootstrap();
    await waitFor(() => fake.calls() >= 3);
    await worker.beforeApplicationShutdown();
    expect(errors.length).toBe(fake.calls());
  });

  test('full batch published -> next cycle right away instead of waiting the poll interval', async () => {
    let remaining = 5;
    const fake = fakeUseCase(async () => {
      if (remaining === 0) return { published: 0, failed: 0, failures: [] };
      remaining -= 1;
      return { published: 2, failed: 0, failures: [] };
    });
    const worker = new OutboxPublisherWorker(fake.useCase, config(LONG_POLL), logger().log);
    worker.onApplicationBootstrap();
    // 5 lotes cheios seguidos + 1 vazio; depois disso só depois do intervalo longo
    await waitFor(() => fake.calls() >= 6);
    await sleep(30);
    await worker.beforeApplicationShutdown();
    expect(fake.calls()).toBe(6);
  });

  test('full batch of failures -> waits the poll interval (no tight loop while SQS is down)', async () => {
    const fake = fakeUseCase(async () => ({
      published: 0,
      failed: 2,
      failures: ['e1', 'e2'].map((eventId) => ({
        eventId,
        eventType: 'WalletBalanceChanged',
        aggregateId: `w-${eventId}`,
        attempts: 1,
        error: new Error('sqs down'),
      })),
    }));
    const { log, warns } = logger();
    const worker = new OutboxPublisherWorker(fake.useCase, config(LONG_POLL), log);
    worker.onApplicationBootstrap();
    await waitFor(() => fake.calls() >= 1);
    await sleep(30);
    await worker.beforeApplicationShutdown();
    expect(fake.calls()).toBe(1);
    expect(warns).toHaveLength(2);
  });

  test('each failed message is logged with its ids and a safe error', async () => {
    const failure = {
      eventId: 'e1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'w1',
      attempts: 2,
      error: new Error('sqs down'),
    };
    const fake = fakeUseCase(async () => ({ published: 0, failed: 1, failures: [failure] }));
    const { log, warns } = logger();
    const worker = new OutboxPublisherWorker(fake.useCase, config(LONG_POLL), log);
    worker.onApplicationBootstrap();
    await waitFor(() => warns.length >= 1);
    await worker.beforeApplicationShutdown();
    expect(warns[0]).toMatchObject({
      eventId: 'e1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'w1',
      attempts: 2,
      err: { type: 'Error', message: 'sqs down' },
    });
  });

  test('shutdown waits for the in-flight cycle and no cycle starts after it', async () => {
    let release: () => void = () => {};
    let finished = false;
    const fake = fakeUseCase(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      finished = true;
      return { published: 1, failed: 0, failures: [] };
    });
    const worker = new OutboxPublisherWorker(fake.useCase, config(), logger().log);
    worker.onApplicationBootstrap();
    await waitFor(() => fake.calls() === 1);

    const stopping = worker.beforeApplicationShutdown();
    setTimeout(() => release(), 20);
    await stopping;
    expect(finished).toBe(true);
    await sleep(40);
    expect(fake.calls()).toBe(1);
  });
});
