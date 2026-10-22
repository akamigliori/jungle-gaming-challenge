import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from './application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator';
import { LEDGER_REPOSITORY, type LedgerRepository } from './application/ports/ledger.repository';
import { OUTBOX_REPOSITORY, type OutboxRepository } from './application/ports/outbox.repository';
import { TRANSACTION_RUNNER, type TransactionRunner } from './application/ports/transaction-runner';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from './application/ports/wager-transaction.repository';
import { WALLET_REPOSITORY, type WalletRepository } from './application/ports/wallet.repository';
import { ProcessWagerTransactionUseCase } from './application/wager/process-wager-transaction.use-case';
import { CreateWalletUseCase } from './application/wallet/create-wallet.use-case';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { isTransientDbError, isWagerUniqueViolation } from './infrastructure/persistence/pg-errors';
import { LedgerQuery } from './infrastructure/persistence/queries/ledger.query';
import { WagerTransactionQuery } from './infrastructure/persistence/queries/wager-transaction.query';
import { MikroOrmLedgerRepository } from './infrastructure/persistence/repositories/mikro-orm-ledger.repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/repositories/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/repositories/mikro-orm-wallet.repository';
import { WageringController } from './interfaces/http/wagering/wagering.controller';
import { WalletsController } from './interfaces/http/wallets/wallets.controller';

const USE_CASE_DEPS = [
  TRANSACTION_RUNNER,
  WALLET_REPOSITORY,
  WAGER_TRANSACTION_REPOSITORY,
  LEDGER_REPOSITORY,
  OUTBOX_REPOSITORY,
  ID_GENERATOR,
  CLOCK,
];

/**
 * Wallets e transações de aposta: liga as portas da aplicação aos adaptadores MikroORM. Os casos
 * de uso são montados por factory para que a camada de aplicação continue sem decorators do Nest;
 * a classificação dos erros do Postgres entra como funções, sem a aplicação importar a infraestrutura.
 */
@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MikroOrmTransactionRunner },
    { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroOrmLedgerRepository },
    { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
    LedgerQuery,
    WagerTransactionQuery,
    {
      provide: CreateWalletUseCase,
      inject: USE_CASE_DEPS,
      useFactory: (
        transactionRunner: TransactionRunner,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: LedgerRepository,
        outbox: OutboxRepository,
        ids: IdGenerator,
        clock: Clock,
      ) =>
        new CreateWalletUseCase({
          transactionRunner,
          wallets,
          transactions,
          ledger,
          outbox,
          ids,
          clock,
        }),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: USE_CASE_DEPS,
      useFactory: (
        transactionRunner: TransactionRunner,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: LedgerRepository,
        outbox: OutboxRepository,
        ids: IdGenerator,
        clock: Clock,
      ) =>
        new ProcessWagerTransactionUseCase({
          transactionRunner,
          wallets,
          transactions,
          ledger,
          outbox,
          ids,
          clock,
          isTransient: isTransientDbError,
          isUniqueViolation: isWagerUniqueViolation,
        }),
    },
  ],
})
export class WalletModule {}
