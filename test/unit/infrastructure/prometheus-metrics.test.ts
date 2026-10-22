import { describe, expect, test } from 'bun:test';
import { LockWaitTimeoutException } from '@mikro-orm/core';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../src/domain/wager/wager-transaction-status';
import { PrometheusMetrics } from '../../../src/infrastructure/metrics/prometheus-metrics';

const NO_BACKLOG = async () => ({ pending: 0, oldestAgeSeconds: 0 });

function metrics(readBacklog = NO_BACKLOG, backlogTimeoutMs = 1000) {
  return new PrometheusMetrics(readBacklog, backlogTimeoutMs);
}

describe('PrometheusMetrics', () => {
  test('counts transactions by channel, kind and status, with failure_code only when rejected', async () => {
    const m = metrics();
    m.transactionRecorded({
      channel: 'http',
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
    });
    m.transactionRecorded({
      channel: 'sqs',
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });

    const text = await m.render();
    expect(text).toContain(
      'wagering_transactions_total{channel="http",kind="BET",status="PROCESSED"} 1',
    );
    expect(text).toContain(
      'wagering_transactions_total{channel="sqs",kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS"} 1',
    );
  });

  test('counts duplicates, retries and dead letters', async () => {
    const m = metrics();
    m.duplicateDetected('idempotency_replay');
    m.duplicateDetected('idempotency_replay');
    m.retryScheduled('outbox_publish');
    m.messageDeadLettered('INVALID_PAYLOAD');

    const text = await m.render();
    expect(text).toContain('wagering_duplicates_total{type="idempotency_replay"} 2');
    expect(text).toContain('wagering_retries_total{operation="outbox_publish"} 1');
    expect(text).toContain('wagering_dlq_messages_total{failure_code="INVALID_PAYLOAD"} 1');
  });

  test('counts reconciliations by result', async () => {
    const m = metrics();
    m.reconciliationChecked('consistent');
    m.reconciliationChecked('divergent');
    m.reconciliationChecked('divergent');

    const text = await m.render();
    expect(text).toContain('wagering_reconciliations_total{result="consistent"} 1');
    expect(text).toContain('wagering_reconciliations_total{result="divergent"} 2');
  });

  test('lock conflicts use the SQLSTATE of the error and a closed set of labels', async () => {
    const m = metrics();
    m.lockConflict(Object.assign(new Error('x'), { code: '40P01' }));
    m.lockConflict(new LockWaitTimeoutException(new Error('x')));
    m.lockConflict(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    m.lockConflict(new Error('unknown'));

    const text = await m.render();
    expect(text).toContain('wagering_lock_conflicts_total{code="40P01"} 1');
    expect(text).toContain('wagering_lock_conflicts_total{code="55P03"} 1');
    expect(text).toContain('wagering_lock_conflicts_total{code="connection"} 1');
    expect(text).toContain('wagering_lock_conflicts_total{code="other"} 1');
  });

  test('records the processing duration by channel and outcome', async () => {
    const m = metrics();
    m.processingTimed('http', 'processed', 0.02);

    const text = await m.render();
    expect(text).toContain(
      'wagering_processing_duration_seconds_count{channel="http",outcome="processed"} 1',
    );
  });

  test('outbox gauges are computed at scrape time', async () => {
    let backlog = { pending: 3, oldestAgeSeconds: 12.5 };
    const m = metrics(async () => backlog);

    expect(await m.render()).toContain('wagering_outbox_pending 3');
    backlog = { pending: 0, oldestAgeSeconds: 0 };
    const text = await m.render();
    expect(text).toContain('wagering_outbox_pending 0');
    expect(text).toContain('wagering_outbox_lag_seconds 0');
  });

  test('a failing or slow backlog query yields NaN and does not fail the scrape', async () => {
    const failing = metrics(async () => {
      throw new Error('db down');
    });
    const failingText = await failing.render();
    // o prom-client escreve NaN como `Nan`, que o Prometheus aceita
    expect(failingText).toMatch(/^wagering_outbox_pending nan$/im);
    expect(failingText).toMatch(/^wagering_outbox_lag_seconds nan$/im);

    const slow = metrics(() => new Promise(() => undefined), 20);
    const slowText = await slow.render();
    expect(slowText).toMatch(/^wagering_outbox_lag_seconds nan$/im);
  });

  test('exposes default process metrics on its own registry', async () => {
    const text = await metrics().render();
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  test('concurrent scrapes share one backlog query, and a slow one is not restarted', async () => {
    let reads = 0;
    const m = metrics(async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { pending: 1, oldestAgeSeconds: 0 };
    });
    await Promise.all([m.render(), m.render(), m.render()]);
    expect(reads).toBe(1);

    // leitura que passa do prazo: a coleta seguinte reaproveita a mesma, sem abrir outra
    let slowReads = 0;
    const slow = metrics(() => {
      slowReads += 1;
      return new Promise(() => undefined);
    }, 10);
    await slow.render();
    await slow.render();
    expect(slowReads).toBe(1);
  });

  test('after a read finishes, the next scrape queries again', async () => {
    let reads = 0;
    const m = metrics(async () => {
      reads += 1;
      return { pending: reads, oldestAgeSeconds: 0 };
    });
    await m.render();
    expect(await m.render()).toContain('wagering_outbox_pending 2');
  });
});
