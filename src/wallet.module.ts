import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from './application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator';
import { LEDGER_REPOSITORY, type LedgerRepository } from './application/ports/ledger.repository';
import { METRICS, type Metrics } from './application/ports/metrics';
import { OUTBOX_REPOSITORY, type OutboxRepository } from './application/ports/outbox.repository';
import { TRANSACTION_RUNNER, type TransactionRunner } from './application/ports/transaction-runner';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from './application/ports/wager-transaction.repository';
import { WALLET_REPOSITORY, type WalletRepository } from './application/ports/wallet.repository';
import {
  WALLET_LEDGER_READER,
  type WalletLedgerReader,
} from './application/ports/wallet-ledger-reader';
import { CreateWalletUseCase } from './application/wallet/create-wallet.use-case';
import { ReconcileWalletUseCase } from './application/wallet/reconcile-wallet.use-case';
import { LedgerQuery } from './infrastructure/persistence/queries/ledger.query';
import { WalletLedgerQuery } from './infrastructure/persistence/queries/wallet-ledger.query';
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

/** Wallets: o caso de uso é montado por factory para que a camada de aplicação continue sem decorators do Nest. */
@Module({
  controllers: [WalletsController],
  providers: [
    LedgerQuery,
    WalletLedgerQuery,
    { provide: WALLET_LEDGER_READER, useExisting: WalletLedgerQuery },
    {
      provide: ReconcileWalletUseCase,
      inject: [WALLET_LEDGER_READER, METRICS, CLOCK],
      useFactory: (reader: WalletLedgerReader, metrics: Metrics, clock: Clock) =>
        new ReconcileWalletUseCase({ reader, metrics, clock }),
    },
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
  ],
})
export class WalletModule {}
