import { describe, expect, test } from 'bun:test';
import {
  retryTransient,
  TransientFailureError,
} from '../../../src/application/shared/retry-transient';

class Transient extends Error {}

/** Trabalho que falha com os erros dados, em ordem, e depois devolve 'ok'. */
function failing(errors: Error[]) {
  const state = { calls: 0 };
  const work = async (): Promise<string> => {
    const error = errors[state.calls];
    state.calls += 1;
    if (error) throw error;
    return 'ok';
  };
  return { state, work };
}

function policy() {
  const sleeps: number[] = [];
  return {
    sleeps,
    p: {
      isTransient: (e: unknown) => e instanceof Transient,
      maxAttempts: 3,
      baseDelayMs: 50,
      random: () => 0.5,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe('retryTransient', () => {
  test('success on the first attempt → one call, no sleep', async () => {
    const { state, work } = failing([]);
    const { sleeps, p } = policy();

    expect(await retryTransient(work, p)).toBe('ok');
    expect(state.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('transient twice then success → 3 calls, 2 sleeps with exponential jitter', async () => {
    const { state, work } = failing([new Transient(), new Transient()]);
    const { sleeps, p } = policy();

    expect(await retryTransient(work, p)).toBe('ok');
    expect(state.calls).toBe(3);
    // random() * base * 2^tentativa: 0.5 * 50 * 2 = 50; 0.5 * 50 * 4 = 100
    expect(sleeps).toEqual([50, 100]);
  });

  test('transient on every attempt → TransientFailureError after maxAttempts', async () => {
    const last = new Transient('lock timeout');
    const { state, work } = failing([new Transient(), new Transient(), last]);
    const { sleeps, p } = policy();

    const error = await retryTransient(work, p).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransientFailureError);
    const failure = error as TransientFailureError;
    expect(failure.code).toBe('SERVICE_UNAVAILABLE');
    expect(failure.retryable).toBe(true);
    expect(failure.message).toBe('Service temporarily unavailable');
    expect(failure.cause).toBe(last);
    expect(state.calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  test('non-transient error → rethrown immediately, without retry', async () => {
    const boom = new Error('boom');
    const { state, work } = failing([boom]);
    const { sleeps, p } = policy();

    await expect(retryTransient(work, p)).rejects.toBe(boom);
    expect(state.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('a non-transient error after a transient one is rethrown as is', async () => {
    const boom = new Error('boom');
    const { state, work } = failing([new Transient(), boom]);
    const { p } = policy();

    await expect(retryTransient(work, p)).rejects.toBe(boom);
    expect(state.calls).toBe(2);
  });

  test('onTransient fires for every transient error; onRetry only when another attempt follows', async () => {
    const errors = [new Transient('1'), new Transient('2'), new Transient('3')];
    const { work } = failing(errors);
    const { p } = policy();
    const seen: unknown[] = [];
    let retries = 0;

    await retryTransient(work, {
      ...p,
      onTransient: (error) => seen.push(error),
      onRetry: () => {
        retries += 1;
      },
    }).catch(() => undefined);

    expect(seen).toEqual(errors);
    expect(retries).toBe(2);
  });

  test('a non-transient error fires no hook', async () => {
    const { work } = failing([new Error('boom')]);
    const { p } = policy();
    let fired = 0;
    const hook = () => {
      fired += 1;
    };

    await retryTransient(work, { ...p, onTransient: hook, onRetry: hook }).catch(() => undefined);

    expect(fired).toBe(0);
  });
});
