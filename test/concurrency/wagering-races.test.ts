import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestApp, type TestApp } from '../integration/support/app';
import { resetDb, withTestDb } from '../integration/support/db';
import { assertLedgerInvariant } from '../integration/support/invariants';

/**
 * Disputas reais: as requisições saem juntas (`Promise.all` de `fetch`) contra a aplicação
 * real, com Postgres real. Nenhum mock, nenhum retry no teste.
 */

const PROVIDER_ID = 'provider-a';

interface SubmitBody {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

interface SubmitResponse {
  status: number;
  replayHeader: string | null;
  body: SubmitBody;
}

interface Wager {
  walletId: string;
  playerId: string;
  externalTransactionId: string;
  kind?: string;
  amount: string;
  referenceExternalTransactionId?: string;
  /** Padrão: `provider-a:{externalTransactionId}`. */
  idempotencyKey?: string;
}

interface TestWallet {
  id: string;
  playerId: string;
}

let orm: MikroORM;
let t: TestApp;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

async function createWallet(amount: string): Promise<TestWallet> {
  const playerId = Bun.randomUUIDv7();
  const res = await fetch(`${t.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return { id, playerId };
}

async function submit(w: Wager): Promise<SubmitResponse> {
  const res = await fetch(`${t.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': w.idempotencyKey ?? `${PROVIDER_ID}:${w.externalTransactionId}`,
    },
    body: JSON.stringify({
      providerId: PROVIDER_ID,
      externalTransactionId: w.externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: w.kind ?? 'BET',
      money: { amount: w.amount, currency: 'BRL' },
      ...(w.referenceExternalTransactionId
        ? { referenceExternalTransactionId: w.referenceExternalTransactionId }
        : {}),
    }),
  });
  return {
    status: res.status,
    replayHeader: res.headers.get('idempotent-replayed'),
    body: (await res.json()) as SubmitBody,
  };
}

/** Dispara todas as requisições ao mesmo tempo e espera todas. */
const inParallel = (wagers: Wager[]) => Promise.all(wagers.map(submit));

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [
    walletId,
  ]);
  return row?.balance ?? 'missing';
}

async function ledgerCount(walletId: string, direction: 'CREDIT' | 'DEBIT'): Promise<number> {
  const [row] = await sql<{ n: number }>(
    'SELECT COUNT(*)::INT AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = ?',
    [walletId, direction],
  );
  return row?.n ?? 0;
}

const statusesOf = (responses: SubmitResponse[]) => responses.map((r) => r.status).sort();

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
  await orm.close();
});

beforeEach(async () => {
  await resetDb(orm);
});

afterEach(async () => {
  await assertLedgerInvariant(orm);
});

describe('balance race (same wallet)', () => {
  test('100.00 with 2×80.00 at the same time, 10 rounds → one 201, one 422 INSUFFICIENT_FUNDS, balance 20.00, one DEBIT', async () => {
    const ROUNDS = 10;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const wallet = await createWallet('100.00');
      const bet = (externalTransactionId: string): Wager => ({
        walletId: wallet.id,
        playerId: wallet.playerId,
        externalTransactionId,
        amount: '80.00',
      });

      const responses = await inParallel([bet(`bet-${round}-a`), bet(`bet-${round}-b`)]);

      expect(statusesOf(responses)).toEqual([201, 422]);
      const rejected = responses.find((r) => r.status === 422);
      expect(rejected?.body.status).toBe('REJECTED');
      expect(rejected?.body.error?.code).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(wallet.id)).toBe('20.00');
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    }
  });
});

describe('idempotency under concurrency', () => {
  test('same BET 50× in parallel (same key and payload) → all 201, 49 replays, one row, one DEBIT, balance 75.00', async () => {
    const COPIES = 50;
    const wallet = await createWallet('100.00');
    const bet: Wager = {
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: 'bet-1',
      amount: '25.00',
    };

    const responses = await inParallel(Array.from({ length: COPIES }, () => bet));

    expect(responses.every((r) => r.status === 201)).toBe(true);
    const replays = responses.filter((r) => r.body.idempotentReplay);
    expect(replays).toHaveLength(COPIES - 1);
    expect(replays.every((r) => r.replayHeader === 'true')).toBe(true);
    // todas devolvem a mesma transação e o saldo da execução original
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.body.balance?.amount === '75.00')).toBe(true);

    const [rows] = await sql<{ n: number }>(
      'SELECT COUNT(*)::INT AS n FROM wager_transactions WHERE provider_id = ?',
      [PROVIDER_ID],
    );
    expect(rows?.n).toBe(1);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  test('same key on 2 different wallets in parallel → one 201, the other 409 IDEMPOTENCY_CONFLICT, no 5xx', async () => {
    const first = await createWallet('100.00');
    const second = await createWallet('100.00');
    const bet = (wallet: TestWallet): Wager => ({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: 'bet-1',
      amount: '25.00',
      idempotencyKey: 'shared-key',
    });

    const responses = await inParallel([bet(first), bet(second)]);

    expect(statusesOf(responses)).toEqual([201, 409]);
    const conflict = responses.find((r) => r.status === 409);
    expect(conflict?.body.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    const balances = [await balanceOf(first.id), await balanceOf(second.id)].sort();
    expect(balances).toEqual(['100.00', '75.00']);
  });

  test('REFUND and ROLLBACK of the same BET in parallel → one 201, one 422 ALREADY_REVERSED, a single CREDIT back', async () => {
    const wallet = await createWallet('100.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId, amount: '25.00' };
    const placed = await submit({ ...base, externalTransactionId: 'bet-1' });
    expect(placed.status).toBe(201);

    const responses = await inParallel([
      {
        ...base,
        externalTransactionId: 'refund-1',
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-1',
      },
      {
        ...base,
        externalTransactionId: 'rollback-1',
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'bet-1',
      },
    ]);

    expect(statusesOf(responses)).toEqual([201, 422]);
    expect(responses.find((r) => r.status === 422)?.body.error?.code).toBe('ALREADY_REVERSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
    // 1 crédito de abertura + 1 crédito da reversão
    expect(await ledgerCount(wallet.id, 'CREDIT')).toBe(2);
  });
});

describe('distinct wallets in parallel', () => {
  test('10 wallets × 20 BETs of 7.00 at the same time → per wallet 14 processed, 6 INSUFFICIENT_FUNDS, balance 2.00', async () => {
    const WALLETS = 10;
    const BETS_PER_WALLET = 20;
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => createWallet('100.00')),
    );
    const wagers = wallets.flatMap((wallet, w) =>
      Array.from(
        { length: BETS_PER_WALLET },
        (_, b): Wager => ({
          walletId: wallet.id,
          playerId: wallet.playerId,
          externalTransactionId: `bet-${w}-${b}`,
          amount: '7.00',
        }),
      ),
    );

    const responses = await inParallel(wagers);

    // 100.00 / 7.00 = 14 apostas cabem (98.00); as 6 restantes não têm saldo
    for (const wallet of wallets) {
      const own = responses.filter((_, i) => wagers[i]?.walletId === wallet.id);
      expect(own.filter((r) => r.status === 201)).toHaveLength(14);
      const rejected = own.filter((r) => r.status === 422);
      expect(rejected).toHaveLength(6);
      expect(rejected.every((r) => r.body.error?.code === 'INSUFFICIENT_FUNDS')).toBe(true);
      expect(await balanceOf(wallet.id)).toBe('2.00');
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(14);
    }
  });
});
