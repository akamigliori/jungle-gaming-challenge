import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { JournalRepository } from '../../../application/ports/journal.repository';
import type { JournalEntry } from '../../../domain/wallet/journal-entry';
import { type JournalEntryRecord, JournalEntrySchema } from '../schemas/journal-entry.schema';

@Injectable()
export class MikroOrmJournalRepository implements JournalRepository {
  constructor(private readonly em: EntityManager) {}

  /** Só `INSERT`: o trigger do banco impede `UPDATE`/`DELETE` no journal. */
  async append(entry: JournalEntry): Promise<void> {
    await this.em.insert(JournalEntrySchema, toRecord(entry));
  }
}

function toRecord(entry: JournalEntry): JournalEntryRecord {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    accountId: entry.accountId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    createdAt: entry.createdAt,
  };
}
