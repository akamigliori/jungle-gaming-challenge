import { Migration } from '@mikro-orm/migrations';

/**
 * Adiciona `wallet_version` à outbox: a ordem estrita dos `WalletBalanceChanged` por wallet. A
 * coluna só é preenchida nesses eventos (eventos de transação ficam `NULL` e seguem melhor-esforço).
 * O índice parcial serve ao filtro de "cabeça" do `claimDue` (a menor versão não publicada de cada
 * wallet é a única elegível).
 */
export class Migration20261024000000_outbox_wallet_version extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN wallet_version INT NULL`);
    this.addSql(
      `ALTER TABLE outbox_messages ADD CONSTRAINT outbox_wallet_version_ck CHECK (wallet_version >= 1)`,
    );
    this.addSql(
      `CREATE INDEX outbox_balance_unpublished_idx ON outbox_messages (aggregate_id, wallet_version)
       WHERE wallet_version IS NOT NULL AND published_at IS NULL`,
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX outbox_balance_unpublished_idx');
    this.addSql('ALTER TABLE outbox_messages DROP CONSTRAINT outbox_wallet_version_ck');
    this.addSql('ALTER TABLE outbox_messages DROP COLUMN wallet_version');
  }
}
