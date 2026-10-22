import type { FailureCode } from '../../domain/shared/failure-code';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';

/** Por onde a transação chegou: HTTP, mensagem SQS ou o worker das referências pendentes. */
export type ProcessingChannel = 'http' | 'sqs' | 'worker';

export type DuplicateType =
  | 'idempotency_replay'
  | 'idempotency_conflict'
  | 'inbox_redelivery'
  | 'inbox_conflict';

export type RetryOperation =
  | 'use_case_transient'
  | 'sqs_visibility'
  | 'outbox_publish'
  | 'reference_reschedule';

/** Resultado de uma execução de caso de uso, para a latência por desfecho. */
export type ProcessingOutcome =
  | 'processed'
  | 'rejected'
  | 'pending'
  | 'replay'
  | 'conflict'
  | 'resolved'
  | 'rescheduled'
  | 'skipped'
  | 'error';

export interface TransactionRecord {
  channel: ProcessingChannel;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  /** Só quando a transação foi rejeitada. */
  failureCode?: FailureCode;
}

/**
 * Métricas do processamento, com nomes do negócio. Todos os valores vêm de conjuntos fechados:
 * nunca ids de wallet, transação ou provedor. Chamar sem esperar resposta: uma métrica nunca
 * pode fazer o processamento falhar.
 */
export interface Metrics {
  /** Uma transação nova chegou a um estado final ou pendente (replays não entram). */
  transactionRecorded(record: TransactionRecord): void;
  duplicateDetected(type: DuplicateType): void;
  retryScheduled(operation: RetryOperation): void;
  messageDeadLettered(failureCode: string): void;
  /** Erro transitório de banco (lock, deadlock, serialização, timeout, conexão). */
  lockConflict(cause: unknown): void;
  processingTimed(channel: ProcessingChannel, outcome: ProcessingOutcome, seconds: number): void;
}

export const METRICS = Symbol('METRICS');
