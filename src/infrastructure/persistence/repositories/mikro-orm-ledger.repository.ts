import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { LedgerRepository } from '../../../application/ports/ledger.repository';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { type LedgerEntryRecord, LedgerEntrySchema } from '../schemas/ledger-entry.schema';

@Injectable()
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  /** Só `INSERT`: o trigger do banco impede `UPDATE`/`DELETE` no ledger. */
  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, toRecord(entry));
  }
}

function toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}
