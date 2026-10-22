import type { IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { InvalidPayloadError, InvariantViolationError } from '../../domain/shared/domain-error';
import { Money, type MoneyProps } from '../../domain/shared/money';
import {
  decideWager,
  type ReferenceView,
  type WagerDecision,
} from '../../domain/wager/wager-decision';
import { OPENING_PROVIDER_ID, WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { LedgerRepository } from '../ports/ledger.repository';
import type { OutboxRepository } from '../ports/outbox.repository';
import type { TransactionRunner } from '../ports/transaction-runner';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';
import { retryTransient } from '../shared/retry-transient';
import { WalletNotFoundError } from '../wallet/wallet-errors';
import { computePayloadHash, type WagerPayload } from './payload-hash';
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
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
  /** Erro que some ao refazer a transação inteira (lock_timeout, deadlock, conexão). */
  isTransient: (error: unknown) => boolean;
  /** Violação das constraints UNIQUE das transações de aposta (corrida no INSERT). */
  isUniqueViolation: (error: unknown) => boolean;
}

/** Política de novas tentativas em falhas transitórias: 3 execuções, espera base de 50 ms. */
const TRANSIENT_RETRY = { maxAttempts: 3, baseDelayMs: 50 } as const;

/** Comando já validado fora da transação. */
interface ValidatedWager {
  cmd: ProcessWagerCommand;
  money: Money;
  payloadHash: string;
}

/**
 * Processa BET, WIN, LOSS, REFUND e ROLLBACK numa única transação SQL: trava a wallet,
 * verifica a idempotência, aplica as regras e grava wallet, transação, ledger e outbox juntos.
 * Ponto de entrada único para HTTP e SQS.
 */
export class ProcessWagerTransactionUseCase {
  constructor(private readonly deps: ProcessWagerDeps) {}

  async execute(cmd: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const wager = this.validate(cmd);
    return retryTransient(() => this.runWithReRunOnConflict(wager), {
      ...TRANSIENT_RETRY,
      isTransient: this.deps.isTransient,
    });
  }

  /** Validações que não dependem do banco; falham antes de abrir a transação. */
  private validate(cmd: ProcessWagerCommand): ValidatedWager {
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
  private async runWithReRunOnConflict(wager: ValidatedWager): Promise<ProcessWagerResult> {
    try {
      return await this.runOnce(wager);
    } catch (error) {
      if (!this.deps.isUniqueViolation(error)) throw error;
      return this.runOnce(wager);
    }
  }

  private runOnce(wager: ValidatedWager): Promise<ProcessWagerResult> {
    const { transactionRunner, wallets, ids, clock } = this.deps;
    const { cmd } = wager;

    return transactionRunner.run(async () => {
      // 1. lock da wallet antes de qualquer leitura: duplicatas concorrentes esperam aqui
      const wallet = await wallets.lockById(cmd.walletId);
      if (!wallet) throw new WalletNotFoundError('wallet not found');
      if (wallet.id !== cmd.walletId) {
        throw new InvariantViolationError('locked wallet differs from the requested wallet');
      }

      // 2. idempotência depois do lock: enxerga a original já commitada
      const existing = await this.findExisting(wager);
      if (existing) return { transaction: existing, idempotentReplay: true };

      // 3. transação nova: regras de negócio sobre a wallet travada
      const tx = this.newTransaction(wager);
      const reference = await this.resolveReference(cmd);
      const expectedVersion = wallet.version;
      const at = clock.now();
      const decision = decideWager({ tx, wallet, reference, at, entryId: ids.next() });

      // 4. grava o resultado (aplicado, rejeitado ou pendente) na mesma transação
      await this.record({
        tx,
        wallet,
        decision,
        expectedVersion,
        at,
        correlationId: cmd.correlationId,
      });
      return { transaction: tx, idempotentReplay: false };
    });
  }

  /**
   * Mesma chave e mesmo payload → a original (replay). Mesma chave com outro payload, ou mesmo
   * id externo com outra chave → conflito.
   */
  private async findExisting(wager: ValidatedWager): Promise<WagerTransaction | null> {
    const { transactions } = this.deps;
    const { cmd, payloadHash } = wager;

    const byKey = await transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
    if (byKey) {
      if (!byKey.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError('idempotency key already used with a different payload');
      }
      return byKey;
    }
    const byExternalId = await transactions.findByExternalId(
      cmd.providerId,
      cmd.externalTransactionId,
    );
    if (byExternalId) {
      throw new IdempotencyConflictError(
        'externalTransactionId already used with a different idempotency key',
      );
    }
    return null;
  }

  /** `null` quando a referência informada ainda não existe; ignorada se não houver referência. */
  private async resolveReference(cmd: ProcessWagerCommand): Promise<ReferenceView | null> {
    const { transactions } = this.deps;
    if (cmd.referenceExternalTransactionId === undefined) return null;
    const transaction = await transactions.findByExternalId(
      cmd.providerId,
      cmd.referenceExternalTransactionId,
    );
    if (!transaction) return null;
    return { transaction, alreadyReversed: await transactions.isReversed(transaction.id) };
  }

  /** Ordem de escrita: wallet → transação → ledger → outbox. */
  private async record(p: {
    tx: WagerTransaction;
    wallet: Wallet;
    decision: WagerDecision;
    expectedVersion: number;
    at: Date;
    correlationId: string;
  }): Promise<void> {
    const { wallets, transactions, ledger, outbox, ids } = this.deps;
    const { tx, wallet, decision } = p;
    const entry = decision.outcome === 'PROCESSED' ? decision.entry : null;

    if (entry) await wallets.save(wallet, p.expectedVersion);
    await transactions.add(tx);
    if (entry) await ledger.append(entry);

    const context = () => ({
      eventId: ids.next(),
      correlationId: p.correlationId,
      occurredAt: p.at,
    });
    const enqueue = (event: IntegrationEvent<unknown>) =>
      outbox.enqueue(OutboxMessage.enqueue(event));
    switch (decision.outcome) {
      case 'PROCESSED':
        await enqueue(WagerTransactionProcessed.from(tx, context()));
        if (entry) await enqueue(WalletBalanceChanged.from(wallet, entry, context()));
        return;
      case 'REJECTED':
        await enqueue(WagerTransactionRejected.from(tx, context()));
        return;
      case 'PENDING_REFERENCE':
        await enqueue(WagerTransactionPendingReference.from(tx, context()));
        return;
    }
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
