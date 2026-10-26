import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const UNKNOWN_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

interface Money {
  amount: string;
  currency: string;
}

interface SubmitBody {
  transactionId: string;
  status: string;
  balance: Money | null;
  idempotentReplay: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

let orm: MikroORM;
let t: TestApp;

async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as never };
}

async function createWallet(amount = '100.00'): Promise<string> {
  const res = await send('POST', '/wallets', {
    playerId: PLAYER_ID,
    initialBalance: { amount, currency: 'BRL' },
  });
  return (res.body as { id: string }).id;
}

interface WagerOverrides {
  externalTransactionId?: string;
  kind?: string;
  amount?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
  walletId?: string;
  playerId?: string;
}

function wagerBody(walletId: string, o: WagerOverrides = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: o.externalTransactionId ?? 'bet-1',
    playerId: o.playerId ?? PLAYER_ID,
    walletId: o.walletId ?? walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: o.kind ?? 'BET',
    money: { amount: o.amount ?? '25.00', currency: o.currency ?? 'BRL' },
    ...(o.referenceExternalTransactionId
      ? { referenceExternalTransactionId: o.referenceExternalTransactionId }
      : {}),
  };
}

/** Submete com a chave padrão `provider:externalId`, salvo se `key` for informada. */
function submit(walletId: string, o: WagerOverrides = {}, key?: string) {
  const body = wagerBody(walletId, o);
  const headers = { 'idempotency-key': key ?? `provider-a:${body.externalTransactionId}` };
  return send('POST', '/wagering/transactions', body, headers) as Promise<{
    status: number;
    headers: Headers;
    body: SubmitBody;
  }>;
}

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

describe('POST /wagering/transactions', () => {
  test('BET 25.00 → 201 PROCESSED with balance 75.00, no replay header', async () => {
    const walletId = await createWallet();

    const res = await submit(walletId);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(res.headers.get('idempotent-replayed')).toBeNull();
  });

  test('missing, blank or too long Idempotency-Key → 400 INVALID_PAYLOAD', async () => {
    const walletId = await createWallet();
    const body = wagerBody(walletId);

    const badHeaders: Array<Record<string, string>> = [
      {},
      { 'idempotency-key': '   ' },
      { 'idempotency-key': 'k'.repeat(256) },
    ];
    for (const headers of badHeaders) {
      const res = await send('POST', '/wagering/transactions', body, headers);
      expect(res.status).toBe(400);
      expect((res.body as SubmitBody).error?.code).toBe('INVALID_PAYLOAD');
    }
  });

  test('invalid body (numeric amount, unknown key, bad kind) → 400 INVALID_PAYLOAD', async () => {
    const walletId = await createWallet();
    const headers = { 'idempotency-key': 'k-1' };
    const bodies = [
      { ...wagerBody(walletId), money: { amount: 25, currency: 'BRL' } },
      { ...wagerBody(walletId), extra: true },
      { ...wagerBody(walletId), kind: 'OPENING' },
    ];
    for (const body of bodies) {
      const res = await send('POST', '/wagering/transactions', body, headers);
      expect(res.status).toBe(400);
      expect((res.body as SubmitBody).error?.code).toBe('INVALID_PAYLOAD');
    }
  });

  test('replay → same status, idempotentReplay true and Idempotent-Replayed header', async () => {
    const walletId = await createWallet();
    const first = await submit(walletId);

    const replay = await submit(walletId);

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  test('same key with a different amount → 409 IDEMPOTENCY_CONFLICT', async () => {
    const walletId = await createWallet();
    await submit(walletId);

    const res = await submit(walletId, { amount: '30.00' }, 'provider-a:bet-1');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  test('BET above the balance → 422 INSUFFICIENT_FUNDS with transactionId and the balance at decision time', async () => {
    const walletId = await createWallet();

    const res = await submit(walletId, { amount: '200.00' });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: 'INSUFFICIENT_FUNDS',
        message: expect.any(String),
        retryable: false,
      },
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  test('replay of a rejected transaction → 422 again with the replay header', async () => {
    const walletId = await createWallet();
    const first = await submit(walletId, { amount: '200.00' });

    const replay = await submit(walletId, { amount: '200.00' });

    expect(replay.status).toBe(422);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  test('BET in another currency → 422 CURRENCY_MISMATCH with null balance, identical on replay and GET', async () => {
    const walletId = await createWallet();

    const first = await submit(walletId, { currency: 'USD' });
    const replay = await submit(walletId, { currency: 'USD' });
    const got = await send('GET', `/wagering/transactions/${first.body.transactionId}`);

    expect(first.status).toBe(422);
    expect(first.body.error?.code).toBe('CURRENCY_MISMATCH');
    expect(first.body.balance).toBeNull();
    expect(replay.status).toBe(422);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH', balanceAfter: null });
  });

  test.each(['USD', 'BRL'])(
    'PLAYER_MISMATCH in %s → stable snapshot on original, replay and GET without a financial effect',
    async (currency) => {
      const walletId = await createWallet();
      const input = { playerId: UNKNOWN_ID, currency };
      const expectedBalance = currency === 'BRL' ? { amount: '100.00', currency: 'BRL' } : null;

      const first = await submit(walletId, input);
      const replay = await submit(walletId, input);
      const got = await send('GET', `/wagering/transactions/${first.body.transactionId}`);
      const byExternalId = await send('GET', '/providers/provider-a/wagering/transactions/bet-1');

      expect(first.status).toBe(422);
      expect(first.body).toMatchObject({
        status: 'REJECTED',
        error: { code: 'PLAYER_MISMATCH', retryable: false },
        balance: expectedBalance,
        idempotentReplay: false,
      });
      expect(replay.status).toBe(422);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({
        failureCode: 'PLAYER_MISMATCH',
        balanceAfter: expectedBalance,
      });
      expect(byExternalId.status).toBe(200);
      expect(byExternalId.body).toEqual(got.body);

      const [stored] = await orm.em.getConnection().execute<
        { balance_after: string | null; wallet_version_after: number | null }[]
      >('SELECT balance_after, wallet_version_after FROM wager_transactions WHERE id = ?', [
        first.body.transactionId,
      ]);
      expect(stored).toEqual({
        balance_after: expectedBalance?.amount ?? null,
        wallet_version_after: expectedBalance === null ? null : 1,
      });

      const wallet = await send('GET', `/wallets/${walletId}`);
      expect(wallet.status).toBe(200);
      expect(wallet.body).toMatchObject({
        balance: { amount: '100.00', currency: 'BRL' },
        version: 1,
      });
      const [counts] = await orm.em.getConnection().execute<
        { entries: number; transactions: number; events: number }[]
      >(
        `SELECT
           (SELECT COUNT(*)::INT FROM wallet_ledger_entries WHERE wallet_id = ?) AS entries,
           (SELECT COUNT(*)::INT FROM wager_transactions WHERE wallet_id = ?) AS transactions,
           (SELECT COUNT(*)::INT FROM outbox_messages WHERE aggregate_id = ?) AS events`,
        [walletId, walletId, walletId],
      );
      // Só o crédito de abertura, a transação OPENING e uma rejeição com o seu evento.
      expect(counts).toEqual({ entries: 1, transactions: 2, events: 3 });
    },
  );

  test('REFUND before its BET → 202 PENDING_REFERENCE with null balance', async () => {
    const walletId = await createWallet();

    const res = await submit(walletId, {
      externalTransactionId: 'refund-1',
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-1',
    });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: null });
  });

  test('REFUND without a reference → 400 REFERENCE_REQUIRED', async () => {
    const walletId = await createWallet();

    const res = await submit(walletId, { externalTransactionId: 'refund-1', kind: 'REFUND' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('REFERENCE_REQUIRED');
  });

  test('unknown wallet → 404 WALLET_NOT_FOUND', async () => {
    const res = await submit(UNKNOWN_ID);

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('WALLET_NOT_FOUND');
  });

  test('uppercase walletId reaches the same wallet and a case-only difference is a replay', async () => {
    const walletId = await createWallet();
    const first = await submit(walletId);

    const replay = await submit(walletId, {
      walletId: walletId.toUpperCase(),
      playerId: PLAYER_ID.toUpperCase(),
    });

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    const wallet = await send('GET', `/wallets/${walletId}`);
    expect((wallet.body as { balance: Money }).balance.amount).toBe('75.00');
  });

  test('uppercase walletId on a new transaction debits the lowercase wallet', async () => {
    const walletId = await createWallet();

    const res = await submit(walletId, { walletId: walletId.toUpperCase() });

    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  test('second REFUND of the same BET → 422 ALREADY_REVERSED', async () => {
    const walletId = await createWallet();
    await submit(walletId);
    const refund = (id: string) =>
      submit(walletId, {
        externalTransactionId: id,
        kind: 'REFUND',
        amount: '25.00',
        referenceExternalTransactionId: 'bet-1',
      });
    expect((await refund('refund-1')).status).toBe(201);

    const res = await refund('refund-2');

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('ALREADY_REVERSED');
  });

  test('ROLLBACK of a WIN without funds left → 422 REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const walletId = await createWallet('10.00');
    expect(
      (await submit(walletId, { externalTransactionId: 'win-1', kind: 'WIN', amount: '50.00' }))
        .status,
    ).toBe(201);
    expect(
      (await submit(walletId, { externalTransactionId: 'bet-2', amount: '60.00' })).status,
    ).toBe(201);

    const res = await submit(walletId, {
      externalTransactionId: 'rollback-1',
      kind: 'ROLLBACK',
      amount: '50.00',
      referenceExternalTransactionId: 'win-1',
    });

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  });
});

describe('GET transactions', () => {
  const FIELDS = [
    'transactionId',
    'providerId',
    'externalTransactionId',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
    'kind',
    'money',
    'status',
    'failureCode',
    'referenceTransactionId',
    'balanceAfter',
    'createdAt',
    'processedAt',
  ];

  test('by id → 200 with the transaction fields', async () => {
    const walletId = await createWallet();
    const created = await submit(walletId);

    const res = await send('GET', `/wagering/transactions/${created.body.transactionId}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...FIELDS].sort());
    expect(res.body).toMatchObject({
      transactionId: created.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      walletId,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      failureCode: null,
      balanceAfter: { amount: '75.00', currency: 'BRL' },
    });
  });

  test('by provider and external id → 200; rejected shows its failureCode', async () => {
    const walletId = await createWallet();
    await submit(walletId, { amount: '200.00' });

    const res = await send('GET', '/providers/provider-a/wagering/transactions/bet-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('unknown ids → 404 NOT_FOUND; malformed id → 400', async () => {
    const byId = await send('GET', `/wagering/transactions/${UNKNOWN_ID}`);
    const byExternal = await send('GET', '/providers/provider-a/wagering/transactions/nope');
    const malformed = await send('GET', '/wagering/transactions/not-a-uuid');

    expect(byId.status).toBe(404);
    expect((byId.body as SubmitBody).error?.code).toBe('NOT_FOUND');
    expect(byExternal.status).toBe(404);
    expect((byExternal.body as SubmitBody).error?.code).toBe('NOT_FOUND');
    expect(malformed.status).toBe(400);
  });
});
