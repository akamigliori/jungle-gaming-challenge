import { Migration } from '@mikro-orm/migrations';

/**
 * Índice parcial para acordar as transações que esperam uma referência: cada transação que chega
 * a um estado terminal procura as pendentes da mesma wallet/provedor que apontam para ela. Só
 * cobre linhas `PENDING_REFERENCE`, então continua pequeno.
 */
export class Migration20261021000000_pending_reference_dependents_index extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE INDEX wager_tx_pending_dependents_idx
      ON wager_transactions (wallet_id, provider_id, reference_external_transaction_id)
      WHERE status = 'PENDING_REFERENCE'`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX wager_tx_pending_dependents_idx');
  }
}
