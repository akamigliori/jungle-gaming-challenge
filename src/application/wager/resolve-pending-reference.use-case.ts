import { InvariantViolationError } from '../../domain/shared/domain-error';
import type { ReferenceRetryPolicy } from '../../domain/wager/reference-retry';
import { reevaluatePendingWager } from '../../domain/wager/wager-decision';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { LedgerRepository } from '../ports/ledger.repository';
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
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
  /** Erro que some ao refazer a transação inteira (lock_timeout, deadlock, conexão). */
  isTransient: (error: unknown) => boolean;
  /** Backoff entre as tentativas e quantas tentativas fazer antes de rejeitar. */
  referenceRetry: ReferenceRetryPolicy;
}

export interface ResolvePendingReferenceParams {
  transactionId: string;
  walletId: string;
}

/**
 * `resolved`: chegou a `PROCESSED`; `rejected`: chegou a `REJECTED`; `rescheduled`: continua
 * pendente, com nova tentativa agendada; `skipped`: já não estava pendente (outra instância
 * resolveu antes). Fora o `skipped`, traz o provedor e `attempts`: o contador de tentativas da
 * transação depois desta avaliação (`reference_attempts`), qualquer que seja o resultado.
 */
export type ResolvePendingReferenceResult =
  | { outcome: 'skipped' }
  | {
      outcome: 'resolved' | 'rejected' | 'rescheduled';
      providerId: string;
      attempts: number;
    };

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
 * Duas instâncias sobre a mesma pendência são serializadas pelo lock da wallet, e a segunda, ao
 * recarregar a transação já resolvida, sai sem efeito.
 */
export class ResolvePendingReferenceUseCase {
  constructor(private readonly deps: ResolvePendingReferenceDeps) {}

  execute(p: ResolvePendingReferenceParams): Promise<ResolvePendingReferenceResult> {
    return retryTransient(() => this.runOnce(p), {
      ...TRANSIENT_RETRY,
      isTransient: this.deps.isTransient,
    });
  }

  private runOnce(p: ResolvePendingReferenceParams): Promise<ResolvePendingReferenceResult> {
    const { transactionRunner, wallets, transactions, ids, clock, referenceRetry } = this.deps;

    return transactionRunner.run(async () => {
      // 1. lock da wallet antes de ler a transação, como em todo processamento
      const wallet = await wallets.lockById(p.walletId);
      if (!wallet) throw new InvariantViolationError(`wallet ${p.walletId} of a pending not found`);

      // 2. recarrega sob o lock: se outra instância já decidiu, não há o que fazer
      const tx = await transactions.findById(p.transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference)
        return { outcome: 'skipped' };
      if (tx.walletId !== wallet.id) {
        throw new InvariantViolationError('pending transaction belongs to another wallet');
      }

      // 3. mesmas regras do processamento, mais o limite de tentativas
      const reference = await findReference(transactions, tx);
      const expectedVersion = wallet.version;
      const at = clock.now();
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
        outcome: PENDING_OUTCOMES[decision.outcome],
        providerId: tx.providerId,
        attempts: tx.referenceAttempts,
      };
    });
  }
}
