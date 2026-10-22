import { describe, expect, test } from 'bun:test';
import { isTransientDbError } from '../../../src/infrastructure/persistence/pg-errors';

describe('isTransientDbError', () => {
  test('statement_timeout (57014) is transient', () => {
    const error = Object.assign(new Error('canceling statement'), { code: '57014' });
    expect(isTransientDbError(error)).toBe(true);
  });

  test('an unrelated error is not transient', () => {
    expect(isTransientDbError(new Error('boom'))).toBe(false);
  });
});
