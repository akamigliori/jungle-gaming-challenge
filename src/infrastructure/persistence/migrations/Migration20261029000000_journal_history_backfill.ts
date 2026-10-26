import { Migration } from '@mikro-orm/migrations';

/** Reconstrói contrapartidas do ledger anterior à introdução do journal, sem reescrever histórico. */
export class Migration20261029000000_journal_history_backfill extends Migration {
  override async up(): Promise<void> {
    // Serializa com inserções no journal; o ledger é append-only e os triggers continuam ativos.
    this.addSql('LOCK TABLE journal_entries IN SHARE ROW EXCLUSIVE MODE');
    this.addSql(`
      INSERT INTO journal_entries
        (id, transaction_id, account_id, direction, amount, currency, created_at)
      SELECT gen_random_uuid(), l.transaction_id,
             'house:' || t.provider_id || ':' || l.currency,
             CASE l.direction WHEN 'CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END,
             l.amount, l.currency, l.created_at
        FROM wallet_ledger_entries l
        JOIN wager_transactions t ON t.id = l.transaction_id
       WHERE NOT EXISTS (
         SELECT 1 FROM journal_entries j WHERE j.transaction_id = l.transaction_id
       )`);
  }

  override async down(): Promise<void> {
    // Rollback não apaga contrapartidas já auditáveis; reaplicar só preenche o que ainda faltar.
  }
}
