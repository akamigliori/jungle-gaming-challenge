import { describe, expect, test } from 'bun:test';
import type { Clock } from '../../../src/application/ports/clock';
import type {
  ClaimedPendingReference,
  WagerTransactionRepository,
} from '../../../src/application/ports/wager-transaction.repository';
import type {
  ResolvePendingReferenceResult,
  ResolvePendingReferenceUseCase,
} from '../../../src/application/wager/resolve-pending-reference.use-case';
import { type AppConfig, loadConfig } from '../../../src/infrastructure/config/config';
import type { WorkerLogger } from '../../../src/infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '../../../src/infrastructure/workers/pending-reference.worker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(2);
  }
}

function config(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ PENDING_REFERENCE_POLL_INTERVAL_MS: '10', ...env });
}

const RESOLVED: ResolvePendingReferenceResult = {
  outcome: 'resolved',
  providerId: 'provider-a',
  attempts: 0,
};

const clock: Clock = { now: () => new Date() };

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

/** Repositório falso: só o claim importa para o worker. */
function fakeRepository(claim: () => Promise<ClaimedPendingReference[]>) {
  let claims = 0;
  const repo = {
    claimDuePendingReferences: () => {
      claims += 1;
      return claim();
    },
  } as unknown as WagerTransactionRepository;
  return { repo, claims: () => claims };
}

function fakeUseCase(
  run: (p: { transactionId: string; walletId: string }) => Promise<ResolvePendingReferenceResult>,
) {
  const calls: string[] = [];
  const useCase = {
    execute: (p: { transactionId: string; walletId: string }) => {
      calls.push(p.transactionId);
      return run(p);
    },
  } as unknown as ResolvePendingReferenceUseCase;
  return { useCase, calls };
}

const once = (items: ClaimedPendingReference[]) => {
  let served = false;
  return async () => {
    if (served) return [];
    served = true;
    return items;
  };
};

describe('PendingReferenceWorker', () => {
  test('disabled -> never claims', async () => {
    const repo = fakeRepository(async () => []);
    const fake = fakeUseCase(async () => RESOLVED);
    const worker = new PendingReferenceWorker(
      fake.useCase,
      repo.repo,
      clock,
      config({ PENDING_REFERENCE_WORKER_ENABLED: 'false' }),
      logger().log,
    );
    worker.onApplicationBootstrap();
    await sleep(40);
    await worker.beforeApplicationShutdown();
    expect(repo.claims()).toBe(0);
  });

  test('runOnce resolves each claimed item and reports how many were claimed', async () => {
    const repo = fakeRepository(
      once([
        { id: 'a1', walletId: 'wa' },
        { id: 'b1', walletId: 'wb' },
        { id: 'a2', walletId: 'wa' },
      ]),
    );
    const fake = fakeUseCase(async () => RESOLVED);
    const worker = new PendingReferenceWorker(
      fake.useCase,
      repo.repo,
      clock,
      config(),
      logger().log,
    );
    expect(await worker.runOnce()).toEqual({ claimed: 3 });
    expect([...fake.calls].sort()).toEqual(['a1', 'a2', 'b1']);
  });

  test('items of the same wallet run in claim order, one at a time; wallets run in parallel', async () => {
    const repo = fakeRepository(
      once([
        { id: 'a1', walletId: 'wa' },
        { id: 'b1', walletId: 'wb' },
        { id: 'a2', walletId: 'wa' },
      ]),
    );
    const events: string[] = [];
    const fake = fakeUseCase(async ({ transactionId }) => {
      events.push(`start ${transactionId}`);
      await sleep(20);
      events.push(`end ${transactionId}`);
      return RESOLVED;
    });
    const worker = new PendingReferenceWorker(
      fake.useCase,
      repo.repo,
      clock,
      config(),
      logger().log,
    );
    await worker.runOnce();
    // a2 só começa depois que a1 termina
    expect(events.indexOf('start a2')).toBeGreaterThan(events.indexOf('end a1'));
    // wb não espera a wallet wa terminar
    expect(events.indexOf('start b1')).toBeLessThan(events.indexOf('end a1'));
  });

  test('a failing item is logged and the next items still run', async () => {
    const repo = fakeRepository(
      once([
        { id: 'a1', walletId: 'wa' },
        { id: 'a2', walletId: 'wa' },
      ]),
    );
    const fake = fakeUseCase(async ({ transactionId }) => {
      if (transactionId === 'a1') throw new Error('lock timeout');
      return RESOLVED;
    });
    const { log, errors } = logger();
    const worker = new PendingReferenceWorker(fake.useCase, repo.repo, clock, config(), log);
    expect(await worker.runOnce()).toEqual({ claimed: 2 });
    expect(fake.calls).toEqual(['a1', 'a2']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ transactionId: 'a1', walletId: 'wa' });
  });

  test('each outcome is logged with the ids and the attempts', async () => {
    const repo = fakeRepository(
      once([
        { id: 'a1', walletId: 'wa' },
        { id: 'b1', walletId: 'wb' },
        { id: 'c1', walletId: 'wc' },
      ]),
    );
    const outcomes: Record<string, ResolvePendingReferenceResult> = {
      a1: { outcome: 'resolved', providerId: 'p1', attempts: 1 },
      b1: { outcome: 'rescheduled', providerId: 'p2', attempts: 2 },
      c1: { outcome: 'rejected', providerId: 'p3', attempts: 5 },
    };
    const fake = fakeUseCase(async ({ transactionId }) => outcomes[transactionId] as never);
    const { log, infos } = logger();
    const worker = new PendingReferenceWorker(fake.useCase, repo.repo, clock, config(), log);
    await worker.runOnce();
    expect(infos).toContainEqual({
      transactionId: 'a1',
      walletId: 'wa',
      providerId: 'p1',
      attempts: 1,
      outcome: 'resolved',
    });
    expect(infos).toContainEqual(
      expect.objectContaining({ transactionId: 'c1', outcome: 'rejected', attempts: 5 }),
    );
    expect(infos).toHaveLength(3);
  });

  test('a failing claim is logged and the loop keeps running', async () => {
    const repo = fakeRepository(async () => {
      throw new Error('db down');
    });
    const { log, errors } = logger();
    const worker = new PendingReferenceWorker(
      fakeUseCase(async () => RESOLVED).useCase,
      repo.repo,
      clock,
      config(),
      log,
    );
    worker.onApplicationBootstrap();
    await waitFor(() => repo.claims() >= 3);
    await worker.beforeApplicationShutdown();
    expect(errors.length).toBe(repo.claims());
  });

  test('shutdown waits for the in-flight cycle and no cycle starts after it', async () => {
    let release: () => void = () => {};
    let finished = false;
    const repo = fakeRepository(once([{ id: 'a1', walletId: 'wa' }]));
    const fake = fakeUseCase(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      finished = true;
      return RESOLVED;
    });
    const worker = new PendingReferenceWorker(
      fake.useCase,
      repo.repo,
      clock,
      config(),
      logger().log,
    );
    worker.onApplicationBootstrap();
    await waitFor(() => fake.calls.length === 1);

    const stopping = worker.beforeApplicationShutdown();
    setTimeout(() => release(), 20);
    await stopping;
    expect(finished).toBe(true);
    const claimsAtStop = repo.claims();
    await sleep(40);
    expect(repo.claims()).toBe(claimsAtStop);
  });
});
