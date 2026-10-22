import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CONSUMER_NAME } from '../../src/interfaces/sqs/wager-transactions.consumer';
import { createTestApp, type TestApp } from './support/app';
import { resetDb, withTestDb } from './support/db';
import { assertLedgerInvariant } from './support/invariants';
import { createTestQueues, type TestQueues } from './support/queues';
import { waitFor } from './support/wait';

const VISIBILITY_TIMEOUT_SECONDS = 2;
const MAX_RECEIVE_COUNT = 3;
const PROVIDER_ID = 'provider-a';

let orm: MikroORM;
let queues: TestQueues;
let t: TestApp;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute<T[]>(query, params);

/** Dono de cada wallet criada, para as mensagens usarem o jogador certo. */
const playerOf = new Map<string, string>();

async function createWallet(amount = '100.00'): Promise<string> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${t.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  playerOf.set(id, playerId);
  return id;
}

interface BetOptions {
  externalTransactionId?: string;
  amount?: unknown;
}

function betData(walletId: string, o: BetOptions = {}) {
  const externalTransactionId = o.externalTransactionId ?? `bet-${crypto.randomUUID()}`;
  return {
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: playerOf.get(walletId) ?? crypto.randomUUID(),
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: o.amount ?? '25.00', currency: 'BRL' },
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
  };
}

function envelope(data: Record<string, unknown>, messageId: string = crypto.randomUUID()) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  };
}

async function transactionsOf(externalTransactionId: string) {
  return sql<{ status: string; wallet_id: string }>(
    'SELECT status, wallet_id FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
    [PROVIDER_ID, externalTransactionId],
  );
}

async function inboxRows(messageId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    'SELECT COUNT(*)::INT AS n FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
    [CONSUMER_NAME, messageId],
  );
  return row?.n ?? 0;
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql<{ balance: string }>(
    'SELECT balance::TEXT AS balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return row?.balance ?? '';
}

async function debitsOf(walletId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    `SELECT COUNT(*)::INT AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
    [walletId],
  );
  return row?.n ?? 0;
}

async function waitProcessed(externalTransactionId: string): Promise<void> {
  await waitFor(
    async () => (await transactionsOf(externalTransactionId)).length > 0,
    `transaction ${externalTransactionId}`,
  );
}

async function waitQueueEmpty(): Promise<void> {
  await waitFor(async () => (await queues.depth('transactions')) === 0, 'empty transactions queue');
}

/** Drena a DLQ até `count` mensagens chegarem. */
async function waitDeadLetters(count: number): Promise<Message[]> {
  const received: Message[] = [];
  await waitFor(async () => {
    received.push(...(await queues.receiveAll('transactionsDlq')));
    return received.length >= count;
  }, `${count} dead-lettered messages`);
  return received;
}

const failureCodeOf = (m: Message | undefined) => m?.MessageAttributes?.failureCode?.StringValue;

beforeAll(async () => {
  orm = await withTestDb();
  // o consumer roda em segundo plano: o banco é limpo uma vez, antes de ele subir
  await resetDb(orm);
  queues = await createTestQueues({
    visibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
    maxReceiveCount: MAX_RECEIVE_COUNT,
  });
  t = await createTestApp({
    SQS_CONSUMER_ENABLED: 'true',
    SQS_TRANSACTIONS_QUEUE: queues.transactions,
    SQS_TRANSACTIONS_DLQ: queues.transactionsDlq,
    SQS_EVENTS_QUEUE: queues.events,
  });
});

afterEach(async () => {
  await assertLedgerInvariant(orm);
});

afterAll(async () => {
  await t.close();
  await queues.destroy();
  await orm.close(true);
});

describe('SQS consumer', () => {
  test('a valid message is processed, recorded in the inbox and removed from the queue', async () => {
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);

    await queues.send(message, { groupId: walletId });

    await waitProcessed(data.externalTransactionId);
    await waitQueueEmpty();
    expect(await transactionsOf(data.externalTransactionId)).toEqual([
      { status: 'PROCESSED', wallet_id: walletId },
    ]);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
  });

  test('a redelivered message (same messageId) debits once and both deliveries are acked', async () => {
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);

    await queues.send(message, { groupId: walletId });
    await waitProcessed(data.externalTransactionId);
    await waitQueueEmpty();
    await queues.send(message, { groupId: walletId, dedupId: `${message.messageId}-again` });
    await waitQueueEmpty();

    expect(await debitsOf(walletId)).toBe(1);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await queues.receiveAll('transactionsDlq')).toEqual([]);
  });

  test('the same messageId with a different payload goes to the DLQ as IDEMPOTENCY_CONFLICT', async () => {
    const walletId = await createWallet();
    const data = betData(walletId);
    const message = envelope(data);
    await queues.send(message, { groupId: walletId });
    await waitProcessed(data.externalTransactionId);

    const conflicting = envelope(
      { ...data, money: { amount: '30.00', currency: 'BRL' } },
      message.messageId,
    );
    await queues.send(conflicting, { groupId: walletId, dedupId: crypto.randomUUID() });

    const [dead] = await waitDeadLetters(1);
    expect(failureCodeOf(dead)).toBe('IDEMPOTENCY_CONFLICT');
    expect(dead?.Body).toBe(JSON.stringify(conflicting));
    expect(dead?.Attributes?.MessageGroupId).toBe(walletId);
    expect(dead?.MessageAttributes?.failedAt?.StringValue).toBeString();
    await waitQueueEmpty();
    expect(await debitsOf(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
  });

  test('invalid messages go to the DLQ on the first delivery and nothing is written', async () => {
    const walletId = await createWallet();
    const numericAmount = betData(walletId, { amount: 25 });
    const unknownWallet = betData(crypto.randomUUID());
    const numericMessage = envelope(numericAmount);
    const unknownWalletMessage = envelope(unknownWallet);

    await queues.send('{', { groupId: crypto.randomUUID(), dedupId: crypto.randomUUID() });
    await queues.send(numericMessage, { groupId: walletId });
    await queues.send(unknownWalletMessage, { groupId: unknownWallet.walletId });

    const dead = await waitDeadLetters(3);
    const codeByBody = new Map(dead.map((m) => [m.Body, failureCodeOf(m)]));
    expect(codeByBody.get('{')).toBe('INVALID_PAYLOAD');
    expect(codeByBody.get(JSON.stringify(numericMessage))).toBe('INVALID_PAYLOAD');
    expect(codeByBody.get(JSON.stringify(unknownWalletMessage))).toBe('WALLET_NOT_FOUND');
    await waitQueueEmpty();
    expect(await transactionsOf(numericAmount.externalTransactionId)).toEqual([]);
    expect(await transactionsOf(unknownWallet.externalTransactionId)).toEqual([]);
    expect(await inboxRows(numericMessage.messageId)).toBe(0);
    expect(await inboxRows(unknownWalletMessage.messageId)).toBe(0);
    expect(await balanceOf(walletId)).toBe('100.00');
  });

  test('the same bet via HTTP and then via SQS debits once and the message is acked', async () => {
    const walletId = await createWallet();
    const { idempotencyKey, ...body } = betData(walletId);
    const res = await fetch(`${t.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);

    const message = envelope({ ...body, idempotencyKey });
    await queues.send(message, { groupId: walletId });

    await waitFor(async () => (await inboxRows(message.messageId)) === 1, 'inbox row');
    await waitQueueEmpty();
    expect(await transactionsOf(body.externalTransactionId)).toHaveLength(1);
    expect(await debitsOf(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await queues.receiveAll('transactionsDlq')).toEqual([]);
  });
});
