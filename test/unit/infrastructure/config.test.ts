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
});
