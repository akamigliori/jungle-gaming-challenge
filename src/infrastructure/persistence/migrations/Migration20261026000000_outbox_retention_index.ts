import { Migration } from '@mikro-orm/migrations';

/**
 * Retenção da outbox: índice parcial sobre `published_at` para que o worker de retenção apague os
 * eventos publicados antigos por ordem de publicação, sem varrer a tabela inteira a cada ciclo.
 */
export class Migration20261026000000_outbox_retention_index extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE INDEX outbox_published_idx ON outbox_messages (published_at)
      WHERE published_at IS NOT NULL`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX outbox_published_idx');
  }
}
