import { describe, expect, test } from 'bun:test';
import type { Clock } from '../../../src/application/ports/clock';
import type { OutboxRepository } from '../../../src/application/ports/outbox.repository';
import { type AppConfig, loadConfig } from '../../../src/infrastructure/config/config';
import type { WorkerLogger } from '../../../src/infrastructure/workers/outbox-publisher.worker';
import { OutboxRetentionWorker } from '../../../src/infrastructure/workers/outbox-retention.worker';

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
const LONG_POLL = { OUTBOX_RETENTION_POLL_INTERVAL_MS: '60000' };

function config(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    OUTBOX_RETENTION_POLL_INTERVAL_MS: '10',
    OUTBOX_RETENTION_BATCH_SIZE: '2',
    ...env,
  });
}

function logger() {
  const errors: unknown[] = [];
  const infos: unknown[] = [];
  const log: WorkerLogger = {
    info: ((obj: unknown) => infos.push(obj)) as WorkerLogger['info'],
    error: ((obj: unknown) => errors.push(obj)) as WorkerLogger['error'],
    warn: (() => {}) as WorkerLogger['warn'],
  };
  return { log, errors, infos };
}

function fakeClock(start = Date.now()): Clock & { now: () => Date } {
  return { now: () => new Date(start) };
}

function fakeOutbox(deleteFn: () => Promise<number> | number) {
  let calls = 0;
  const outbox = {
    deletePublishedOlderThan: () => {
      calls += 1;
      return Promise.resolve(deleteFn());
    },
  } as unknown as OutboxRepository;
  return { outbox, calls: () => calls };
}

function newWorker(
  outbox: OutboxRepository,
  cfg: AppConfig,
  log: WorkerLogger,
  clock: Clock = fakeClock(),
): OutboxRetentionWorker {
  return new OutboxRetentionWorker(outbox, clock, cfg, log);
}

describe('OutboxRetentionWorker', () => {
  test('disabled -> never runs', async () => {
    const { outbox, calls } = fakeOutbox(() => 0);
    const worker = newWorker(outbox, config({ OUTBOX_RETENTION_ENABLED: 'false' }), logger().log);
    worker.onApplicationBootstrap();
    await sleep(40);
    await worker.beforeApplicationShutdown();
    expect(calls()).toBe(0);
  });

  test('a failing cycle is logged and the loop keeps running', async () => {
    const { outbox, calls } = fakeOutbox(() => {
      throw new Error('db down');
    });
    const { log, errors } = logger();
    const worker = newWorker(outbox, config(), log);
    worker.onApplicationBootstrap();
    await waitFor(() => calls() >= 3);
    await worker.beforeApplicationShutdown();
    expect(errors.length).toBe(calls());
  });

  test('full batch deleted -> next cycle right away instead of waiting the poll interval', async () => {
    let remaining = 5;
    const { outbox, calls } = fakeOutbox(() => {
      if (remaining === 0) return 0;
      remaining -= 1;
      return 2;
    });
    const worker = newWorker(outbox, config(LONG_POLL), logger().log);
    worker.onApplicationBootstrap();
    // 5 lotes cheios seguidos + 1 vazio; depois disso só depois do intervalo longo
    await waitFor(() => calls() >= 6);
    await sleep(30);
    await worker.beforeApplicationShutdown();
    expect(calls()).toBe(6);
  });

  test('deleted events are logged with the count', async () => {
    const { outbox } = fakeOutbox(() => 1);
    const { log, infos } = logger();
    const worker = newWorker(outbox, config(LONG_POLL), log);
    worker.onApplicationBootstrap();
    await waitFor(() => infos.length >= 1);
    await worker.beforeApplicationShutdown();
    expect(infos[0]).toMatchObject({ deleted: 1 });
  });

  test('shutdown waits for the in-flight cycle and no cycle starts after it', async () => {
    let release: () => void = () => {};
    let finished = false;
    const { outbox, calls } = fakeOutbox(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      finished = true;
      return 1;
    });
    const worker = newWorker(outbox, config(), logger().log);
    worker.onApplicationBootstrap();
    await waitFor(() => calls() === 1);

    const stopping = worker.beforeApplicationShutdown();
    setTimeout(() => release(), 20);
    await stopping;
    expect(finished).toBe(true);
    await sleep(40);
    expect(calls()).toBe(1);
  });
});
