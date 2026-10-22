import { describe, expect, test } from 'bun:test';
import { safeError } from '../../../../src/infrastructure/logging/safe-error';

describe('safeError', () => {
  test('omits message and stack of driver errors that carry interpolated values', () => {
    const driverError = Object.assign(new Error('INSERT INTO t VALUES (12345.67)'), {
      code: '23505',
      constraint: 'uq_x',
      table: 't',
    });
    const safe = safeError(driverError);
    expect(safe).toEqual({ type: 'Error', code: '23505', constraint: 'uq_x', table: 't' });
    expect(JSON.stringify(safe)).not.toContain('12345.67');
  });

  test('keeps message of plain errors and sanitizes the cause chain', () => {
    const cause = Object.assign(new Error('secret 99.99'), { code: '22P02' });
    const safe = safeError(new Error('outer', { cause }));
    expect(safe.message).toBe('outer');
    expect(safe.cause).toEqual({ type: 'Error', code: '22P02' });
  });
});
