import { describe, expect, test } from 'bun:test';
import { correlationIdFor } from '../../../src/infrastructure/logging/logger.module';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function call(header?: string | string[]) {
  const headers: Record<string, string> = {};
  const id = correlationIdFor(
    { headers: header === undefined ? {} : { 'x-correlation-id': header } },
    { setHeader: (k: string, v: string) => (headers[k] = v) },
  );
  return { id, headers };
}

describe('correlationIdFor', () => {
  test('reuses the incoming x-correlation-id and echoes it', () => {
    const { id, headers } = call('abc-123');
    expect(id).toBe('abc-123');
    expect(headers['x-correlation-id']).toBe('abc-123');
  });

  test('generates a UUIDv7 when the header is missing', () => {
    const { id, headers } = call();
    expect(id).toMatch(UUID_V7);
    expect(headers['x-correlation-id']).toBe(id);
  });

  test('replaces unsafe or oversized values', () => {
    expect(call('bad\nvalue').id).toMatch(UUID_V7);
    expect(call('x'.repeat(200)).id).toMatch(UUID_V7);
    expect(call(['a', 'b']).id).toMatch(UUID_V7);
  });
});
