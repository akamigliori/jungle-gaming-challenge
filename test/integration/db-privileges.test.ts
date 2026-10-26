import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/config';
import { grantAppPrivileges } from '../../src/infrastructure/persistence/grant-app-privileges';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { withTestDb } from './support/db';

const APP_USER = process.env.DB_APP_USER ?? 'wagering_app';
const APP_PASSWORD = process.env.DB_APP_PASSWORD ?? 'wagering_app';

let ownerOrm: MikroORM;
let appOrm: MikroORM;

beforeAll(async () => {
  ownerOrm = await withTestDb();
  // o dono cria o papel DML-only e aplica os grants no banco de teste
  await grantAppPrivileges(ownerOrm.em.getConnection());

  const cfg = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'wagering_test' });
  appOrm = await MikroORM.init(
    createOrmConfig({
      ...cfg,
      db: { ...cfg.db, user: APP_USER, password: APP_PASSWORD },
    }),
  );
});

afterAll(async () => {
  await appOrm.close();
  await ownerOrm.close();
});

const appDb = () => appOrm.em.getConnection();
const ownerDb = () => ownerOrm.em.getConnection();

describe('papel DML-only da aplicação', () => {
  test('faz SELECT e INSERT nas tabelas do domínio', async () => {
    const walletId = crypto.randomUUID();
    await appDb().execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', 0, 1, NOW(), NOW())`,
      [walletId, crypto.randomUUID()],
    );
    const [row] = await appDb().execute<{ balance: string }[]>(
      'SELECT balance FROM wallets WHERE id = ?',
      [walletId],
    );
    expect(row?.balance).toBe('0.00');
    await ownerDb().execute('DELETE FROM wallets WHERE id = ?', [walletId]);
  });

  test('não cria tabela (sem DDL)', async () => {
    await expect(appDb().execute('CREATE TABLE should_not_exist (id INT)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('não faz TRUNCATE', async () => {
    await expect(appDb().execute('TRUNCATE wallets')).rejects.toMatchObject({ code: '42501' });
  });

  test('apaga da outbox (retenção), mas não de outras tabelas', async () => {
    await expect(appDb().execute('DELETE FROM wallets')).rejects.toMatchObject({ code: '42501' });
    // DELETE permitido só na outbox: 0 linhas e sem erro
    await appDb().execute('DELETE FROM outbox_messages WHERE id = ?', [
      '00000000-0000-0000-0000-000000000000',
    ]);
  });
});
