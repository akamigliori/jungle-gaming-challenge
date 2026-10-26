import { Migration } from '@mikro-orm/migrations';

/**
 * Trilha de auditoria das submissões que **não** viram resultado de negócio (payload inválido,
 * conflito de idempotência, wallet inexistente, moeda/jogador divergentes). Fica fora do estado
 * financeiro e **não ocupa a chave de idempotência**: o provedor pode corrigir e reenviar com a
 * mesma chave. As linhas são imutáveis (trigger bloqueia `UPDATE`); `DELETE` fica livre para a
 * retenção.
 */
export class Migration20261027000000_submission_failures extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_submission_failures (
        id UUID PRIMARY KEY,
        channel TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        wallet_id UUID NOT NULL,
        message_id TEXT NULL,
        payload_hash CHAR(64) NOT NULL,
        reason_code TEXT NOT NULL,
        category TEXT NOT NULL,
        retryable BOOLEAN NOT NULL,
        correlation_id TEXT NOT NULL,
        detail TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT submission_failures_channel_ck CHECK (channel IN ('HTTP','SQS')),
        CONSTRAINT submission_failures_category_ck CHECK (
          category IN ('VALIDATION','CONFLICT','UNPROCESSABLE','INFRASTRUCTURE')
        ),
        CONSTRAINT submission_failures_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$')
      )`);

    // o provedor consulta as recusas de uma transação, mais recentes primeiro
    this.addSql(`
      CREATE INDEX submission_failures_lookup_idx
        ON wager_submission_failures (provider_id, external_transaction_id, created_at DESC)`);
    // retenção por idade
    this.addSql(`
      CREATE INDEX submission_failures_created_idx ON wager_submission_failures (created_at)`);

    this.addSql(`
      CREATE FUNCTION forbid_submission_failure_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wager_submission_failures is append-only (% not allowed)', TG_OP;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER submission_failures_append_only BEFORE UPDATE ON wager_submission_failures
      FOR EACH ROW EXECUTE FUNCTION forbid_submission_failure_mutation()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER submission_failures_append_only ON wager_submission_failures');
    this.addSql('DROP FUNCTION forbid_submission_failure_mutation()');
    this.addSql('DROP TABLE wager_submission_failures');
  }
}
