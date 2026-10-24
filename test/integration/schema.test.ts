import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { resetDb, withTestDb } from './support/db';

// Esta suíte grava linhas soltas direto em SQL para provocar cada violação de constraint; elas não
// representam estados produzidos pela aplicação, então o invariante do ledger não é verificado aqui.
let orm: MikroORM;
const run = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);

/** Executa o SQL e devolve a mensagem de erro do banco (ou falha se não houve erro). */
async function failure(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await run(sql, params);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`expected SQL to fail: ${sql}`);
}

let seq = 0;
const uuid = () => `00000000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

async function insertWallet(
  o: { id?: string; playerId?: string; currency?: string; balance?: string } = {},
): Promise<string> {
  const id = o.id ?? uuid();
  await run(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, NOW(), NOW())`,
    [id, o.playerId ?? uuid(), o.currency ?? 'BRL', o.balance ?? '100.00'],
  );
  return id;
}

interface TxOpts {
  id?: string;
  walletId: string;
  provider?: string;
  external?: string;
  idem?: string;
  kind?: string;
  amount?: string;
  status?: string;
  failureCode?: string | null;
  processedAt?: string | null;
  refExternal?: string | null;
  refId?: string | null;
  /** Por padrão preenchidos só quando o status é PROCESSED. */
  balanceAfter?: string | null;
  walletVersionAfter?: number | null;
  referenceAttempts?: number;
}

async function insertTx(o: TxOpts): Promise<string> {
  const [sql, params] = txSql(o);
  await run(sql, params);
  return params[0] as string;
}

async function insertLedger(o: {
  walletId: string;
  txId: string;
  direction?: string;
  amount?: string;
  before?: string;
  after?: string;
  version?: number;
  currency?: string;
}): Promise<string> {
  const id = uuid();
  await run(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
        wallet_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      id,
      o.walletId,
      o.txId,
      o.direction ?? 'CREDIT',
      o.amount ?? '10.00',
      o.currency ?? 'BRL',
      o.before ?? '0.00',
      o.after ?? '10.00',
      o.version ?? 1,
    ],
  );
  return id;
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

describe('migration', () => {
  test('migration up/down/up is reversible', async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    const tables = await run(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
         AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
    );
    expect(tables).toHaveLength(0);
    await migrator.up();
    const again = await run(`SELECT COUNT(*)::INT AS n FROM wallets`);
    expect(again[0]?.n).toBe(0);
  });

  test('partial index for pending dependents exists and its migration goes down and up', async () => {
    const indexDef = async () => {
      const rows = await run(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'wager_tx_pending_dependents_idx'`,
      );
      return rows[0]?.indexdef as string | undefined;
    };
    const created = await indexDef();
    expect(created).toContain(
      '(wallet_id, provider_id, reference_external_transaction_id) WHERE (status = ',
    );
    expect(created).toContain('PENDING_REFERENCE');

    // alvo explícito: um `down()` sem argumento desfaria a migration mais nova, qualquer que fosse
    const migration = {
      migrations: ['Migration20261021000000_pending_reference_dependents_index'],
    };
    const migrator = orm.getMigrator();
    await migrator.down(migration);
    expect(await indexDef()).toBeUndefined();
    await migrator.up(migration);
    expect(await indexDef()).toBe(created);
  });
});

describe('wallets', () => {
  test('duplicate (player, currency) → wallets_player_currency_uq', async () => {
    const player = uuid();
    await insertWallet({ playerId: player });
    const msg = await failure(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', 0, 1, NOW(), NOW())`,
      [uuid(), player],
    );
    expect(msg).toContain('wallets_player_currency_uq');
  });

  test('balance -0.01 → wallets_balance_non_negative_ck', async () => {
    const msg = await failure(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', -0.01, 1, NOW(), NOW())`,
      [uuid(), uuid()],
    );
    expect(msg).toContain('wallets_balance_non_negative_ck');
  });

  test('currency "brl" → check violation', async () => {
    const msg = await failure(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'brl', 0, 1, NOW(), NOW())`,
      [uuid(), uuid()],
    );
    expect(msg).toContain('wallets_currency_format_ck');
  });
});

describe('wager_transactions', () => {
  test('duplicate (provider, external id) and (provider, idempotency key) rejected', async () => {
    const w = await insertWallet();
    await insertTx({ walletId: w, external: 'e1', idem: 'k1' });
    expect(await failure(...txSql({ walletId: w, external: 'e1', idem: 'k2' }))).toContain(
      'wager_tx_provider_external_uq',
    );
    expect(await failure(...txSql({ walletId: w, external: 'e2', idem: 'k1' }))).toContain(
      'wager_tx_provider_idem_uq',
    );
  });

  test('REFUND without reference_external_transaction_id → check; BET with one → check; WIN/LOSS ok', async () => {
    const w = await insertWallet();
    expect(await failure(...txSql({ walletId: w, kind: 'REFUND' }))).toContain(
      'wager_tx_reference_by_kind_ck',
    );
    expect(await failure(...txSql({ walletId: w, kind: 'ROLLBACK' }))).toContain(
      'wager_tx_reference_by_kind_ck',
    );
    expect(await failure(...txSql({ walletId: w, kind: 'BET', refExternal: 'x' }))).toContain(
      'wager_tx_reference_by_kind_ck',
    );
    await insertTx({ walletId: w, kind: 'WIN' });
    await insertTx({ walletId: w, kind: 'WIN', refExternal: 'x' });
    await insertTx({ walletId: w, kind: 'LOSS' });
    await insertTx({ walletId: w, kind: 'LOSS', refExternal: 'x' });
    await insertTx({ walletId: w, kind: 'REFUND', refExternal: 'x' });
  });

  test('amount 0 → check; PROCESSED without processed_at → check; REJECTED without failure_code → check', async () => {
    const w = await insertWallet();
    expect(await failure(...txSql({ walletId: w, amount: '0' }))).toContain(
      'wager_tx_amount_positive_ck',
    );
    expect(await failure(...txSql({ walletId: w, status: 'PROCESSED' }))).toContain(
      'wager_tx_processed_at_ck',
    );
    expect(await failure(...txSql({ walletId: w, status: 'REJECTED' }))).toContain(
      'wager_tx_failure_code_ck',
    );
    expect(await failure(...txSql({ walletId: w, status: 'FAILED' }))).toContain(
      'wager_tx_failure_code_ck',
    );
    // O Postgres avalia CHECKs em ordem alfabética: wager_tx_kind_ck vem antes de reference_by_kind.
    expect(await failure(...txSql({ walletId: w, kind: 'NOPE' }))).toContain('wager_tx_kind_ck');
  });

  test('second PROCESSED reversal of the same reference → wager_tx_single_reversal_uq', async () => {
    const w = await insertWallet();
    const bet = await insertTx({ walletId: w, status: 'PROCESSED', processedAt: '2026-01-01' });
    await insertTx({
      walletId: w,
      kind: 'REFUND',
      refExternal: 'x',
      refId: bet,
      status: 'PROCESSED',
      processedAt: '2026-01-01',
    });
    const msg = await failure(
      ...txSql({
        walletId: w,
        kind: 'ROLLBACK',
        refExternal: 'x',
        refId: bet,
        status: 'PROCESSED',
        processedAt: '2026-01-01',
      }),
    );
    expect(msg).toContain('wager_tx_single_reversal_uq');
  });

  test('PROCESSED REFUND/ROLLBACK without reference_transaction_id → wager_tx_reversal_resolved_ck', async () => {
    const w = await insertWallet();
    for (const kind of ['REFUND', 'ROLLBACK']) {
      const msg = await failure(
        ...txSql({
          walletId: w,
          kind,
          refExternal: 'x',
          status: 'PROCESSED',
          processedAt: '2026-01-01',
        }),
      );
      expect(msg).toContain('wager_tx_reversal_resolved_ck');
    }
    // fora de PROCESSED a referência interna ainda pode estar pendente
    await insertTx({ walletId: w, kind: 'REFUND', refExternal: 'x', status: 'PENDING_REFERENCE' });
  });

  test('single reversal index only counts PROCESSED reversals', async () => {
    const w = await insertWallet();
    const bet = await insertTx({ walletId: w, status: 'PROCESSED', processedAt: '2026-01-01' });
    const reversal = { walletId: w, kind: 'REFUND', refExternal: 'x', refId: bet };
    await insertTx({ ...reversal, status: 'PROCESSED', processedAt: '2026-01-01' });
    // PENDING_REFERENCE e REJECTED com a mesma referência são permitidos
    await insertTx({ ...reversal, kind: 'ROLLBACK', status: 'PENDING_REFERENCE' });
    await insertTx({
      ...reversal,
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
      processedAt: '2026-01-01',
    });
    const msg = await failure(
      ...txSql({ ...reversal, kind: 'ROLLBACK', status: 'PROCESSED', processedAt: '2026-01-01' }),
    );
    expect(msg).toContain('wager_tx_single_reversal_uq');
  });

  test('PROCESSED without balance/version snapshot → wager_tx_processed_snapshot_ck', async () => {
    const w = await insertWallet();
    const processed = { walletId: w, status: 'PROCESSED', processedAt: '2026-01-01' };
    expect(await failure(...txSql({ ...processed, balanceAfter: null }))).toContain(
      'wager_tx_processed_snapshot_ck',
    );
    expect(await failure(...txSql({ ...processed, walletVersionAfter: null }))).toContain(
      'wager_tx_processed_snapshot_ck',
    );
  });

  test('reference to itself → wager_tx_reference_not_self_ck', async () => {
    const w = await insertWallet();
    const id = uuid();
    expect(
      await failure(...txSql({ id, walletId: w, kind: 'REFUND', refExternal: 'x', refId: id })),
    ).toContain('wager_tx_reference_not_self_ck');
  });

  test('wallet_version_after 0 and negative reference_attempts → check', async () => {
    const w = await insertWallet();
    expect(await failure(...txSql({ walletId: w, walletVersionAfter: 0 }))).toContain(
      'wager_tx_wallet_version_after_ck',
    );
    expect(await failure(...txSql({ walletId: w, referenceAttempts: -1 }))).toContain(
      'wager_tx_reference_attempts_ck',
    );
  });

  test('UPDATE of a terminal row, UPDATE of amount on PENDING row, DELETE → trigger error', async () => {
    const w = await insertWallet();
    const done = await insertTx({ walletId: w, status: 'PROCESSED', processedAt: '2026-01-01' });
    expect(
      await failure(`UPDATE wager_transactions SET updated_at = NOW() WHERE id = ?`, [done]),
    ).toContain('terminal');
    const pending = await insertTx({ walletId: w });
    expect(
      await failure(`UPDATE wager_transactions SET amount = 99 WHERE id = ?`, [pending]),
    ).toContain('immutable');
    expect(await failure(`DELETE FROM wager_transactions WHERE id = ?`, [pending])).toContain(
      'cannot be deleted',
    );
    // transição legítima continua permitida
    await run(
      `UPDATE wager_transactions
         SET status = 'PROCESSED', processed_at = NOW(), balance_after = 90, wallet_version_after = 2
       WHERE id = ?`,
      [pending],
    );
  });
});

describe('wallet_ledger_entries', () => {
  async function seed() {
    const w = await insertWallet();
    const tx = await insertTx({ walletId: w, status: 'PROCESSED', processedAt: '2026-01-01' });
    return { w, tx };
  }

  test('UPDATE and DELETE → trigger error', async () => {
    const { w, tx } = await seed();
    const id = await insertLedger({ walletId: w, txId: tx });
    expect(
      await failure(`UPDATE wallet_ledger_entries SET amount = 1 WHERE id = ?`, [id]),
    ).toContain('append-only');
    expect(await failure(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [id])).toContain(
      'append-only',
    );
  });

  test('CREDIT 100 with before 0 after 90 → ledger_arithmetic_ck', async () => {
    const { w, tx } = await seed();
    const msg = await failure(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, 'CREDIT', 100, 'BRL', 0, 90, 1, NOW())`,
      [uuid(), w, tx],
    );
    expect(msg).toContain('ledger_arithmetic_ck');
    const debit = await failure(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, 'DEBIT', 10, 'BRL', 50, 50, 1, NOW())`,
      [uuid(), w, tx],
    );
    expect(debit).toContain('ledger_arithmetic_ck');
    await insertLedger({
      walletId: w,
      txId: tx,
      direction: 'DEBIT',
      amount: '10.00',
      before: '50.00',
      after: '40.00',
    });
  });

  test('two entries same (wallet, wallet_version) → ledger_wallet_version_uq', async () => {
    const { w, tx } = await seed();
    const tx2 = await insertTx({ walletId: w, status: 'PROCESSED', processedAt: '2026-01-01' });
    await insertLedger({ walletId: w, txId: tx, version: 2 });
    await expect(insertLedger({ walletId: w, txId: tx2, version: 2 })).rejects.toThrow(
      'ledger_wallet_version_uq',
    );
  });

  test('same (transaction, wallet) twice → ledger_tx_wallet_uq', async () => {
    const { w, tx } = await seed();
    await insertLedger({ walletId: w, txId: tx, version: 2 });
    await expect(insertLedger({ walletId: w, txId: tx, version: 3 })).rejects.toThrow(
      'ledger_tx_wallet_uq',
    );
  });

  test('currency different from wallet → FK violation (composite FK)', async () => {
    const { w, tx } = await seed();
    await expect(insertLedger({ walletId: w, txId: tx, currency: 'USD' })).rejects.toThrow(
      'ledger_wallet_currency_fk',
    );
  });

  test('ledger wallet_id different from the transaction wallet → trigger error', async () => {
    const { tx } = await seed();
    const other = await insertWallet();
    await expect(insertLedger({ walletId: other, txId: tx })).rejects.toThrow(
      'must match the referenced transaction',
    );
  });

  test('balance_after negative → check', async () => {
    const { w, tx } = await seed();
    await expect(
      insertLedger({
        walletId: w,
        txId: tx,
        direction: 'DEBIT',
        amount: '10.00',
        before: '5.00',
        after: '-5.00',
      }),
    ).rejects.toThrow('ledger_balance_after_ck');
  });

  test('wallet_version 0 → ledger_wallet_version_ck', async () => {
    const { w, tx } = await seed();
    await expect(insertLedger({ walletId: w, txId: tx, version: 0 })).rejects.toThrow(
      'ledger_wallet_version_ck',
    );
  });
});

describe('inbox/outbox', () => {
  test('inbox primary key is (consumer_name, message_id)', async () => {
    const ins = `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
                 VALUES ('c', 'm', REPEAT('a', 64), NOW())`;
    await run(ins);
    expect(await failure(ins)).toContain('inbox_messages_pkey');
  });

  test('outbox attempts negative → outbox_attempts_ck', async () => {
    const msg = await failure(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES (?, 'a', 'E', '{}', NOW(), -1, NOW())`,
      [uuid()],
    );
    expect(msg).toContain('outbox_attempts_ck');
  });

  test('outbox wallet_version zero → outbox_wallet_version_ck', async () => {
    const msg = await failure(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, wallet_version)
       VALUES (?, 'a', 'E', '{}', NOW(), 0, NOW(), 0)`,
      [uuid()],
    );
    expect(msg).toContain('outbox_wallet_version_ck');
  });
});

/** Monta o INSERT de wager_transactions para os casos que esperam falha. */
function txSql(o: TxOpts): [string, unknown[]] {
  const id = o.id ?? uuid();
  const processed = o.status === 'PROCESSED';
  return [
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, processed_at, balance_after,
        wallet_version_after, reference_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, REPEAT('a', 64), ?, ?, 'r1', 'g1', ?, ?, 'BRL', ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      id,
      o.provider ?? 'p1',
      o.external ?? `ext-${id}`,
      o.idem ?? `idem-${id}`,
      o.walletId,
      uuid(),
      o.kind ?? 'BET',
      o.amount ?? '10.00',
      o.refExternal ?? null,
      o.refId ?? null,
      o.status ?? 'PENDING',
      o.failureCode ?? null,
      o.processedAt ?? null,
      o.balanceAfter !== undefined ? o.balanceAfter : processed ? '90.00' : null,
      o.walletVersionAfter !== undefined ? o.walletVersionAfter : processed ? 2 : null,
      o.referenceAttempts ?? 0,
    ],
  ];
}
