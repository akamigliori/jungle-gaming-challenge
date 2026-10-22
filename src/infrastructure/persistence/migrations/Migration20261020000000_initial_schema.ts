import { Migration } from '@mikro-orm/migrations';

/** Schema inicial: SQL escrito à mão para que cada constraint tenha nome estável. */
export class Migration20261020000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(20,2) NOT NULL,
        version INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive_ck CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets (id),
        player_id UUID NOT NULL,
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id TEXT NULL,
        reference_transaction_id UUID NULL REFERENCES wager_transactions (id),
        status TEXT NOT NULL,
        failure_code TEXT NULL,
        reference_attempts INT NOT NULL DEFAULT 0,
        next_reference_attempt_at TIMESTAMPTZ NULL,
        balance_after NUMERIC(20,2) NULL,
        wallet_version_after INT NULL,
        processed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_provider_idem_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT wager_tx_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_kind_ck CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_reference_by_kind_ck CHECK (
          (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind IN ('BET','OPENING') AND reference_external_transaction_id IS NULL)
          OR kind IN ('WIN','LOSS')
        ),
        CONSTRAINT wager_tx_processed_at_ck CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_ck CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_balance_after_ck CHECK (balance_after IS NULL OR balance_after >= 0),
        CONSTRAINT wager_tx_processed_snapshot_ck CHECK (
          status <> 'PROCESSED' OR (balance_after IS NOT NULL AND wallet_version_after IS NOT NULL)
        ),
        -- REFUND/ROLLBACK processado precisa apontar a transação revertida: com NULL, o índice
        -- único de reversão não enxergaria a linha (NULLs são distintos entre si).
        CONSTRAINT wager_tx_reversal_resolved_ck CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_reference_not_self_ck CHECK (
          reference_transaction_id IS NULL OR reference_transaction_id <> id
        ),
        CONSTRAINT wager_tx_wallet_version_after_ck CHECK (
          wallet_version_after IS NULL OR wallet_version_after >= 1
        ),
        CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0)
      )`);

    // Uma transação só pode ser revertida uma vez no total (REFUND ou ROLLBACK).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx ON wager_transactions (next_reference_attempt_at)
      WHERE status = 'PENDING_REFERENCE'`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL REFERENCES wager_transactions (id),
        direction TEXT NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(20,2) NOT NULL,
        balance_after NUMERIC(20,2) NOT NULL,
        wallet_version INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),
        CONSTRAINT ledger_tx_wallet_uq UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_direction_ck CHECK (direction IN ('CREDIT','DEBIT')),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ledger_balance_before_ck CHECK (balance_before >= 0),
        CONSTRAINT ledger_balance_after_ck CHECK (balance_after >= 0),
        CONSTRAINT ledger_wallet_version_ck CHECK (wallet_version >= 1),
        CONSTRAINT ledger_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ NULL,
        last_error TEXT NULL,
        CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0)
      )`);
    this.addSql(`
      CREATE INDEX outbox_unpublished_idx ON outbox_messages (next_attempt_at)
      WHERE published_at IS NULL`);

    // Ledger append-only.
    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% not allowed)', TG_OP;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()`);

    // Transações: estado terminal é imutável, colunas de identidade/valor nunca mudam, sem DELETE.
    this.addSql(`
      CREATE FUNCTION guard_wager_transaction_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transactions row % is in terminal status % and cannot be updated', OLD.id, OLD.status;
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
          OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
          OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
          OR NEW.player_id IS DISTINCT FROM OLD.player_id
          OR NEW.round_id IS DISTINCT FROM OLD.round_id
          OR NEW.game_id IS DISTINCT FROM OLD.game_id
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.amount IS DISTINCT FROM OLD.amount
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION 'wager_transactions identity and value columns are immutable';
        END IF;
        RETURN NEW;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard BEFORE UPDATE OR DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER wager_transactions_guard ON wager_transactions');
    this.addSql('DROP TRIGGER ledger_append_only ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION guard_wager_transaction_update()');
    this.addSql('DROP FUNCTION forbid_ledger_mutation()');
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
    this.addSql('DROP TABLE wallet_ledger_entries');
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP TABLE wallets');
  }
}
