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
import { CreateWalletUseCase } from './application/wallet/create-wallet.use-case';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { LedgerQuery } from './infrastructure/persistence/queries/ledger.query';
import { MikroOrmLedgerRepository } from './infrastructure/persistence/repositories/mikro-orm-ledger.repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/repositories/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/repositories/mikro-orm-wallet.repository';
import { WalletsController } from './interfaces/http/wallets/wallets.controller';

/**
 * Wallets: liga as portas da aplicação aos adaptadores MikroORM. O caso de uso é montado
 * por factory para que a camada de aplicação continue sem decorators do Nest.
 */
@Module({
  controllers: [WalletsController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MikroOrmTransactionRunner },
    { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroOrmLedgerRepository },
    { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
    LedgerQuery,
    {
      provide: CreateWalletUseCase,
      inject: [
        TRANSACTION_RUNNER,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        LEDGER_REPOSITORY,
        OUTBOX_REPOSITORY,
        ID_GENERATOR,
        CLOCK,
      ],
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
  ],
})
export class WalletModule {}
