import { Global, Module } from '@nestjs/common';
import { LEDGER_REPOSITORY } from './application/ports/ledger.repository';
import { OUTBOX_REPOSITORY } from './application/ports/outbox.repository';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner';
import { WAGER_TRANSACTION_REPOSITORY } from './application/ports/wager-transaction.repository';
import { WALLET_REPOSITORY } from './application/ports/wallet.repository';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { MikroOrmLedgerRepository } from './infrastructure/persistence/repositories/mikro-orm-ledger.repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/repositories/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/repositories/mikro-orm-wallet.repository';

const PERSISTENCE_PROVIDERS = [
  { provide: TRANSACTION_RUNNER, useClass: MikroOrmTransactionRunner },
  { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
  { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
  { provide: LEDGER_REPOSITORY, useClass: MikroOrmLedgerRepository },
  { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
];

/**
 * Liga as portas de persistência da aplicação aos adaptadores MikroORM. É global para que os
 * módulos de negócio e de mensageria compartilhem uma única instância de cada repositório.
 */
@Global()
@Module({
  providers: PERSISTENCE_PROVIDERS,
  exports: PERSISTENCE_PROVIDERS.map((provider) => provider.provide),
})
export class PersistenceModule {}
