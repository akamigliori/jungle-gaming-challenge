import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../src/application/wager/process-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';

let orm: MikroORM;
let t: TestApp;
const sql = (query: string) => orm.em.getConnection().execute(query);

async function seedHistory(currency = 'BRL', amount = '100.00') {
  const playerId = crypto.randomUUID();
  const wallet = await t.app.get(CreateWalletUseCase).execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: 'journal-upgrade',
  });
  const result = await t.app.get(ProcessWagerTransactionUseCase).execute({
    providerId: `provider-${currency}`,
    externalTransactionId: `bet-${wallet.id}`,
    idempotencyKey: `bet-${wallet.id}`,
    playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.01', currency },
    correlationId: 'journal-upgrade',
  });
  expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
  return wallet.id;
}

const financialState = () =>
  Promise.all([
    sql('SELECT * FROM wallets ORDER BY id'),
    sql('SELECT * FROM wager_transactions ORDER BY id'),
    sql('SELECT * FROM wallet_ledger_entries ORDER BY id'),
  ]);

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb(orm);
});
afterEach(async () => {
  // Mesmo em falha, restaura o schema para as demais suítes; apenas o banco local de testes.
  await orm.getMigrator().up();
  await assertLedgerInvariant(orm);
});
afterAll(async () => {
  await t.close();
  await orm.close(true);
});

describe('journal history upgrade', () => {
  test('the current application produces both directions and a consistent ledger', async () => {
    await seedHistory();
    const rows = await sql('SELECT direction FROM journal_entries ORDER BY direction');
    expect(rows).toEqual([{ direction: 'CREDIT' }, { direction: 'DEBIT' }]);
    const state = await financialState();
    expect(state.map((rows) => rows.length)).toEqual([1, 2, 2]);
  });
});
