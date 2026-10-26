import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const PROVIDER = 'provider-a';
const MISSING_WALLET = '00000000-0000-7000-8000-0000000000ff';

let orm: MikroORM;
let t: TestApp;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

const auditCount = async (): Promise<number> => {
  const [row] = await sql<{ n: number }>(
    'SELECT COUNT(*)::INT AS n FROM wager_submission_failures',
  );
  return row?.n ?? 0;
};

async function createWallet(amount = '100.00'): Promise<string> {
  const res = await fetch(`${t.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: PLAYER_ID, initialBalance: { amount, currency: 'BRL' } }),
  });
  return ((await res.json()) as { id: string }).id;
}

function submit(walletId: string, over: Record<string, unknown> = {}): Promise<Response> {
  const externalTransactionId = (over.externalTransactionId as string) ?? 'bet-1';
  return fetch(`${t.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${PROVIDER}:${externalTransactionId}`,
    },
    body: JSON.stringify({
      providerId: PROVIDER,
      externalTransactionId,
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...over,
    }),
  });
}

interface FailuresBody {
  failures: {
    reasonCode: string;
    category: string;
    retryable: boolean;
    channel: string;
    messageId: string | null;
    correlationId: string;
  }[];
}

const failures = (externalTransactionId: string): Promise<FailuresBody> =>
  fetch(
    `${t.baseUrl}/providers/${PROVIDER}/wagering/transactions/${externalTransactionId}/failures`,
  ).then((res) => res.json() as Promise<FailuresBody>);

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

describe('auditoria de recusas', () => {
  test('dinheiro inválido → 400 e recusa VALIDATION auditada', async () => {
    const walletId = await createWallet();

    const res = await submit(walletId, { money: { amount: '10.999', currency: 'BRL' } });

    expect(res.status).toBe(400);
    expect(await auditCount()).toBe(1);
    const { failures: rows } = await failures('bet-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reasonCode: 'INVALID_MONEY',
      category: 'VALIDATION',
      retryable: false,
      channel: 'HTTP',
      messageId: null,
    });
    expect(rows[0]?.correlationId).toBeTruthy();
  });

  test('conflito de idempotência → 409 e recusa CONFLICT auditada', async () => {
    const walletId = await createWallet();
    expect((await submit(walletId)).status).toBe(201);

    const conflict = await submit(walletId, { money: { amount: '30.00', currency: 'BRL' } });

    expect(conflict.status).toBe(409);
    // a BET processada não é auditoria; só a tentativa conflitante
    expect(await auditCount()).toBe(1);
    const { failures: rows } = await failures('bet-1');
    expect(rows[0]).toMatchObject({
      reasonCode: 'IDEMPOTENCY_CONFLICT',
      category: 'CONFLICT',
      retryable: false,
    });
  });

  test('wallet inexistente → 404 e recusa UNPROCESSABLE auditada', async () => {
    const res = await submit(MISSING_WALLET);

    expect(res.status).toBe(404);
    expect(await auditCount()).toBe(1);
    const { failures: rows } = await failures('bet-1');
    expect(rows[0]).toMatchObject({
      reasonCode: 'WALLET_NOT_FOUND',
      category: 'UNPROCESSABLE',
    });
  });

  test('rejeição de negócio (saldo insuficiente) não é auditada', async () => {
    const walletId = await createWallet('10.00');

    const res = await submit(walletId);

    expect(res.status).toBe(422);
    expect(await auditCount()).toBe(0);
    expect((await failures('bet-1')).failures).toHaveLength(0);
  });

  test('a linha de auditoria é imutável (UPDATE bloqueado)', async () => {
    const walletId = await createWallet();
    await submit(walletId, { money: { amount: '10.999', currency: 'BRL' } });

    await expect(sql(`UPDATE wager_submission_failures SET detail = 'mudou'`)).rejects.toThrow(
      'append-only',
    );
  });
});
