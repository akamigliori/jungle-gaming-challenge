import { describe, expect, test } from 'bun:test';
import { TransientFailureError } from '../../../src/application/shared/retry-transient';
import { IdempotencyConflictError } from '../../../src/application/wager/wager-errors';
import { WalletNotFoundError } from '../../../src/application/wallet/wallet-errors';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { failureAction } from '../../../src/interfaces/sqs/message-failure-policy';

const maxJitter = () => 1;

describe('failureAction', () => {
  test('sends a permanent error to the DLQ on the first delivery', () => {
    expect(failureAction(new WalletNotFoundError('x'), 1)).toEqual({
      kind: 'dead-letter',
      failureCode: 'WALLET_NOT_FOUND',
    });
    expect(failureAction(new IdempotencyConflictError('x'), 1)).toEqual({
      kind: 'dead-letter',
      failureCode: 'IDEMPOTENCY_CONFLICT',
    });
  });

  test.each([
    [1, 1],
    [4, 8],
    [12, 300],
  ])('retries a transient error with backoff (receiveCount %i -> %i s)', (count, seconds) => {
    expect(failureAction(new TransientFailureError(new Error('db')), count, maxJitter)).toEqual({
      kind: 'retry',
      delaySeconds: seconds,
    });
  });

  test('never dead-letters a transient error', () => {
    expect(failureAction(new TransientFailureError(null), 100, maxJitter).kind).toBe('retry');
  });

  test('applies equal jitter: half of the delay at minimum', () => {
    expect(failureAction(new TransientFailureError(null), 4, () => 0)).toEqual({
      kind: 'retry',
      delaySeconds: 4,
    });
  });

  test('never returns a delay below one second', () => {
    expect(failureAction(new TransientFailureError(null), 1, () => 0)).toEqual({
      kind: 'retry',
      delaySeconds: 1,
    });
  });

  test('retries an unexpected error before the limit', () => {
    expect(failureAction(new Error('boom'), 2, maxJitter).kind).toBe('retry');
  });

  test('dead-letters an unexpected error at the limit as INTERNAL_ERROR', () => {
    expect(failureAction(new Error('boom'), 3)).toEqual({
      kind: 'dead-letter',
      failureCode: 'INTERNAL_ERROR',
    });
    expect(failureAction(new InvariantViolationError('bug'), 3)).toEqual({
      kind: 'dead-letter',
      failureCode: 'INTERNAL_ERROR',
    });
  });
});
