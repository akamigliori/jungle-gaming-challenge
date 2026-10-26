import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../../src/infrastructure/config/config';

describe('loadConfig outbox publisher', () => {
  test('defaults: enabled, 250 ms poll, batch of 50, 30 s lease, 5 concurrent sends', () => {
    expect(loadConfig({}).outboxPublisher).toEqual({
      enabled: true,
      pollIntervalMs: 250,
      batchSize: 50,
      leaseMs: 30_000,
      concurrency: 5,
    });
  });

  test('OUTBOX_PUBLISHER_ENABLED=false disables it (not coerced to true)', () => {
    expect(loadConfig({ OUTBOX_PUBLISHER_ENABLED: 'false' }).outboxPublisher.enabled).toBe(false);
  });

  test('concurrency comes from the environment', () => {
    expect(loadConfig({ OUTBOX_PUBLISH_CONCURRENCY: '3' }).outboxPublisher.concurrency).toBe(3);
  });

  test('invalid values are rejected', () => {
    expect(() => loadConfig({ OUTBOX_PUBLISHER_ENABLED: 'maybe' })).toThrow();
    expect(() => loadConfig({ OUTBOX_BATCH_SIZE: '0' })).toThrow();
    expect(() => loadConfig({ OUTBOX_LEASE_MS: '-1' })).toThrow();
    expect(() => loadConfig({ OUTBOX_PUBLISH_CONCURRENCY: '0' })).toThrow();
    expect(() => loadConfig({ OUTBOX_PUBLISH_CONCURRENCY: '51' })).toThrow();
  });
});

describe('loadConfig outbox retention', () => {
  test('defaults: enabled, 60 s poll, 7 days max age, batch of 1000', () => {
    expect(loadConfig({}).outboxRetention).toEqual({
      enabled: true,
      pollIntervalMs: 60_000,
      maxAgeMs: 7 * 86_400_000,
      batchSize: 1000,
    });
  });

  test('OUTBOX_RETENTION_ENABLED=false disables it (not coerced to true)', () => {
    expect(loadConfig({ OUTBOX_RETENTION_ENABLED: 'false' }).outboxRetention.enabled).toBe(false);
  });

  test('values come from the environment', () => {
    expect(
      loadConfig({
        OUTBOX_RETENTION_POLL_INTERVAL_MS: '100',
        OUTBOX_RETENTION_MAX_AGE_MS: '3600000',
        OUTBOX_RETENTION_BATCH_SIZE: '50',
      }).outboxRetention,
    ).toEqual({
      enabled: true,
      pollIntervalMs: 100,
      maxAgeMs: 3_600_000,
      batchSize: 50,
    });
  });

  test('invalid values are rejected', () => {
    expect(() => loadConfig({ OUTBOX_RETENTION_ENABLED: 'maybe' })).toThrow();
    expect(() => loadConfig({ OUTBOX_RETENTION_MAX_AGE_MS: '0' })).toThrow();
    expect(() => loadConfig({ OUTBOX_RETENTION_BATCH_SIZE: '-1' })).toThrow();
  });
});

describe('loadConfig SQS queues', () => {
  test('defaults keep the current queue names', () => {
    expect(loadConfig({}).sqs.queues).toEqual({
      transactions: 'wager-transactions.fifo',
      transactionsDlq: 'wager-transactions-dlq.fifo',
      events: 'wagering-events.fifo',
    });
  });

  test('queue names come from the environment', () => {
    const queues = loadConfig({
      SQS_TRANSACTIONS_QUEUE: 'x.fifo',
      SQS_TRANSACTIONS_DLQ: 'x-dlq.fifo',
      SQS_EVENTS_QUEUE: 'x-events.fifo',
    }).sqs.queues;
    expect(queues).toEqual({
      transactions: 'x.fifo',
      transactionsDlq: 'x-dlq.fifo',
      events: 'x-events.fifo',
    });
  });
});

describe('loadConfig SQS consumer', () => {
  test('defaults: enabled, 2 loops of 4 messages, 10 s long poll, 20 s shutdown', () => {
    expect(loadConfig({}).consumer).toEqual({
      enabled: true,
      loops: 2,
      batchSize: 4,
      waitTimeSeconds: 10,
      shutdownTimeoutMs: 20_000,
    });
  });

  test('values come from the environment', () => {
    expect(
      loadConfig({
        SQS_CONSUMER_ENABLED: 'false',
        SQS_CONSUMER_LOOPS: '3',
        SQS_RECEIVE_BATCH_SIZE: '10',
        SQS_WAIT_TIME_SECONDS: '0',
        SHUTDOWN_TIMEOUT_MS: '5000',
      }).consumer,
    ).toEqual({
      enabled: false,
      loops: 3,
      batchSize: 10,
      waitTimeSeconds: 0,
      shutdownTimeoutMs: 5000,
    });
  });

  test('values outside the SQS limits are rejected', () => {
    expect(() => loadConfig({ SQS_RECEIVE_BATCH_SIZE: '11' })).toThrow();
    expect(() => loadConfig({ SQS_WAIT_TIME_SECONDS: '21' })).toThrow();
    expect(() => loadConfig({ SQS_CONSUMER_LOOPS: '0' })).toThrow();
  });

  test('shutdown timeout must cover the long poll plus its margin', () => {
    expect(() => loadConfig({ SQS_WAIT_TIME_SECONDS: '20', SHUTDOWN_TIMEOUT_MS: '20000' })).toThrow(
      /SHUTDOWN_TIMEOUT_MS/,
    );
    expect(() =>
      loadConfig({ SQS_WAIT_TIME_SECONDS: '20', SHUTDOWN_TIMEOUT_MS: '25000' }),
    ).not.toThrow();
    expect(() => loadConfig({})).not.toThrow();
  });
});

describe('loadConfig pending references', () => {
  test('defaults: enabled, 1 s poll, batch of 50, 30 s lease, 2 s..60 s backoff, 10 attempts', () => {
    expect(loadConfig({}).pendingReference).toEqual({
      enabled: true,
      pollIntervalMs: 1000,
      batchSize: 50,
      leaseMs: 30_000,
      retry: { baseMs: 2000, maxMs: 60_000, maxAttempts: 10 },
    });
  });

  test('values come from the environment', () => {
    const pending = loadConfig({
      PENDING_REFERENCE_WORKER_ENABLED: 'false',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '50',
      PENDING_REFERENCE_LEASE_MS: '3000',
      REFERENCE_MAX_ATTEMPTS: '3',
      REFERENCE_RETRY_BASE_MS: '100',
      REFERENCE_RETRY_MAX_MS: '400',
    }).pendingReference;
    expect(pending.enabled).toBe(false);
    expect(pending.pollIntervalMs).toBe(50);
    expect(pending.leaseMs).toBe(3000);
    expect(pending.retry).toEqual({ baseMs: 100, maxMs: 400, maxAttempts: 3 });
  });

  test('invalid values are rejected', () => {
    expect(() => loadConfig({ PENDING_REFERENCE_WORKER_ENABLED: 'maybe' })).toThrow();
    expect(() => loadConfig({ REFERENCE_MAX_ATTEMPTS: '0' })).toThrow();
    expect(() => loadConfig({ PENDING_REFERENCE_LEASE_MS: '-1' })).toThrow();
    expect(() => loadConfig({ REFERENCE_RETRY_BASE_MS: '-1' })).toThrow();
    // o teto não pode ficar abaixo da espera base
    expect(() =>
      loadConfig({ REFERENCE_RETRY_BASE_MS: '500', REFERENCE_RETRY_MAX_MS: '100' }),
    ).toThrow();
  });
});
