import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { LogCapture } from './support/log-capture';
import { createTestQueues, type TestQueues } from './support/queues';
import { waitFor } from './support/wait';

const PROVIDER_ID = 'provider-a';
// valores e campos do corpo que nunca podem aparecer em log
const HTTP_AMOUNT = '37.41';
const CONFLICT_AMOUNT = '52.19';
const SQS_AMOUNT = '18.73';
const BODY_MARKERS = ['round-1', 'game-1', '"money"'];

let orm: MikroORM;
let queues: TestQueues;
// uma só aplicação, para que as linhas do SQS e do HTTP caiam no mesmo destino
let app: TestApp;
let logs: LogCapture;

/** Dono de cada wallet criada (uma wallet por jogador). */
const playerOf = new Map<string, string>();

function wagerBody(walletId: string, amount: string, externalTransactionId: string) {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: playerOf.get(walletId),
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function createWallet(app: TestApp): Promise<string> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${app.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });
  const { id } = (await res.json()) as { id: string };
  playerOf.set(id, playerId);
  return id;
}

function submit(body: unknown, key: string, correlationId: string) {
  return fetch(`${app.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  orm = await withTestDb();
  await resetDb(orm);
  queues = await createTestQueues({ visibilityTimeout: 2, maxReceiveCount: 3 });
  logs = new LogCapture();
  app = await createTestApp(
    {
      LOG_LEVEL: 'info',
      SQS_CONSUMER_ENABLED: 'true',
      SQS_TRANSACTIONS_QUEUE: queues.transactions,
      SQS_TRANSACTIONS_DLQ: queues.transactionsDlq,
      SQS_EVENTS_QUEUE: queues.events,
      SQS_WAIT_TIME_SECONDS: '1',
    },
    undefined,
    logs,
  );
});

afterAll(async () => {
  await app.close();
  await queues.destroy();
  await orm.close(true);
});

describe('logs com ids do fluxo de aposta', () => {
  test('HTTP: uma linha por transação, com os ids, e nunca o valor nem o corpo', async () => {
    const walletId = await createWallet(app);
    const body = wagerBody(walletId, HTTP_AMOUNT, 'bet-log-1');
    const key = `${PROVIDER_ID}:bet-log-1`;

    const first = await submit(body, key, 'corr-first');
    const { transactionId } = (await first.json()) as { transactionId: string };
    await (await submit(body, key, 'corr-replay')).json();

    const lines = logs.withMessage('wager transaction processed');
    expect(lines).toHaveLength(2);
    const line = lines.find((l) => l.correlationId === 'corr-first');
    expect(line).toMatchObject({
      level: 30,
      transactionId,
      walletId,
      providerId: PROVIDER_ID,
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(typeof line?.durationMs).toBe('number');
    const replay = lines.find((l) => l.correlationId === 'corr-replay');
    expect(replay).toMatchObject({ transactionId, walletId, idempotentReplay: true });

    for (const forbidden of [HTTP_AMOUNT, ...BODY_MARKERS]) {
      expect(logs.text()).not.toContain(forbidden);
    }
  });

  test('HTTP: erro de domínio carrega walletId, providerId e correlationId', async () => {
    const walletId = await createWallet(app);
    const key = `${PROVIDER_ID}:bet-log-2`;
    await submit(wagerBody(walletId, HTTP_AMOUNT, 'bet-log-2'), key, 'corr-ok');

    const res = await submit(
      wagerBody(walletId, CONFLICT_AMOUNT, 'bet-log-2'),
      key,
      'corr-conflict',
    );
    expect(res.status).toBe(409);

    const failures = logs.lines().filter((l) => l.correlationId === 'corr-conflict' && l.code);
    expect(failures.length).toBeGreaterThan(0);
    for (const line of failures) {
      expect(line).toMatchObject({ walletId, providerId: PROVIDER_ID });
    }
    expect(logs.text()).not.toContain(CONFLICT_AMOUNT);
  });

  test('SQS: linha da mensagem com os ids e correlationId = messageId, sem valor nem corpo', async () => {
    const walletId = await createWallet(app);
    const messageId = crypto.randomUUID();
    await queues.send(
      {
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...wagerBody(walletId, SQS_AMOUNT, 'bet-sqs-log'),
          idempotencyKey: `${PROVIDER_ID}:bet-sqs-log`,
        },
      },
      { groupId: walletId },
    );

    const find = () =>
      logs.withMessage('wager message processed').find((l) => l.messageId === messageId);
    await waitFor(() => find() !== undefined, 'consumer log line');
    expect(find()).toMatchObject({
      correlationId: messageId,
      messageId,
      walletId,
      providerId: PROVIDER_ID,
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(typeof find()?.transactionId).toBe('string');
    expect(typeof find()?.durationMs).toBe('number');
    for (const forbidden of [SQS_AMOUNT, ...BODY_MARKERS]) {
      expect(logs.text()).not.toContain(forbidden);
    }
  });
});
