import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { withTestDb } from './support/db';

let orm: MikroORM;

async function show(setting: string): Promise<string> {
  const rows = await orm.em.getConnection().execute(`SHOW ${setting}`);
  return String(Object.values(rows[0] as Record<string, string>)[0]);
}

beforeAll(async () => {
  orm = await withTestDb();
});
afterAll(async () => {
  await orm.close(true);
});

describe('Postgres session timeouts', () => {
  test('statement_timeout is 5 s', async () => {
    expect(await show('statement_timeout')).toBe('5s');
  });

  test('idle_in_transaction_session_timeout is 10 s', async () => {
    expect(await show('idle_in_transaction_session_timeout')).toBe('10s');
  });
});
