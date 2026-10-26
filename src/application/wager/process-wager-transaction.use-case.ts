import { InboxMessage } from '../../domain/messaging/inbox-message';
import {
  DomainError,
  InvalidPayloadError,
  InvariantViolationError,
} from '../../domain/shared/domain-error';
import { Money, type MoneyProps } from '../../domain/shared/money';
import type { ReferenceRetryPolicy } from '../../domain/wager/reference-retry';
import { decideWager } from '../../domain/wager/wager-decision';
import { OPENING_PROVIDER_ID, WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { InboxReceipt, InboxRepository } from '../ports/inbox.repository';
import type { JournalRepository } from '../ports/journal.repository';
import type { LedgerRepository } from '../ports/ledger.repository';
import type { Metrics, ProcessingChannel, ProcessingOutcome } from '../ports/metrics';
import type { OutboxRepository } from '../ports/outbox.repository';
import type {
  SubmissionChannel,
  SubmissionFailureInput,
} from '../ports/submission-failure.repository';
import type { TransactionRunner } from '../ports/transaction-runner';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';
import { retryTransient } from '../shared/retry-transient';
import { WalletNotFoundError } from '../wallet/wallet-errors';
import { findReference } from './find-reference';
import { auditPayloadHash, computePayloadHash, type WagerPayload } from './payload-hash';
import { recordDecision } from './record-decision';
import { classifySubmissionFailure } from './submission-failure-classification';
import { IdempotencyConflictError } from './wager-errors';

export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** Recibo da mensagem SQS; ausente nas chamadas HTTP. */
  inbox?: InboxReceipt;
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  /** Verdadeiro quando a transação já existia e foi devolvida como gravada. */
  idempotentReplay: boolean;
}

export interface ProcessWagerDeps {
  transactionRunner: TransactionRunner;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  journal: JournalRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
  metrics: Metrics;
  /** Erro que some ao refazer a transação inteira (lock_timeout, deadlock, conexão). */
  isTransient: (error: unknown) => boolean;
  /** Violação das constraints UNIQUE das transações de aposta (corrida no INSERT). */
  isUniqueViolation: (error: unknown) => boolean;
  /** Backoff da referência pendente: define a primeira espera de quem fica `PENDING_REFERENCE`. */
  referenceRetry: ReferenceRetryPolicy;
  /** Auditoria best-effort das recusas que não viram resultado de negócio. */
  auditFailure: (input: SubmissionFailureInput) => Promise<void>;
}

/** Política de novas tentativas em falhas transitórias: 3 execuções, espera base de 50 ms. */
const TRANSIENT_RETRY = { maxAttempts: 3, baseDelayMs: 50 } as const;

/** Resultado interno de uma execução: `redelivered` marca a mensagem SQS já registrada na inbox. */
type Execution = ProcessWagerResult & { redelivered: boolean };

const TRANSACTION_OUTCOMES: Record<WagerTransactionStatus, ProcessingOutcome> = {
  [WagerTransactionStatus.Processed]: 'processed',
  [WagerTransactionStatus.Rejected]: 'rejected',
  [WagerTransactionStatus.Pending]: 'pending',
  [WagerTransactionStatus.PendingReference]: 'pending',
  [WagerTransactionStatus.Failed]: 'error',
};

/** Comando já validado fora da transação. */
interface ValidatedWager {
  cmd: ProcessWagerCommand;
  money: Money;
  payloadHash: string;
}

/**
 * Processa BET, WIN, LOSS, REFUND e ROLLBACK numa única transação SQL: trava a wallet, registra a
 * inbox, verifica a idempotência, aplica as regras e grava wallet, transação, ledger e outbox
 * juntos. Ponto de entrada único para HTTP e SQS.
 */
export class ProcessWagerTransactionUseCase {
  constructor(private readonly deps: ProcessWagerDeps) {}

  async execute(cmd: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const { metrics } = this.deps;
    const channel: ProcessingChannel = cmd.inbox ? 'sqs' : 'http';
    const startedAt = performance.now();
    let outcome: ProcessingOutcome = 'error';
    try {
      const wager = this.validate(cmd);
      const { redelivered, ...result } = await retryTransient(
        () => this.runWithReRunOnConflict(wager),
        {
          ...TRANSIENT_RETRY,
          isTransient: this.deps.isTransient,
          onTransient: (error) => metrics.lockConflict(error),
          onRetry: () => metrics.retryScheduled('use_case_transient'),
        },
      );
      outcome = this.recordResult(channel, result, redelivered);
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) outcome = 'conflict';
      // auditoria best-effort, fora da transação que falhou; nunca muda o erro original
      try {
        await this.auditSubmissionFailure(cmd, channel, error);
      } catch {
        // nunca mascara o erro que o cliente precisa ver
      }
      throw error;
    } finally {
      metrics.processingTimed(channel, outcome, (performance.now() - startedAt) / 1000);
    }
  }

  /**
   * Registra a recusa que não virou resultado de negócio. Rejeições de negócio (`REJECTED`) já são
   * persistidas como transação e não passam por aqui; erros de programação e transitórios também
   * ficam de fora. O hash é o da idempotência quando o dinheiro é válido.
   */
  private async auditSubmissionFailure(
    cmd: ProcessWagerCommand,
    channel: ProcessingChannel,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof DomainError)) return;
    if (this.deps.isTransient(error)) return;
    const classification = classifySubmissionFailure(error.code);
    if (!classification) return;
    const submissionChannel: SubmissionChannel = channel === 'sqs' ? 'SQS' : 'HTTP';
    await this.deps.auditFailure({
      channel: submissionChannel,
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      walletId: cmd.walletId,
      messageId: cmd.inbox?.messageId ?? null,
      payloadHash: auditPayloadHash(payloadOf(cmd)),
      reasonCode: error.code,
      category: classification.category,
      retryable: classification.retryable,
      correlationId: cmd.correlationId,
      detail: error.message,
    });
  }

  /** Conta o resultado já commitado; devolve o desfecho para a latência. */
  private recordResult(
    channel: ProcessingChannel,
    { transaction, idempotentReplay }: ProcessWagerResult,
    redelivered: boolean,
  ): ProcessingOutcome {
    const { metrics } = this.deps;
    if (idempotentReplay) {
      metrics.duplicateDetected(redelivered ? 'inbox_redelivery' : 'idempotency_replay');
      return 'replay';
    }
    metrics.transactionRecorded({
      channel,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
    });
    return TRANSACTION_OUTCOMES[transaction.status];
  }

  /** Validações que não dependem do banco; falham antes de abrir a transação. */
  private validate(input: ProcessWagerCommand): ValidatedWager {
    // UUIDs em minúsculas antes de qualquer uso: o consumer SQS chega aqui sem o schema HTTP
    const cmd = {
      ...input,
      walletId: input.walletId.toLowerCase(),
      playerId: input.playerId.toLowerCase(),
    };
    const money = Money.from(cmd.money);
    if (cmd.kind === WagerTransactionKind.Opening || cmd.providerId === OPENING_PROVIDER_ID) {
      throw new InvalidPayloadError('OPENING transactions and the internal provider are reserved');
    }
    const payloadHash = computePayloadHash(payloadOf(cmd));
    const wager = { cmd, money, payloadHash };
    // valida a exigência de referência e o valor positivo; cada execução cria a sua transação,
    // porque a decisão muta o objeto
    this.newTransaction(wager);
    return wager;
  }

  /**
   * Duas requisições com a mesma chave em wallets diferentes não disputam o mesmo lock: a segunda
   * esbarra na UNIQUE do banco no INSERT. A transação é desfeita e executada mais uma vez, quando
   * a consulta de idempotência já enxerga a original (replay ou conflito).
   */
  private async runWithReRunOnConflict(wager: ValidatedWager): Promise<Execution> {
    try {
      return await this.runOnce(wager);
    } catch (error) {
      if (!this.deps.isUniqueViolation(error)) throw error;
      return this.runOnce(wager);
    }
  }

  private runOnce(wager: ValidatedWager): Promise<Execution> {
    const { transactionRunner, wallets, inbox, ids, clock, metrics } = this.deps;
    const { cmd } = wager;

    return transactionRunner.run(async () => {
      let redelivered = false;
      // 1. lock da wallet antes de qualquer leitura: duplicatas concorrentes esperam aqui
      const wallet = await wallets.lockById(cmd.walletId);
      if (!wallet) throw new WalletNotFoundError('wallet not found');
      if (wallet.id !== cmd.walletId) {
        throw new InvariantViolationError('locked wallet differs from the requested wallet');
      }

      // 2. inbox na mesma transação: a entrega só fica registrada se o processamento commitar.
      // Duplicata segue adiante e cai no replay pela chave de idempotência (a entrega é uma
      // coisa, a operação de negócio é outra); outro corpo com o mesmo messageId é conflito.
      if (cmd.inbox) {
        const receivedAt = clock.now();
        const message = InboxMessage.receive({ ...cmd.inbox, receivedAt });
        // a linha só existe se o processamento commitar: recebida e processada no mesmo instante
        message.markProcessed(receivedAt);
        const delivery = await inbox.register(message);
        if (delivery === 'conflict') {
          metrics.duplicateDetected('inbox_conflict');
          throw new IdempotencyConflictError('messageId already used with a different payload');
        }
        redelivered = delivery === 'duplicate';
      }

      // 3. idempotência depois do lock: enxerga a original já commitada
      const existing = await this.findExisting(wager);
      if (existing) return { transaction: existing, idempotentReplay: true, redelivered };

      // 4. transação nova: regras de negócio sobre a wallet travada
      const tx = this.newTransaction(wager);
      const reference = await findReference(this.deps.transactions, tx);
      const expectedVersion = wallet.version;
      const at = clock.now();
      const decision = decideWager({
        tx,
        wallet,
        reference,
        at,
        entryId: ids.next(),
        retry: this.deps.referenceRetry,
      });

      // 5. grava o resultado (aplicado, rejeitado ou pendente) na mesma transação
      await recordDecision(this.deps, {
        tx,
        wallet,
        decision,
        expectedVersion,
        at,
        correlationId: cmd.correlationId,
        persist: 'insert',
      });
      return { transaction: tx, idempotentReplay: false, redelivered };
    });
  }

  /**
   * Mesma chave e mesmo payload → a original (replay). Mesma chave com outro payload, ou mesmo
   * id externo com outra chave → conflito.
   */
  private async findExisting(wager: ValidatedWager): Promise<WagerTransaction | null> {
    const { transactions } = this.deps;
    const { cmd, payloadHash } = wager;

    const { byKey, byExternalId } = await transactions.findByIdempotency(
      cmd.providerId,
      cmd.idempotencyKey,
      cmd.externalTransactionId,
    );
    if (byKey) {
      if (!byKey.matchesPayload(payloadHash)) {
        this.deps.metrics.duplicateDetected('idempotency_conflict');
        throw new IdempotencyConflictError('idempotency key already used with a different payload');
      }
      return byKey;
    }
    if (byExternalId) {
      this.deps.metrics.duplicateDetected('idempotency_conflict');
      throw new IdempotencyConflictError(
        'externalTransactionId already used with a different idempotency key',
      );
    }
    return null;
  }

  private newTransaction({ cmd, money, payloadHash }: ValidatedWager): WagerTransaction {
    const { ids, clock } = this.deps;
    return WagerTransaction.create({
      id: ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: clock.now(),
    });
  }
}

/** Campos de negócio que entram no hash (sem chave de idempotência nem correlationId). */
function payloadOf(cmd: ProcessWagerCommand): WagerPayload {
  return {
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: cmd.money,
    referenceExternalTransactionId: cmd.referenceExternalTransactionId,
  };
}
