import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../../src/infrastructure/config/config';

describe('loadConfig outbox publisher', () => {
  test('defaults: enabled, 250 ms poll, batch of 50, 30 s lease', () => {
    expect(loadConfig({}).outboxPublisher).toEqual({
      enabled: true,
      pollIntervalMs: 250,
      batchSize: 50,
      leaseMs: 30_000,
    });
  });

  test('OUTBOX_PUBLISHER_ENABLED=false disables it (not coerced to true)', () => {
    expect(loadConfig({ OUTBOX_PUBLISHER_ENABLED: 'false' }).outboxPublisher.enabled).toBe(false);
  });

  test('invalid values are rejected', () => {
    expect(() => loadConfig({ OUTBOX_PUBLISHER_ENABLED: 'maybe' })).toThrow();
    expect(() => loadConfig({ OUTBOX_BATCH_SIZE: '0' })).toThrow();
    expect(() => loadConfig({ OUTBOX_LEASE_MS: '-1' })).toThrow();
  });
});
