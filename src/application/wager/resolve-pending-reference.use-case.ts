import { InvariantViolationError } from '../../domain/shared/domain-error';
import type { ReferenceRetryPolicy } from '../../domain/wager/reference-retry';
import { reevaluatePendingWager } from '../../domain/wager/wager-decision';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { JournalRepository } from '../ports/journal.repository';
import type { LedgerRepository } from '../ports/ledger.repository';
import type { Metrics, ProcessingOutcome } from '../ports/metrics';
import type { OutboxRepository } from '../ports/outbox.repository';
import type { TransactionRunner } from '../ports/transaction-runner';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';
import { retryTransient } from '../shared/retry-transient';
import { findReference } from './find-reference';
import { recordDecision } from './record-decision';

export interface ResolvePendingReferenceDeps {
  transactionRunner: TransactionRunner;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  journal: JournalRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
  metrics: Metrics;
  /** Erro que some ao refazer a transação inteira (lock_timeout, deadlock, conexão). */
  isTransient: (error: unknown) => boolean;
  /** Backoff entre as tentativas e quantas tentativas fazer antes de rejeitar. */
  referenceRetry: ReferenceRetryPolicy;
}

export interface ResolvePendingReferenceParams {
  transactionId: string;
  walletId: string;
  claimToken: string;
}

/**
 * `resolved`: chegou a `PROCESSED`; `rejected`: chegou a `REJECTED`; `rescheduled`: continua
 * pendente, com nova tentativa agendada; `skipped`: o claim venceu, foi substituído ou a
 * transação já não está pendente. Fora o `skipped`, traz o provedor e `attempts`: o contador de tentativas da
 * transação depois desta avaliação (`reference_attempts`), qualquer que seja o resultado.
 */
export type ResolvePendingReferenceResult =
  | { outcome: 'skipped' }
  | {
      outcome: 'resolved' | 'rejected' | 'rescheduled';
      providerId: string;
      attempts: number;
    };

/** Resultado interno: a transação avaliada, para a contagem depois do commit. */
interface Evaluation {
  result: ResolvePendingReferenceResult;
  tx: WagerTransaction | null;
}

/** Mesma política de falhas transitórias do processamento de apostas: 3 execuções, base de 50 ms. */
const TRANSIENT_RETRY = { maxAttempts: 3, baseDelayMs: 50 } as const;

const PENDING_OUTCOMES = {
  PROCESSED: 'resolved',
  REJECTED: 'rejected',
  PENDING_REFERENCE: 'rescheduled',
} as const;

/**
 * Reavalia uma transação `PENDING_REFERENCE` numa única transação SQL: trava a wallet, recarrega a
 * transação e aplica as mesmas regras do processamento de apostas. Resolvida, grava saldo,
 * transação, ledger e eventos como o processamento normal; ainda pendente, só reagenda (sem
 * evento); esgotadas as tentativas, rejeita.
 *
 * Depois do lock da wallet, trava o claim atual: um worker com reserva vencida ou substituída
 * sai sem efeito, mesmo se a transação continuar pendente. O lock impede outro claim até o commit.
 */
export class ResolvePendingReferenceUseCase {
  constructor(private readonly deps: ResolvePendingReferenceDeps) {}

  async execute(p: ResolvePendingReferenceParams): Promise<ResolvePendingReferenceResult> {
    const { metrics } = this.deps;
    const startedAt = performance.now();
    let outcome: ProcessingOutcome = 'error';
    try {
      const { result, tx } = await retryTransient(() => this.runOnce(p), {
        ...TRANSIENT_RETRY,
        isTransient: this.deps.isTransient,
        onTransient: (error) => metrics.lockConflict(error),
        onRetry: () => metrics.retryScheduled('use_case_transient'),
      });
      outcome = result.outcome;
      this.recordResult(result, tx);
      return result;
    } finally {
      metrics.processingTimed('worker', outcome, (performance.now() - startedAt) / 1000);
    }
  }

  /** Conta o que foi commitado: a transação que terminou, ou o novo agendamento. */
  private recordResult(result: ResolvePendingReferenceResult, tx: WagerTransaction | null): void {
    const { metrics } = this.deps;
    if (result.outcome === 'rescheduled') metrics.retryScheduled('reference_reschedule');
    if (tx && (result.outcome === 'resolved' || result.outcome === 'rejected')) {
      metrics.transactionRecorded({
        channel: 'worker',
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
      });
    }
  }

  private runOnce(p: ResolvePendingReferenceParams): Promise<Evaluation> {
    const { transactionRunner, wallets, transactions, ids, clock, referenceRetry } = this.deps;

    return transactionRunner.run(async () => {
      // 1. lock da wallet antes de ler a transação, como em todo processamento
      const wallet = await wallets.lockById(p.walletId);
      if (!wallet) throw new InvariantViolationError(`wallet ${p.walletId} of a pending not found`);

      // 2. confirma a posse e trava a pendência; o claim não pode mudar durante a decisão
      const at = clock.now();
      const tx = await transactions.lockClaimedPendingReference(p.transactionId, p.claimToken, at);
      if (!tx) return { result: { outcome: 'skipped' }, tx: null };
      if (tx.walletId !== wallet.id) {
        throw new InvariantViolationError('pending transaction belongs to another wallet');
      }

      // 3. mesmas regras do processamento, mais o limite de tentativas
      const reference = await findReference(transactions, tx);
      const expectedVersion = wallet.version;
      const decision = reevaluatePendingWager({
        tx,
        wallet,
        reference,
        at,
        entryId: ids.next(),
        retry: referenceRetry,
      });

      // 4. grava; o evento é correlacionado pela própria transação pendente
      await recordDecision(this.deps, {
        tx,
        wallet,
        decision,
        expectedVersion,
        at,
        correlationId: tx.id,
        persist: 'update',
      });
      return {
        result: {
          outcome: PENDING_OUTCOMES[decision.outcome],
          providerId: tx.providerId,
          attempts: tx.referenceAttempts,
        },
        tx,
      };
    });
  }
}
