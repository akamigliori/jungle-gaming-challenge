import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../src/application/wager/process-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/wallet/reconcile-wallet.use-case';
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

  test('upgrading a populated pre-journal database backfills every counterpart without financial mutations', async () => {
    const walletId = await seedHistory();
    const before = await financialState();
    const migrator = orm.getMigrator();
    await migrator.down({ to: 'Migration20261025000000_double_entry_journal' });
    expect(await sql("SELECT to_regclass('public.journal_entries') AS journal")).toEqual([
      { journal: null },
    ]);
    await migrator.up();

    const pairs = await sql(`
      SELECT l.direction AS wallet_direction, j.direction AS house_direction,
             j.amount::TEXT AS amount, j.currency, j.account_id,
             j.created_at = l.created_at AS preserves_time
        FROM wallet_ledger_entries l
        JOIN wager_transactions t ON t.id = l.transaction_id
        JOIN journal_entries j ON j.transaction_id = l.transaction_id
       ORDER BY l.wallet_version`);
    expect(pairs).toEqual([
      {
        wallet_direction: 'CREDIT',
        house_direction: 'DEBIT',
        amount: '100.00',
        currency: 'BRL',
        account_id: 'house:internal:BRL',
        preserves_time: true,
      },
      {
        wallet_direction: 'DEBIT',
        house_direction: 'CREDIT',
        amount: '25.01',
        currency: 'BRL',
        account_id: 'house:provider-BRL:BRL',
        preserves_time: true,
      },
    ]);
    expect(await financialState()).toEqual(before);
    expect((await t.app.get(ReconcileWalletUseCase).execute(walletId)).consistent).toBe(true);
  });

  test('an already applied journal migration is repaired without replacing entries or losing precision', async () => {
    const legacyWallet = await seedHistory('USD', '999999999999999999.99');
    const migrator = orm.getMigrator();
    await migrator.down({ to: 'Migration20261025000000_double_entry_journal' });
    await migrator.up({ to: 'Migration20261028000000_pending_reference_claim_token' });
    expect(await sql('SELECT id FROM journal_entries')).toEqual([]);

    const currentWallet = await seedHistory();
    const existing = await sql('SELECT * FROM journal_entries ORDER BY id');
    const before = await financialState();
    await migrator.up();

    expect(await sql(`SELECT * FROM journal_entries WHERE currency = 'BRL' ORDER BY id`)).toEqual(
      existing,
    );
    expect(await financialState()).toEqual(before);
    expect(
      await sql(`
      SELECT currency, SUM(signed_amount)::TEXT AS net FROM (
        SELECT currency, CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END AS signed_amount
          FROM wallet_ledger_entries
        UNION ALL
        SELECT currency, CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END
          FROM journal_entries
      ) entries GROUP BY currency ORDER BY currency`),
    ).toEqual([
      { currency: 'BRL', net: '0.00' },
      { currency: 'USD', net: '0.00' },
    ]);
    for (const walletId of [legacyWallet, currentWallet]) {
      expect((await t.app.get(ReconcileWalletUseCase).execute(walletId)).consistent).toBe(true);
    }

    const journal = await sql('SELECT * FROM journal_entries ORDER BY id');
    expect(journal).toHaveLength(4);
    await migrator.down({ migrations: ['Migration20261029000000_journal_history_backfill'] });
    expect(await sql('SELECT * FROM journal_entries ORDER BY id')).toEqual(journal);
    await migrator.up();
    expect(await sql('SELECT * FROM journal_entries ORDER BY id')).toEqual(journal);
  });
});
