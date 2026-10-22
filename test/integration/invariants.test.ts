import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';

let orm: MikroORM;
const run = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);

const WALLET_ID = '00000000-0000-7000-8000-0000000000a1';
const OPENING_TX_ID = '00000000-0000-7000-8000-0000000000b1';
const BET_TX_ID = '00000000-0000-7000-8000-0000000000b2';

async function insertTransaction(id: string, kind: string, amount: string): Promise<void> {
  await run(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, REPEAT('a', 64), ?, ?, 'r1', 'g1', ?, ?, 'BRL', 'PENDING', NOW(), NOW())`,
    [id, `ext-${id}`, `idem-${id}`, WALLET_ID, WALLET_ID, kind, amount],
  );
}

async function insertEntry(o: {
  id: string;
  txId: string;
  direction: string;
  amount: string;
  before: string;
  after: string;
  version: number;
}): Promise<void> {
  await run(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
        wallet_version, created_at)
     VALUES (?, ?, ?, ?, ?, 'BRL', ?, ?, ?, NOW())`,
    [o.id, WALLET_ID, o.txId, o.direction, o.amount, o.before, o.after, o.version],
  );
}

/** Wallet aberta com 100.00 e depois debitada em 10.00; `betBefore`/`betAfter` permitem quebrar a cadeia. */
async function seedWallet(betBefore: string, betAfter: string, openingBefore = '0.00') {
  await run(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', 90.00, 2, NOW(), NOW())`,
    [WALLET_ID, WALLET_ID],
  );
  await insertTransaction(OPENING_TX_ID, 'OPENING', '100.00');
  await insertTransaction(BET_TX_ID, 'BET', '10.00');
  await insertEntry({
    id: '00000000-0000-7000-8000-0000000000c1',
    txId: OPENING_TX_ID,
    direction: 'CREDIT',
    amount: '100.00',
    before: openingBefore,
    after: (Number(openingBefore) + 100).toFixed(2),
    version: 1,
  });
  await insertEntry({
    id: '00000000-0000-7000-8000-0000000000c2',
    txId: BET_TX_ID,
    direction: 'DEBIT',
    amount: '10.00',
    before: betBefore,
    after: betAfter,
    version: 2,
  });
}

beforeAll(async () => {
  orm = await withTestDb();
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDb(orm);
});

describe('assertLedgerInvariant', () => {
  test('cadeia de saldos íntegra passa', async () => {
    await seedWallet('100.00', '90.00');
    await assertLedgerInvariant(orm);
  });

  test('balance_before da v2 diferente do balance_after da v1 é divergência', async () => {
    await seedWallet('50.00', '40.00');
    await expect(assertLedgerInvariant(orm)).rejects.toThrow('ledger invariant violated');
  });

  test('primeira entrada com balance_before diferente de zero é divergência', async () => {
    await seedWallet('150.00', '140.00', '50.00');
    await expect(assertLedgerInvariant(orm)).rejects.toThrow('ledger invariant violated');
  });
});
