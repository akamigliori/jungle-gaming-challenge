import { describe, expect, test } from 'bun:test';
import { FAILURE_CODES } from '../../../src/domain/shared/failure-code';
import { statusFor } from '../../../src/interfaces/http/error-status-map';

describe('statusFor', () => {
  test.each([
    ['INVALID_PAYLOAD', 400],
    ['INVALID_MONEY', 400],
    ['REFERENCE_REQUIRED', 400],
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['WALLET_NOT_FOUND', 404],
    ['IDEMPOTENCY_CONFLICT', 409],
    ['WALLET_ALREADY_EXISTS', 409],
    ['INSUFFICIENT_FUNDS', 422],
    ['REVERSAL_INSUFFICIENT_FUNDS', 422],
    ['BALANCE_LIMIT_EXCEEDED', 422],
    ['CURRENCY_MISMATCH', 422],
    ['ALREADY_REVERSED', 422],
    ['SERVICE_UNAVAILABLE', 503],
    ['INTERNAL_ERROR', 500],
  ] as const)('%s → %i', (code, status) => {
    expect(statusFor(code).status).toBe(status);
  });

  test('only SERVICE_UNAVAILABLE is retryable', () => {
    expect(statusFor('SERVICE_UNAVAILABLE').retryable).toBe(true);
    expect(statusFor('INSUFFICIENT_FUNDS').retryable).toBe(false);
    expect(statusFor('INTERNAL_ERROR').retryable).toBe(false);
  });

  test('every FailureCode has a mapping', () => {
    for (const code of FAILURE_CODES) {
      const { status } = statusFor(code);
      expect([400, 404, 409, 422, 500]).toContain(status);
    }
  });
});
