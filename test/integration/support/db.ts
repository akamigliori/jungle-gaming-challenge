import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/infrastructure/config/config';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

const TABLES = [
  'wallet_ledger_entries',
  'wager_transactions',
  'wallets',
  'inbox_messages',
  'outbox_messages',
  'wager_submission_failures',
];

/** Conecta ao banco de testes (wagering_test) e aplica as migrations pendentes. */
export async function withTestDb(): Promise<MikroORM> {
  const cfg = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'wagering_test' });
  const orm = await MikroORM.init(createOrmConfig(cfg));
  await orm.getMigrator().up();
  return orm;
}

/** Esvazia todas as tabelas. TRUNCATE não dispara os triggers de linha (append-only). */
export async function resetDb(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
