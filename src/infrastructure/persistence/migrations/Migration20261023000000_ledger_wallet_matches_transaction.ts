import { Migration } from '@mikro-orm/migrations';

/**
 * Garante, no schema, que cada lançamento do ledger pertence à mesma wallet da transação referenciada.
 * `transaction_id` já tem FK própria, mas nada impedia uma linha com `wallet_id` trocado. A alternativa
 * declarativa (FK composta) exigiria um `UNIQUE (id, wallet_id)` redundante em `wager_transactions`;
 * como a tabela é a mais quente do fluxo, a conferência fica num trigger, sem índice a mais.
 */
export class Migration20261023000000_ledger_wallet_matches_transaction extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION guard_ledger_wallet_matches_transaction() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM wager_transactions
          WHERE id = NEW.transaction_id AND wallet_id = NEW.wallet_id
        ) THEN
          RAISE EXCEPTION 'wallet_ledger_entries.wallet_id must match the referenced transaction';
        END IF;
        RETURN NEW;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER ledger_wallet_matches_transaction BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION guard_ledger_wallet_matches_transaction()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER ledger_wallet_matches_transaction ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION guard_ledger_wallet_matches_transaction()');
  }
}
