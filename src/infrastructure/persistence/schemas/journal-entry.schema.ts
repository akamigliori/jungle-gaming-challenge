import { EntitySchema } from '@mikro-orm/core';

/** Linha da tabela `journal_entries` (append-only). Valores `NUMERIC` trafegam como string. */
export interface JournalEntryRecord {
  id: string;
  transactionId: string;
  accountId: string;
  direction: string;
  amount: string;
  currency: string;
  createdAt: Date;
}

export const JournalEntrySchema = new EntitySchema<JournalEntryRecord>({
  name: 'JournalEntryRecord',
  tableName: 'journal_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    transactionId: { type: 'uuid' },
    accountId: { type: 'string' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
});
