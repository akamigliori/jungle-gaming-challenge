import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REFERENCE_RETRY,
  referenceRetryDelayMs,
} from '../../../src/domain/wager/reference-retry';

describe('referenceRetryDelayMs', () => {
  test.each([
    [0, 2000],
    [1, 4000],
    [2, 8000],
    [5, 60000],
    [40, 60000],
  ])('attempt %d waits %d ms', (attempts, expected) => {
    expect(referenceRetryDelayMs(attempts, DEFAULT_REFERENCE_RETRY)).toBe(expected);
  });

  test('respects a custom policy', () => {
    expect(referenceRetryDelayMs(3, { baseMs: 10, maxMs: 50, maxAttempts: 3 })).toBe(50);
  });
});
