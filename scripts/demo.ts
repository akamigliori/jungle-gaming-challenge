/**
 * Roteiro de demonstração: percorre os fluxos principais contra a aplicação já no ar e narra
 * cada passo. Sai com código diferente de zero se algum passo não se comportar como esperado.
 *
 * Variáveis: `DEMO_BASE_URL` (padrão http://localhost:3000) e as mesmas variáveis de SQS da
 * aplicação (`SQS_ENDPOINT`, `SQS_TRANSACTIONS_QUEUE`, credenciais AWS). Dinheiro trafega sempre
 * como string.
 */
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/infrastructure/config/config';
import { createSqsClient } from '../src/infrastructure/sqs/sqs.client';

const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';
const CURRENCY = 'BRL';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 40_000;
const METRICS_PREFIX = 'wagering_';
const METRICS_MAX_LINES = 12;

const config = loadConfig();
const runId = crypto.randomUUID().slice(0, 8);
const playerId = crypto.randomUUID();
let stepNumber = 0;

interface Reply {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: resposta JSON arbitrária inspecionada pelo roteiro
  body: any;
}

class DemoFailure extends Error {}

function step(title: string): void {
  stepNumber += 1;
  console.log(`\n${stepNumber}. ${title}`);
}

function say(text: string): void {
  console.log(`   ${text}`);
}

/** Confere um resultado esperado; qualquer divergência encerra o roteiro. */
function expectThat(condition: boolean, description: string): void {
  if (!condition) throw new DemoFailure(`esperado: ${description}`);
  say(`ok: ${description}`);
}

async function call(method: string, path: string, body?: unknown, headers = {}): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // resposta que não é JSON (ex.: /metrics) fica como texto
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

function wagerBody(walletId: string, externalTransactionId: string, kind: string, amount: string) {
  return {
    providerId: 'demo-provider',
    externalTransactionId,
    playerId,
    walletId,
    roundId: `round-${runId}`,
    gameId: 'demo-game',
    kind,
    money: { amount, currency: CURRENCY },
  };
}

function submit(body: unknown, idempotencyKey: string): Promise<Reply> {
  return call('POST', '/wagering/transactions', body, { 'idempotency-key': idempotencyKey });
}

async function waitUntilProcessed(externalTransactionId: string): Promise<Reply> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const reply = await call(
      'GET',
      `/providers/demo-provider/wagering/transactions/${externalTransactionId}`,
    );
    if (reply.status === 200 && reply.body.status === 'PROCESSED') return reply;
    if (Date.now() > deadline) {
      throw new DemoFailure(`${externalTransactionId} não chegou a PROCESSED a tempo`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function sendToQueue(walletId: string, externalTransactionId: string, amount: string) {
  const sqs = createSqsClient(config);
  try {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: config.sqs.queues.transactions }),
    );
    const message = {
      messageId: `demo-${runId}-${externalTransactionId}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        ...wagerBody(walletId, externalTransactionId, 'BET', amount),
        idempotencyKey: `demo-provider:${externalTransactionId}`,
      },
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: walletId,
        MessageDeduplicationId: message.messageId,
      }),
    );
  } finally {
    sqs.destroy();
  }
}

async function run(): Promise<void> {
  console.log(`Demonstração contra ${BASE_URL} (execução ${runId})`);

  step('Cria uma wallet com saldo inicial de 1000.00');
  const created = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount: '1000.00', currency: CURRENCY },
  });
  expectThat(created.status === 201, 'POST /wallets responde 201');
  const walletId: string = created.body.id;
  say(`wallet ${walletId}, saldo ${created.body.balance.amount}`);

  step('BET de 100.00 debita a wallet');
  const betBody = wagerBody(walletId, `bet-${runId}`, 'BET', '100.00');
  const bet = await submit(betBody, `demo-provider:bet-${runId}`);
  expectThat(bet.status === 201 && bet.body.status === 'PROCESSED', 'BET processada (201)');
  expectThat(bet.body.balance.amount === '900.00', 'saldo 900.00');

  step('WIN de 250.00 credita a wallet');
  const win = await submit(
    {
      ...wagerBody(walletId, `win-${runId}`, 'WIN', '250.00'),
      referenceExternalTransactionId: `bet-${runId}`,
    },
    `demo-provider:win-${runId}`,
  );
  expectThat(
    win.status === 201 && win.body.balance.amount === '1150.00',
    'WIN processada, saldo 1150.00',
  );

  step('Replay da mesma BET: mesma resposta, sem novo débito');
  const replay = await submit(betBody, `demo-provider:bet-${runId}`);
  expectThat(replay.status === 201, 'replay responde 201 como o original');
  expectThat(replay.body.transactionId === bet.body.transactionId, 'mesmo transactionId');
  expectThat(replay.body.idempotentReplay === true, 'idempotentReplay = true');
  const afterReplay = await call('GET', `/wallets/${walletId}`);
  expectThat(afterReplay.body.balance.amount === '1150.00', 'saldo continua 1150.00');

  step('Mesma chave com outro valor: conflito de idempotência');
  const conflict = await submit(
    wagerBody(walletId, `bet-${runId}`, 'BET', '999.00'),
    `demo-provider:bet-${runId}`,
  );
  expectThat(conflict.status === 409, 'responde 409');
  expectThat(conflict.body.error.code === 'IDEMPOTENCY_CONFLICT', 'código IDEMPOTENCY_CONFLICT');

  step('BET maior que o saldo: rejeitada por saldo insuficiente');
  const broke = await submit(
    wagerBody(walletId, `big-${runId}`, 'BET', '5000.00'),
    `demo-provider:big-${runId}`,
  );
  expectThat(broke.status === 422, 'responde 422');
  expectThat(broke.body.error.code === 'INSUFFICIENT_FUNDS', 'código INSUFFICIENT_FUNDS');
  expectThat(broke.body.status === 'REJECTED', 'transação gravada como REJECTED');

  step('REFUND chega antes da BET que ele estorna: fica pendente');
  const lateBetId = `late-bet-${runId}`;
  const refund = await submit(
    {
      ...wagerBody(walletId, `refund-${runId}`, 'REFUND', '40.00'),
      referenceExternalTransactionId: lateBetId,
    },
    `demo-provider:refund-${runId}`,
  );
  expectThat(refund.status === 202, 'responde 202');
  expectThat(refund.body.status === 'PENDING_REFERENCE', 'status PENDING_REFERENCE');

  step('A BET chega; o worker de pendências resolve o REFUND');
  const lateBet = await submit(
    wagerBody(walletId, lateBetId, 'BET', '40.00'),
    `demo-provider:${lateBetId}`,
  );
  expectThat(lateBet.status === 201, 'BET processada (201)');
  say('aguardando o worker reavaliar o REFUND...');
  const resolved = await waitUntilProcessed(`refund-${runId}`);
  expectThat(resolved.body.status === 'PROCESSED', 'REFUND resolvido e PROCESSED');
  const afterRefund = await call('GET', `/wallets/${walletId}`);
  expectThat(afterRefund.body.balance.amount === '1150.00', 'saldo 1150.00 (BET 40.00 estornada)');

  step('Uma BET de 50.00 entregue pela fila SQS');
  await sendToQueue(walletId, `sqs-bet-${runId}`, '50.00');
  say('mensagem enviada; aguardando o consumer...');
  await waitUntilProcessed(`sqs-bet-${runId}`);
  const afterSqs = await call('GET', `/wallets/${walletId}`);
  expectThat(afterSqs.body.balance.amount === '1100.00', 'consumer processou: saldo 1100.00');

  step('Reconciliação: o saldo bate com o ledger');
  const report = await call('POST', `/wallets/${walletId}/reconciliation`);
  expectThat(report.status === 200, 'responde 200');
  expectThat(report.body.consistent === true, 'consistent = true, sem divergências');
  expectThat(
    report.body.storedBalance.amount === report.body.calculatedBalance.amount,
    'saldo gravado = saldo recalculado',
  );
  say(`${report.body.checkedEntries} lançamentos conferidos, versão ${report.body.version}`);

  step(`Métricas desta instância (linhas ${METRICS_PREFIX}*)`);
  const metrics = await call('GET', '/metrics');
  expectThat(metrics.status === 200, 'GET /metrics responde 200');
  const lines = String(metrics.body)
    .split('\n')
    .filter((line) => line.startsWith(METRICS_PREFIX) && !line.includes('_bucket'));
  expectThat(lines.length > 0, 'há métricas wagering_');
  for (const line of lines.slice(0, METRICS_MAX_LINES)) say(line);

  console.log('\nDemonstração concluída: todos os passos se comportaram como esperado.');
}

try {
  await run();
} catch (error) {
  const message = error instanceof DemoFailure ? error.message : String(error);
  console.error(`\nFALHA no passo ${stepNumber}: ${message}`);
  process.exit(1);
}
