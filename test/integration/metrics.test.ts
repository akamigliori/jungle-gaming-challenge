import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

let orm: MikroORM;
let t: TestApp;

async function createWallet(): Promise<string> {
  const res = await fetch(`${t.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: PLAYER_ID,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });
  return ((await res.json()) as { id: string }).id;
}

function bet(walletId: string, amount = '25.00') {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'bet-1',
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function submit(body: unknown): Promise<number> {
  const res = await fetch(`${t.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'provider-a:bet-1' },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function scrape(): Promise<{ text: string; contentType: string | null }> {
  const res = await fetch(`${t.baseUrl}/metrics`);
  expect(res.status).toBe(200);
  return { text: await res.text(), contentType: res.headers.get('content-type') };
}

beforeAll(async () => {
  orm = await withTestDb();
  t = await createTestApp();
});

beforeEach(async () => {
  await resetDb(orm);
});

afterAll(async () => {
  await t.close();
  await orm.close(true);
});

describe('GET /metrics', () => {
  test('is public and served in the Prometheus text format', async () => {
    const { text, contentType } = await scrape();

    expect(contentType).toContain('text/plain');
    expect(text).toContain('# TYPE wagering_transactions_total counter');
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  test('shows a processed BET, its replay and a conflict', async () => {
    const walletId = await createWallet();

    expect(await submit(bet(walletId))).toBe(201);
    expect(await submit(bet(walletId))).toBe(201);
    expect(await submit(bet(walletId, '30.00'))).toBe(409);

    const { text } = await scrape();
    expect(text).toContain(
      'wagering_transactions_total{channel="http",kind="BET",status="PROCESSED"} 1',
    );
    expect(text).toContain('wagering_duplicates_total{type="idempotency_replay"} 1');
    expect(text).toContain('wagering_duplicates_total{type="idempotency_conflict"} 1');
    expect(text).toContain(
      'wagering_processing_duration_seconds_count{channel="http",outcome="processed"} 1',
    );
    expect(text).toContain(
      'wagering_processing_duration_seconds_count{channel="http",outcome="replay"} 1',
    );
    expect(text).toContain(
      'wagering_processing_duration_seconds_count{channel="http",outcome="conflict"} 1',
    );
  });

  test('counts a rejected BET with its failure code', async () => {
    const walletId = await createWallet();

    expect(await submit(bet(walletId, '500.00'))).toBe(422);

    const { text } = await scrape();
    expect(text).toContain(
      'wagering_transactions_total{channel="http",kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS"} 1',
    );
  });

  test('reports the outbox backlog computed at scrape time', async () => {
    const walletId = await createWallet();
    await submit(bet(walletId));

    const [row] = await orm.em
      .getConnection()
      .execute<{ n: number }[]>('SELECT COUNT(*)::INT AS n FROM outbox_messages');
    expect(row?.n).toBeGreaterThan(0);

    // sem publisher rodando, todo evento gravado continua pendente
    const { text } = await scrape();
    expect(text).toMatch(new RegExp(`^wagering_outbox_pending ${row?.n}$`, 'm'));
    expect(text).toMatch(/^wagering_outbox_lag_seconds [0-9.e+-]+$/m);
  });
});
