import { Migration } from '@mikro-orm/migrations';

/**
 * Partidas dobradas: cada movimentação de saldo da wallet ganha uma contrapartida igual e oposta
 * na conta da casa (`house:{provider}:{currency}`), na tabela `journal_entries`. A soma-zero por
 * transação é garantida no schema: um trigger confere direção oposta + mesmo valor + mesma moeda,
 * e um constraint trigger deferido exige que toda wallet entry tenha a sua contrapartida.
 */
export class Migration20261025000000_double_entry_journal extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE journal_entries (
        id UUID PRIMARY KEY,
        transaction_id UUID NOT NULL REFERENCES wager_transactions (id),
        account_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT journal_tx_uq UNIQUE (transaction_id),
        CONSTRAINT journal_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT journal_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT journal_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$')
      )`);

    // Journal append-only, como o ledger.
    this.addSql(`
      CREATE FUNCTION forbid_journal_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'journal_entries is append-only (% not allowed)', TG_OP;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION forbid_journal_mutation()`);

    // A contrapartida precisa ser igual e oposta à entrada da wallet.
    this.addSql(`
      CREATE FUNCTION guard_journal_matches_wallet() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        wallet_direction TEXT;
        wallet_amount NUMERIC(20,2);
        wallet_currency CHAR(3);
      BEGIN
        SELECT direction, amount, currency INTO wallet_direction, wallet_amount, wallet_currency
        FROM wallet_ledger_entries
        WHERE transaction_id = NEW.transaction_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'journal entry has no matching wallet ledger entry';
        END IF;
        IF (wallet_direction = 'DEBIT' AND NEW.direction <> 'CREDIT')
           OR (wallet_direction = 'CREDIT' AND NEW.direction <> 'DEBIT') THEN
          RAISE EXCEPTION 'journal entry direction must be opposite to the wallet entry';
        END IF;
        IF NEW.amount <> wallet_amount OR NEW.currency <> wallet_currency THEN
          RAISE EXCEPTION 'journal entry must match the wallet entry amount and currency';
        END IF;
        RETURN NEW;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER journal_matches_wallet BEFORE INSERT ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION guard_journal_matches_wallet()`);

    // Toda entrada de wallet precisa ter a sua contrapartida (conferido no COMMIT).
    this.addSql(`
      CREATE FUNCTION require_journal_counterpart() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM journal_entries j WHERE j.transaction_id = NEW.transaction_id
        ) THEN
          RAISE EXCEPTION 'wallet ledger entry % has no matching journal entry', NEW.id;
        END IF;
        RETURN NULL;
      END;
      $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_requires_journal AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION require_journal_counterpart()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER wallet_requires_journal ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION require_journal_counterpart()');
    this.addSql('DROP TRIGGER journal_matches_wallet ON journal_entries');
    this.addSql('DROP FUNCTION guard_journal_matches_wallet()');
    this.addSql('DROP TRIGGER journal_append_only ON journal_entries');
    this.addSql('DROP FUNCTION forbid_journal_mutation()');
    this.addSql('DROP TABLE journal_entries');
  }
}
