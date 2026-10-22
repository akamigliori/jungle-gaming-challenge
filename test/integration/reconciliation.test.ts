import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { LogCapture } from './support/log-capture';
import { seriesDelta } from './support/metrics';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const DIVERGENCES = 'wagering_reconciliation_divergences_total';
const RESULT_CONSISTENT = 'wagering_reconciliations_total{result="consistent"}';
const RESULT_DIVERGENT = 'wagering_reconciliations_total{result="divergent"}';

interface Report {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  ledgerBalance: { amount: string; currency: string } | null;
  difference: { amount: string; currency: string };
  version: number;
  ledgerVersion: number | null;
  checkedEntries: number;
  consistent: boolean;
  issues: string[];
  checkedAt: string;
}

let orm: MikroORM;
let t: TestApp;
let logs: LogCapture;

async function createWallet(amount = '100.00'): Promise<string> {
  const res = await fetch(`${t.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: PLAYER_ID, initialBalance: { amount, currency: 'BRL' } }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function wager(
  walletId: string,
  kind: string,
  external: string,
  amount: string,
  ref?: string,
) {
  const res = await fetch(`${t.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `provider-a:${external}`,
    },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: external,
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
      ...(ref && { referenceExternalTransactionId: ref }),
    }),
  });
  expect(res.ok).toBe(true);
}

const reconcile = (walletId: string) =>
  fetch(`${t.baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

beforeAll(async () => {
  orm = await withTestDb();
  logs = new LogCapture();
  t = await createTestApp({ LOG_LEVEL: 'info' }, undefined, logs);
});

afterAll(async () => {
  await t.close();
  await orm.close();
});

beforeEach(async () => {
  await resetDb(orm);
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('a wallet after BET, WIN and REFUND is consistent with zero difference', async () => {
    const walletId = await createWallet();
    await wager(walletId, 'BET', 'bet-1', '25.00');
    await wager(walletId, 'WIN', 'win-1', '40.00');
    await wager(walletId, 'BET', 'bet-2', '5.00');
    await wager(walletId, 'REFUND', 'refund-1', '5.00', 'bet-2');

    const delta = await seriesDelta(t.baseUrl, RESULT_CONSISTENT, async () => {
      const res = await reconcile(walletId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Report;
      expect(body).toEqual({
        walletId,
        storedBalance: { amount: '115.00', currency: 'BRL' },
        calculatedBalance: { amount: '115.00', currency: 'BRL' },
        ledgerBalance: { amount: '115.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        version: 5,
        ledgerVersion: 5,
        checkedEntries: 5,
        consistent: true,
        issues: [],
        checkedAt: expect.any(String),
      });
    });
    expect(delta).toBe(1);
  });

  test('a wallet opened with zero balance and no entries is consistent', async () => {
    const walletId = await createWallet('0.00');
    const body = (await (await reconcile(walletId)).json()) as Report;
    expect(body).toMatchObject({ consistent: true, checkedEntries: 0, version: 1 });
  });

  test('a diverging balance is flagged, logged without amounts, counted and never corrected', async () => {
    const walletId = await createWallet();
    await wager(walletId, 'BET', 'bet-1', '25.00');
    // fabrica a divergência: o saldo gravado deixa de bater com o ledger
    await sql(`UPDATE wallets SET balance = '77.77' WHERE id = ?`, [walletId]);
    const logsBefore = logs.lines().length;

    let body: Report | undefined;
    const divergences = await seriesDelta(t.baseUrl, DIVERGENCES, async () => {
      const res = await reconcile(walletId);
      expect(res.status).toBe(200);
      body = (await res.json()) as Report;
    });

    expect(body).toMatchObject({
      consistent: false,
      storedBalance: { amount: '77.77', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '2.77', currency: 'BRL' },
    });
    expect(body?.issues).toEqual([
      'BALANCE_DIFFERS_FROM_LAST_ENTRY',
      'BALANCE_DIFFERS_FROM_LEDGER_SUM',
    ]);
    expect(divergences).toBe(1);

    const warns = logs
      .lines()
      .slice(logsBefore)
      .filter((l) => l.level === 40 && l.walletId === walletId);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.issues).toEqual(body?.issues);
    const newText = logs
      .lines()
      .slice(logsBefore)
      .map((l) => JSON.stringify(l))
      .join('\n');
    for (const amount of ['77.77', '75.00', '2.77']) expect(newText).not.toContain(amount);

    const [row] = await sql<{ balance: string; version: number }>(
      'SELECT balance, version FROM wallets WHERE id = ?',
      [walletId],
    );
    expect(row).toMatchObject({ balance: '77.77', version: 2 });
    const divergent = await seriesDelta(t.baseUrl, RESULT_DIVERGENT, () => reconcile(walletId));
    expect(divergent).toBe(1);
  });

  test('a diverging version is flagged', async () => {
    const walletId = await createWallet();
    await sql('UPDATE wallets SET version = 9 WHERE id = ?', [walletId]);
    const body = (await (await reconcile(walletId)).json()) as Report;
    expect(body.consistent).toBe(false);
    expect(body.issues).toEqual(['VERSION_DIFFERS_FROM_LEDGER']);
  });

  test('a broken ledger chain and a version gap are flagged', async () => {
    const walletId = await createWallet();
    await wager(walletId, 'BET', 'bet-1', '25.00');
    await wager(walletId, 'BET', 'bet-2', '5.00');
    // o trigger append-only é desligado e religado na mesma transação: fora dela nunca fica aberto
    await orm.em.transactional(async (em) => {
      const conn = em.getConnection();
      await conn.execute('ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_append_only');
      // o último lançamento passa a partir de 60.00 (a aritmética continua válida) e pula uma versão
      await conn.execute(
        `UPDATE wallet_ledger_entries
         SET balance_before = 60.00, balance_after = 55.00, wallet_version = 7
         WHERE wallet_id = ? AND wallet_version = 3`,
        [walletId],
      );
      await conn.execute('ALTER TABLE wallet_ledger_entries ENABLE TRIGGER ledger_append_only');
    });

    const body = (await (await reconcile(walletId)).json()) as Report;
    expect(body.consistent).toBe(false);
    expect(body.issues).toEqual([
      'BALANCE_DIFFERS_FROM_LAST_ENTRY',
      'VERSION_DIFFERS_FROM_LEDGER',
      'LEDGER_CHAIN_BROKEN',
      'LEDGER_VERSION_GAP',
    ]);
  });

  test('an unknown wallet answers 404 WALLET_NOT_FOUND and counts nothing', async () => {
    const res = await reconcile('0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('WALLET_NOT_FOUND');
  });
});
