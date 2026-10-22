import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from './application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator';
import { INBOX_REPOSITORY, type InboxRepository } from './application/ports/inbox.repository';
import { LEDGER_REPOSITORY, type LedgerRepository } from './application/ports/ledger.repository';
import { METRICS, type Metrics } from './application/ports/metrics';
import { OUTBOX_REPOSITORY, type OutboxRepository } from './application/ports/outbox.repository';
import { TRANSACTION_RUNNER, type TransactionRunner } from './application/ports/transaction-runner';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from './application/ports/wager-transaction.repository';
import { WALLET_REPOSITORY, type WalletRepository } from './application/ports/wallet.repository';
import { ProcessWagerTransactionUseCase } from './application/wager/process-wager-transaction.use-case';
import { ResolvePendingReferenceUseCase } from './application/wager/resolve-pending-reference.use-case';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/config';
import { isTransientDbError, isWagerUniqueViolation } from './infrastructure/persistence/pg-errors';
import { WagerTransactionQuery } from './infrastructure/persistence/queries/wager-transaction.query';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { WageringController } from './interfaces/http/wagering/wagering.controller';
import { WagerTransactionsConsumer } from './interfaces/sqs/wager-transactions.consumer';

/**
 * Transações de aposta: o caso de uso é montado por factory para que a camada de aplicação
 * continue sem decorators do Nest; a classificação dos erros do Postgres entra como funções,
 * sem a aplicação importar a infraestrutura. HTTP (controller) e SQS (consumer) chamam o mesmo caso
 * de uso, que também é exportado para outros pontos de entrada. As referências pendentes são
 * reavaliadas por um worker com o seu próprio caso de uso, sobre os mesmos repositórios.
 */
@Module({
  controllers: [WageringController],
  providers: [
    WagerTransactionQuery,
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [
        TRANSACTION_RUNNER,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        LEDGER_REPOSITORY,
        INBOX_REPOSITORY,
        OUTBOX_REPOSITORY,
        ID_GENERATOR,
        CLOCK,
        METRICS,
        APP_CONFIG,
      ],
      useFactory: (
        transactionRunner: TransactionRunner,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: LedgerRepository,
        inbox: InboxRepository,
        outbox: OutboxRepository,
        ids: IdGenerator,
        clock: Clock,
        metrics: Metrics,
        config: AppConfig,
      ) =>
        new ProcessWagerTransactionUseCase({
          transactionRunner,
          wallets,
          transactions,
          ledger,
          inbox,
          outbox,
          ids,
          clock,
          metrics,
          isTransient: isTransientDbError,
          isUniqueViolation: isWagerUniqueViolation,
          referenceRetry: config.pendingReference.retry,
        }),
    },
    {
      provide: ResolvePendingReferenceUseCase,
      inject: [
        TRANSACTION_RUNNER,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        LEDGER_REPOSITORY,
        OUTBOX_REPOSITORY,
        ID_GENERATOR,
        CLOCK,
        METRICS,
        APP_CONFIG,
      ],
      useFactory: (
        transactionRunner: TransactionRunner,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: LedgerRepository,
        outbox: OutboxRepository,
        ids: IdGenerator,
        clock: Clock,
        metrics: Metrics,
        config: AppConfig,
      ) =>
        new ResolvePendingReferenceUseCase({
          transactionRunner,
          wallets,
          transactions,
          ledger,
          outbox,
          ids,
          clock,
          metrics,
          isTransient: isTransientDbError,
          referenceRetry: config.pendingReference.retry,
        }),
    },
    WagerTransactionsConsumer,
    PendingReferenceWorker,
  ],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
