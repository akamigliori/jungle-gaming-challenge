import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { JournalRepository } from '../../src/application/ports/journal.repository';
import { JOURNAL_REPOSITORY } from '../../src/application/ports/journal.repository';
import type { LedgerRepository } from '../../src/application/ports/ledger.repository';
import { LEDGER_REPOSITORY } from '../../src/application/ports/ledger.repository';
import type { OutboxRepository } from '../../src/application/ports/outbox.repository';
import { OUTBOX_REPOSITORY } from '../../src/application/ports/outbox.repository';
import type { TransactionRunner } from '../../src/application/ports/transaction-runner';
import { TRANSACTION_RUNNER } from '../../src/application/ports/transaction-runner';
import type { WagerTransactionRepository } from '../../src/application/ports/wager-transaction.repository';
import { WAGER_TRANSACTION_REPOSITORY } from '../../src/application/ports/wager-transaction.repository';
import type { WalletRepository } from '../../src/application/ports/wallet.repository';
import { WALLET_REPOSITORY } from '../../src/application/ports/wallet.repository';
import { computePayloadHash } from '../../src/application/wager/payload-hash';
import { Money } from '../../src/domain/shared/money';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { JournalEntry } from '../../src/domain/wallet/journal-entry';
import { opposite } from '../../src/domain/wallet/ledger-direction';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const UNKNOWN_WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

interface WalletBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface LedgerBody {
  items: Array<{
    id: string;
    transactionId: string;
    direction: string;
    money: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    walletVersion: number;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

let orm: MikroORM;
let t: TestApp;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

async function counts(): Promise<Record<string, number>> {
  const [row] = await sql<Record<string, string>>(`
    SELECT (SELECT COUNT(*) FROM wallets) AS wallets,
           (SELECT COUNT(*) FROM wager_transactions) AS transactions,
           (SELECT COUNT(*) FROM wallet_ledger_entries) AS ledger,
           (SELECT COUNT(*) FROM outbox_messages) AS outbox`);
  return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
}

async function request<T>(
  app: TestApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const post = <T = WalletBody>(path: string, body: unknown, headers?: Record<string, string>) =>
  request<T>(t, 'POST', path, body, headers);
const get = <T = WalletBody>(path: string) => request<T>(t, 'GET', path);

const walletBody = (amount = '1000.00', currency = 'BRL', playerId = PLAYER_ID) => ({
  playerId,
  initialBalance: { amount, currency },
});

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

describe('POST /wallets', () => {
  test('1000.00 → 201 version 1; wallet + OPENING PROCESSED + CREDIT ledger + 2 outbox rows', async () => {
    const res = await post('/wallets', walletBody(), { 'x-correlation-id': 'create-wallet-1' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      playerId: PLAYER_ID,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = res.body.id;

    const [wallet] = await sql('SELECT * FROM wallets WHERE id = ?', [walletId]);
    expect(wallet).toMatchObject({
      player_id: PLAYER_ID,
      currency: 'BRL',
      balance: '1000.00',
      version: 1,
    });

    const txs = await sql('SELECT * FROM wager_transactions');
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      provider_id: 'internal',
      external_transaction_id: walletId,
      idempotency_key: `opening:${walletId}`,
      wallet_id: walletId,
      player_id: PLAYER_ID,
      round_id: 'opening',
      game_id: 'internal',
      kind: 'OPENING',
      amount: '1000.00',
      currency: 'BRL',
      status: 'PROCESSED',
      balance_after: '1000.00',
      wallet_version_after: 1,
    });
    // o hash gravado corresponde exatamente aos campos gravados da própria transação
    const row = txs[0] as Record<
      | 'payload_hash'
      | 'provider_id'
      | 'external_transaction_id'
      | 'player_id'
      | 'wallet_id'
      | 'round_id'
      | 'game_id'
      | 'kind'
      | 'amount'
      | 'currency',
      string
    >;
    expect(row.payload_hash).toBe(
      computePayloadHash({
        providerId: row.provider_id,
        externalTransactionId: row.external_transaction_id,
        playerId: row.player_id,
        walletId: row.wallet_id,
        roundId: row.round_id,
        gameId: row.game_id,
        kind: row.kind as WagerTransactionKind,
        money: { amount: row.amount, currency: row.currency },
      }),
    );
    expect(txs[0]?.processed_at).not.toBeNull();

    const ledger = await sql('SELECT * FROM wallet_ledger_entries');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      wallet_id: walletId,
      transaction_id: txs[0]?.id,
      direction: 'CREDIT',
      amount: '1000.00',
      currency: 'BRL',
      balance_before: '0.00',
      balance_after: '1000.00',
      wallet_version: 1,
    });
    // partida dobrada: a abertura credita a wallet e debita a conta da casa
    const journal = await sql('SELECT * FROM journal_entries');
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      transaction_id: txs[0]?.id,
      account_id: 'house:internal:BRL',
      direction: 'DEBIT',
      amount: '1000.00',
      currency: 'BRL',
    });

    const outbox = await sql<{ event_type: string; aggregate_id: string; payload: unknown }>(
      'SELECT event_type, aggregate_id, payload FROM outbox_messages ORDER BY event_type',
    );
    expect(outbox.map((o) => o.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const message of outbox) {
      expect(message.aggregate_id).toBe(walletId);
      expect(message.payload).toMatchObject({ correlationId: 'create-wallet-1', version: 1 });
    }
    expect(outbox[0]?.payload).toMatchObject({
      data: { kind: 'OPENING', balanceAfter: { amount: '1000.00', currency: 'BRL' } },
    });
    expect(outbox[1]?.payload).toMatchObject({
      data: {
        direction: 'CREDIT',
        walletVersion: 1,
        money: { amount: '1000.00', currency: 'BRL' },
      },
    });
  });

  test('0.00 → 201 version 1; no OPENING, no ledger, no outbox', async () => {
    const res = await post('/wallets', walletBody('0.00'));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
    expect(await counts()).toEqual({ wallets: 1, transactions: 0, ledger: 0, outbox: 0 });
  });

  test('normalizes amount without decimals ("10" → "10.00")', async () => {
    const res = await post('/wallets', walletBody('10'));

    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('duplicate player+currency → 409 WALLET_ALREADY_EXISTS; DB unchanged', async () => {
    expect((await post('/wallets', walletBody())).status).toBe(201);
    const before = await counts();

    const res = await post<ErrorBody>('/wallets', walletBody('50.00'));

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'WALLET_ALREADY_EXISTS',
      message: expect.any(String),
      retryable: false,
    });
    expect(await counts()).toEqual(before);
  });

  test('10 parallel POST /wallets same player → exactly one 201, nine 409, one wallet row', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post<WalletBody | ErrorBody>('/wallets', walletBody())),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const conflicts = results.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(9);
    for (const r of conflicts)
      expect((r.body as ErrorBody).error.code).toBe('WALLET_ALREADY_EXISTS');
    expect(await counts()).toEqual({ wallets: 1, transactions: 1, ledger: 1, outbox: 2 });
  });

  test('same player in USD and BRL → both 201', async () => {
    const brl = await post('/wallets', walletBody('10.00', 'BRL'));
    const usd = await post('/wallets', walletBody('10.00', 'USD'));

    expect(brl.status).toBe(201);
    expect(usd.status).toBe(201);
    expect(brl.body.id).not.toBe(usd.body.id);
    expect(usd.body.balance).toEqual({ amount: '10.00', currency: 'USD' });
  });

  test.each([['abc'], ['-1.00'], ['10.005'], ['1000000000000000000.00']])(
    'initialBalance %p → 400 INVALID_MONEY',
    async (amount) => {
      const res = await post<ErrorBody>('/wallets', walletBody(amount));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_MONEY');
      expect(await counts()).toEqual({ wallets: 0, transactions: 0, ledger: 0, outbox: 0 });
    },
  );

  test('currency not 3 uppercase letters → 400 INVALID_MONEY', async () => {
    const res = await post<ErrorBody>('/wallets', walletBody('10.00', 'brl'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MONEY');
  });

  test('malformed JSON body → 400 { error: { code: "INVALID_PAYLOAD", message, retryable: false } }', async () => {
    const res = await post<ErrorBody>('/wallets', '{"playerId": ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'INVALID_PAYLOAD', message: expect.any(String), retryable: false },
    });
  });

  test('body above the size limit → 413 INVALID_PAYLOAD', async () => {
    const res = await post<ErrorBody>('/wallets', { playerId: 'x'.repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'INVALID_PAYLOAD', retryable: false });
  });

  test.each([
    ['playerId not uuid', { playerId: 'abc', initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['missing initialBalance', { playerId: PLAYER_ID }],
    ['numeric amount', { playerId: PLAYER_ID, initialBalance: { amount: 10, currency: 'BRL' } }],
  ])('%s → 400 INVALID_PAYLOAD', async (_, body) => {
    const res = await post<ErrorBody>('/wallets', body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('POST /wallets atomicity', () => {
  test('when the outbox insert fails, no wallet/tx/ledger row remains', async () => {
    const failingOutbox: Pick<OutboxRepository, 'enqueueMany'> = {
      enqueueMany: () => Promise.reject(new Error('outbox unavailable')),
    };
    const broken = await createTestApp({}, (builder) =>
      builder.overrideProvider(OUTBOX_REPOSITORY).useValue(failingOutbox),
    );
    try {
      const res = await request<ErrorBody>(broken, 'POST', '/wallets', walletBody());

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(await counts()).toEqual({ wallets: 0, transactions: 0, ledger: 0, outbox: 0 });
    } finally {
      await broken.close();
    }
  });
});

describe('GET /wallets/:walletId', () => {
  test('existing → 200 same format; unknown uuid → 404 WALLET_NOT_FOUND; "abc" → 400', async () => {
    const created = await post('/wallets', walletBody('25.50'));

    const found = await get(`/wallets/${created.body.id}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual(created.body);

    const missing = await get<ErrorBody>(`/wallets/${UNKNOWN_WALLET_ID}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');

    const invalid = await get<ErrorBody>('/wallets/abc');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  /**
   * Lança créditos extras (WIN) direto pelos repositórios, numa transação, simulando o
   * processamento: trava a wallet, grava transações e ledger e salva o novo saldo.
   */
  async function appendWins(walletId: string, amounts: string[]): Promise<void> {
    const runner = t.app.get<TransactionRunner>(TRANSACTION_RUNNER);
    const wallets = t.app.get<WalletRepository>(WALLET_REPOSITORY);
    const transactions = t.app.get<WagerTransactionRepository>(WAGER_TRANSACTION_REPOSITORY);
    const ledger = t.app.get<LedgerRepository>(LEDGER_REPOSITORY);
    const journal = t.app.get<JournalRepository>(JOURNAL_REPOSITORY);

    await runner.run(async () => {
      const wallet = await wallets.lockById(walletId);
      if (!wallet) throw new Error('wallet not found');
      const expectedVersion = wallet.version;
      for (const [i, amount] of amounts.entries()) {
        const at = new Date();
        const money = Money.from({ amount, currency: wallet.currency });
        const tx = WagerTransaction.create({
          id: Bun.randomUUIDv7(),
          providerId: 'provider-a',
          externalTransactionId: `win-${i}`,
          idempotencyKey: `provider-a:win-${i}`,
          payloadHash: 'a'.repeat(64),
          walletId,
          playerId: wallet.playerId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Win,
          money,
          createdAt: at,
        });
        const entry = wallet.credit({
          money,
          transactionId: tx.id,
          entryId: Bun.randomUUIDv7(),
          at,
        });
        tx.markProcessed({ at, balanceAfter: wallet.balance, walletVersionAfter: wallet.version });
        await transactions.add(tx);
        await ledger.append(entry);
        await journal.append(
          JournalEntry.create({
            id: Bun.randomUUIDv7(),
            transactionId: tx.id,
            accountId: JournalEntry.accountId(tx.providerId, entry.money.currency),
            direction: opposite(entry.direction),
            money: entry.money,
            createdAt: at,
          }),
        );
      }
      await wallets.save(wallet, expectedVersion);
    });
  }

  test('5 entries, limit 2 → pages [1,2],[3,4],[5] ordered by walletVersion, nextCursor null at end', async () => {
    const created = await post('/wallets', walletBody('100.00'));
    const walletId = created.body.id;
    await appendWins(walletId, ['1.00', '2.00', '3.00', '4.00']);

    const pages: number[][] = [];
    let cursor: string | null = null;
    let first: LedgerBody | undefined;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res: { status: number; body: LedgerBody } = await get<LedgerBody>(
        `/wallets/${walletId}/ledger${query}`,
      );
      expect(res.status).toBe(200);
      first ??= res.body;
      pages.push(res.body.items.map((i) => i.walletVersion));
      cursor = res.body.nextCursor;
    } while (cursor !== null && pages.length < 10);

    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    expect(first?.items[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'CREDIT',
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    expect(first?.items[1]?.balanceAfter).toEqual({ amount: '101.00', currency: 'BRL' });
  });

  test('default limit returns all entries of a small ledger with nextCursor null', async () => {
    const created = await post('/wallets', walletBody('100.00'));

    const res = await get<LedgerBody>(`/wallets/${created.body.id}/ledger`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
  });

  test('wallet without entries → empty page', async () => {
    const created = await post('/wallets', walletBody('0.00'));

    const res = await get<LedgerBody>(`/wallets/${created.body.id}/ledger`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test('unknown wallet → 404 WALLET_NOT_FOUND', async () => {
    const res = await get<ErrorBody>(`/wallets/${UNKNOWN_WALLET_ID}/ledger`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test.each(['limit=0', 'limit=201', 'limit=1000', 'limit=abc', 'cursor=%25%25%25', 'cursor=LTE'])(
    'ledger ?%s → 400 INVALID_PAYLOAD',
    async (query) => {
      const created = await post('/wallets', walletBody('100.00'));

      const res = await get<ErrorBody>(`/wallets/${created.body.id}/ledger?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    },
  );

  test('walletId not uuid → 400 INVALID_PAYLOAD', async () => {
    const res = await get<ErrorBody>('/wallets/abc/ledger');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('reconciliation invariant', () => {
  test('wallet.balance equals the signed sum of its ledger entries after create', async () => {
    const created = await post('/wallets', walletBody('1234.56'));

    const [row] = await sql<{ balance: string; ledger_sum: string }>(
      `SELECT w.balance,
              COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::NUMERIC(20,2) AS ledger_sum
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ? GROUP BY w.balance`,
      [created.body.id],
    );
    expect(row?.balance).toBe('1234.56');
    expect(row?.ledger_sum).toBe(row?.balance);
  });
});
