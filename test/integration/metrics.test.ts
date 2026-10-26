import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { LockWaitTimeoutException } from '@mikro-orm/core';
import { EntityManager, type MikroORM } from '@mikro-orm/postgresql';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../../src/application/ports/wager-transaction.repository';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../src/application/ports/wallet.repository';
import { ResolvePendingReferenceUseCase } from '../../src/application/wager/resolve-pending-reference.use-case';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { scrapeMetrics, seriesDelta, seriesValue } from './support/metrics';

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

function bet(walletId: string, amount = '25.00', kind = 'BET', external = 'bet-1') {
  return {
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function submitTo(
  baseUrl: string,
  body: { externalTransactionId: string; referenceExternalTransactionId?: string },
) {
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `provider-a:${body.externalTransactionId}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { transactionId: string } };
}

async function submit(body: { externalTransactionId: string }): Promise<number> {
  return (await submitTo(t.baseUrl, body)).status;
}

const scrape = async () => {
  const res = await fetch(`${t.baseUrl}/metrics`);
  expect(res.status).toBe(200);
  return { text: await res.text(), contentType: res.headers.get('content-type') };
};

const PROCESSED_HTTP_BET =
  'wagering_transactions_total{channel="http",kind="BET",status="PROCESSED"}';
const lockTimeout = () =>
  new LockWaitTimeoutException(Object.assign(new Error('lock timeout'), { code: '55P03' }));

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
    const before = await scrapeMetrics(t.baseUrl);

    expect(await submit(bet(walletId))).toBe(201);

    expect(await submit(bet(walletId))).toBe(201);
    expect(await submit(bet(walletId, '30.00'))).toBe(409);

    const after = await scrapeMetrics(t.baseUrl);
    const delta = (series: string) => seriesValue(after, series) - seriesValue(before, series);
    expect(delta(PROCESSED_HTTP_BET)).toBe(1);
    expect(delta('wagering_duplicates_total{type="idempotency_replay"}')).toBe(1);
    expect(delta('wagering_duplicates_total{type="idempotency_conflict"}')).toBe(1);
    for (const outcome of ['processed', 'replay', 'conflict']) {
      expect(
        delta(`wagering_processing_duration_seconds_count{channel="http",outcome="${outcome}"}`),
      ).toBe(1);
    }
  });

  test('parallel requests with the same key count one transaction and the rest as replays', async () => {
    const walletId = await createWallet();
    const before = await scrapeMetrics(t.baseUrl);
    const parallel = 10;

    const statuses = await Promise.all(
      Array.from({ length: parallel }, () => submit(bet(walletId))),
    );

    expect(statuses.every((status) => status === 201)).toBe(true);
    const after = await scrapeMetrics(t.baseUrl);
    const delta = (series: string) => seriesValue(after, series) - seriesValue(before, series);
    expect(delta(PROCESSED_HTTP_BET)).toBe(1);
    expect(delta('wagering_duplicates_total{type="idempotency_replay"}')).toBe(parallel - 1);
  });

  test('a pending reference resolved by the worker use case is counted on the worker channel', async () => {
    const walletId = await createWallet();
    const refund = await submitTo(t.baseUrl, {
      ...bet(walletId, '25.00', 'REFUND', 'refund-1'),
      referenceExternalTransactionId: 'bet-1',
    });
    expect(refund.status).toBe(202);
    expect(await submit(bet(walletId))).toBe(201);

    const [claim] = await t.app
      .get<WagerTransactionRepository>(WAGER_TRANSACTION_REPOSITORY)
      .claimDuePendingReferences({ now: new Date(), limit: 1, leaseMs: 30_000 });
    if (!claim) throw new Error('pending not claimed');

    const resolved = await seriesDelta(
      t.baseUrl,
      'wagering_transactions_total{channel="worker",kind="REFUND",status="PROCESSED"}',
      () =>
        t.app.get(ResolvePendingReferenceUseCase).execute({
          transactionId: refund.body.transactionId,
          walletId,
          claimToken: claim.claimToken,
        }),
    );

    expect(resolved).toBe(1);
  });

  test('counts a rejected BET with its failure code', async () => {
    const walletId = await createWallet();

    const series =
      'wagering_transactions_total{channel="http",kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS"}';
    const before = seriesValue((await scrape()).text, series);

    expect(await submit(bet(walletId, '500.00'))).toBe(422);

    expect(seriesValue((await scrape()).text, series) - before).toBe(1);
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

describe('transient database errors', () => {
  test('a lock timeout that clears on the retry counts one conflict and one retry', async () => {
    let failed = false;
    const flaky = await createTestApp({}, (builder) =>
      builder.overrideProvider(WALLET_REPOSITORY).useFactory({
        inject: [EntityManager],
        factory: (em: EntityManager): WalletRepository => {
          const real = new MikroOrmWalletRepository(em);
          return {
            add: (wallet) => real.add(wallet),
            findById: (id) => real.findById(id),
            save: (wallet, expectedVersion) => real.save(wallet, expectedVersion),
            lockById: async (id) => {
              if (!failed) {
                failed = true;
                throw lockTimeout();
              }
              return real.lockById(id);
            },
          };
        },
      }),
    );
    try {
      const walletId = await createWallet();

      const status = (await submitTo(flaky.baseUrl, bet(walletId))).status;

      expect(status).toBe(201);
      const text = await scrapeMetrics(flaky.baseUrl);
      expect(seriesValue(text, 'wagering_lock_conflicts_total{code="55P03"}')).toBe(1);
      expect(seriesValue(text, 'wagering_retries_total{operation="use_case_transient"}')).toBe(1);
      expect(seriesValue(text, PROCESSED_HTTP_BET)).toBe(1);
    } finally {
      await flaky.close();
    }
  });
});
