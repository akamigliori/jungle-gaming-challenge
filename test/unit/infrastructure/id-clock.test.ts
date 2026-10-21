import { describe, expect, test } from 'bun:test';
import { UuidV7IdGenerator } from '../../../src/infrastructure/ids/uuid-v7.id-generator';
import { SystemClock } from '../../../src/infrastructure/time/system.clock';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UuidV7IdGenerator', () => {
  test('generates distinct UUIDv7 strings', () => {
    const ids = new UuidV7IdGenerator();
    const a = ids.next();
    const b = ids.next();
    expect(a).toMatch(UUID_V7);
    expect(b).toMatch(UUID_V7);
    expect(a).not.toBe(b);
  });
});

describe('SystemClock', () => {
  test('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
