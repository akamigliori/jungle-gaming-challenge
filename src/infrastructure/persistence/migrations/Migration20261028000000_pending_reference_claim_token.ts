import { Migration } from '@mikro-orm/migrations';

/** Token de posse do lease; pendências anteriores voltam a ser reservadas após o prazo vigente. */
export class Migration20261028000000_pending_reference_claim_token extends Migration {
  override async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN reference_claim_token UUID NULL');
  }

  override async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN reference_claim_token');
  }
}
