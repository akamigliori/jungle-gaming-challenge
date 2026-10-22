import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type {
  DuplicateType,
  Metrics,
  ProcessingChannel,
  ProcessingOutcome,
  ReconciliationResult,
  RetryOperation,
  TransactionRecord,
} from '../../application/ports/metrics';
import type { FailureCode } from '../../domain/shared/failure-code';
import { transientErrorCode } from '../persistence/pg-errors';
import type { OutboxBacklog } from '../persistence/queries/outbox-backlog.query';

export type ReadOutboxBacklog = () => Promise<OutboxBacklog>;

/** Latência do caso de uso: de milissegundos (caminho feliz) a segundos (lock e retries). */
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/**
 * Adaptador Prometheus da porta `Metrics`, com registry próprio (não o global). Os contadores são
 * locais à instância; o Prometheus soma as instâncias ao coletar. Os gauges da outbox vêm do
 * banco e são lidos a cada coleta, com prazo: se a consulta falha ou demora, valem `NaN` e a
 * coleta segue.
 */
export class PrometheusMetrics implements Metrics {
  private readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transactions that reached a final or pending state, by channel, kind and status.',
    labelNames: ['channel', 'kind', 'status', 'failure_code'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicates detected by idempotency key or inbox message id.',
    labelNames: ['type'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries scheduled, by operation.',
    labelNames: ['operation'],
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages explicitly sent to the dead-letter queue, by failure code.',
    labelNames: ['failure_code'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Transient database errors (lock timeout, deadlock, serialization, timeout), by SQLSTATE.',
    labelNames: ['code'],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Use case latency by channel and outcome.',
    labelNames: ['channel', 'outcome'],
    buckets: DURATION_BUCKETS_SECONDS,
    registers: [this.registry],
  });

  private readonly reconciliations = new Counter({
    name: 'wagering_reconciliations_total',
    help: 'Wallet reconciliations run, by result.',
    labelNames: ['result'],
    registers: [this.registry],
  });
  private readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliations that found the wallet balance diverging from its ledger.',
    registers: [this.registry],
  });

  /** Leitura em andamento: coletas simultâneas ou lentas reaproveitam a mesma consulta. */
  private inFlight: Promise<OutboxBacklog> | undefined;

  private readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Outbox events not yet published (NaN when the database did not answer in time).',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event (NaN when the database did not answer in time).',
    registers: [this.registry],
  });

  constructor(
    private readonly readBacklog: ReadOutboxBacklog,
    private readonly backlogTimeoutMs: number,
  ) {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionRecorded({ channel, kind, status, failureCode }: TransactionRecord): void {
    this.transactions.inc({
      channel,
      kind,
      status,
      ...(failureCode && { failure_code: failureCode }),
    });
  }

  duplicateDetected(type: DuplicateType): void {
    this.duplicates.inc({ type });
  }

  retryScheduled(operation: RetryOperation): void {
    this.retries.inc({ operation });
  }

  messageDeadLettered(failureCode: FailureCode): void {
    this.deadLetters.inc({ failure_code: failureCode });
  }

  lockConflict(cause: unknown): void {
    this.lockConflicts.inc({ code: transientErrorCode(cause) });
  }

  processingTimed(channel: ProcessingChannel, outcome: ProcessingOutcome, seconds: number): void {
    this.duration.observe({ channel, outcome }, seconds);
  }

  reconciliationChecked(result: ReconciliationResult): void {
    this.reconciliations.inc({ result });
    if (result === 'divergent') this.reconciliationDivergences.inc();
  }

  /** Texto no formato de exposição do Prometheus; os gauges da outbox são lidos agora. */
  async render(): Promise<string> {
    const backlog = await this.boundedBacklog();
    this.outboxPending.set(backlog?.pending ?? Number.NaN);
    this.outboxLag.set(backlog?.oldestAgeSeconds ?? Number.NaN);
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** `undefined` quando a consulta falha ou passa do prazo: a coleta não pode falhar por isso. */
  private async boundedBacklog(): Promise<OutboxBacklog | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.backlogTimeoutMs);
    });
    try {
      return await Promise.race([this.readBacklogOnce().catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Uma consulta por vez: se a anterior ainda não terminou (banco lento), a coleta seguinte espera
   * por ela em vez de abrir outra, para que um scrape lento não acumule conexões.
   */
  private readBacklogOnce(): Promise<OutboxBacklog> {
    this.inFlight ??= this.readBacklog().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
