/**
 * Mede o custo do SQS emulado (LocalStack) **isoladamente**: envia e consome mensagens direto no
 * emulador, sem banco nem aplicação. Serve para separar quanto da latência de publicação é do
 * serviço emulado e quanto é da aplicação/banco no teste de carga ponta a ponta (`scripts/load.ts`).
 *
 * Cria uma fila FIFO própria por execução (`wagering-bench-<id>.fifo`), com os mesmos atributos das
 * filas reais, para não poluir as filas da aplicação; apaga no fim. Cada execução mede as duas
 * fases: publicação (`SendMessageBatch`, lote de 10, concorrência limitada) e consumo
 * (`ReceiveMessage` + `DeleteMessageBatch`, lote de 10).
 *
 * Uso: `bun scripts/sqs-bench.ts [--messages N] [--concurrency C] [--groups G] [--json]`.
 * O resultado é o do emulador local, não o teto da AWS.
 */
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/infrastructure/config/config';
import { createSqsClient } from '../src/infrastructure/sqs/sqs.client';

const SEND_BATCH_MAX = 10;
const RECEIVE_BATCH_MAX = 10;
/** Quantos receives vazios seguidos indicam que a fila esvaziou (o long poll devolve vazio). */
const EMPTY_RECEIVES_BEFORE_STOP = 3;
const RECEIVE_WAIT_SECONDS = 1;
const DRAIN_TIMEOUT_MS = 120_000;

const MESSAGES = argInt('--messages', 2000);
const CONCURRENCY = argInt('--concurrency', 5);
const GROUPS = argInt('--groups', 100);
const JSON_OUTPUT = process.argv.includes('--json');
const RUN_ID = crypto.randomUUID().slice(0, 8);
const QUEUE_NAME = `wagering-bench-${RUN_ID}.fifo`;

interface PhaseResult {
  messages: number;
  errors: number;
  elapsedSeconds: number;
  latenciesMs: number[];
}

function argInt(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function log(text = ''): void {
  (JSON_OUTPUT ? console.error : console.log)(text);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function summarize(result: PhaseResult): Record<string, number> {
  const sorted = [...result.latenciesMs].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    messages: result.messages,
    errors: result.errors,
    elapsedSeconds: round(result.elapsedSeconds),
    throughputPerSecond:
      result.elapsedSeconds > 0 ? round(result.messages / result.elapsedSeconds) : 0,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

async function publish(client: SQSClient, queueUrl: string): Promise<PhaseResult> {
  const batches = Math.ceil(MESSAGES / SEND_BATCH_MAX);
  const latenciesMs: number[] = [];
  let messages = 0;
  let errors = 0;
  let next = 0;

  const started = performance.now();
  const workers = Array.from({ length: Math.min(CONCURRENCY, batches) }, async () => {
    for (;;) {
      const batch = next;
      next += 1;
      if (batch >= batches) return;

      const entries = [];
      for (let offset = 0; offset < SEND_BATCH_MAX; offset += 1) {
        const index = batch * SEND_BATCH_MAX + offset;
        if (index >= MESSAGES) break;
        entries.push({
          Id: `m${index}`,
          MessageBody: JSON.stringify({ bench: true, index }),
          // espalha por MessageGroupId para exercitar o perMessageQueueId das filas FIFO reais
          MessageGroupId: `group-${index % GROUPS}`,
          MessageDeduplicationId: `bench-${RUN_ID}-${index}`,
        });
      }

      const sentAt = performance.now();
      try {
        await client.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
        messages += entries.length;
        latenciesMs.push(performance.now() - sentAt);
      } catch {
        errors += entries.length;
      }
    }
  });
  await Promise.all(workers);

  return { messages, errors, elapsedSeconds: (performance.now() - started) / 1000, latenciesMs };
}

async function consume(client: SQSClient, queueUrl: string): Promise<PhaseResult> {
  const latenciesMs: number[] = [];
  let messages = 0;
  let errors = 0;
  let emptyReceives = 0;

  const started = performance.now();
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (
    messages < MESSAGES &&
    Date.now() < deadline &&
    emptyReceives < EMPTY_RECEIVES_BEFORE_STOP
  ) {
    const receivedAt = performance.now();
    try {
      const received = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: RECEIVE_BATCH_MAX,
          WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
        }),
      );
      const batch = received.Messages ?? [];
      if (batch.length === 0) {
        emptyReceives += 1;
        continue;
      }
      emptyReceives = 0;
      await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((message, index) => ({
            Id: `d${index}`,
            ReceiptHandle: message.ReceiptHandle as string,
          })),
        }),
      );
      messages += batch.length;
      latenciesMs.push(performance.now() - receivedAt);
    } catch {
      errors += 1;
    }
  }

  return {
    messages,
    errors,
    elapsedSeconds: (performance.now() - started) / 1000,
    latenciesMs,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = createSqsClient(cfg);

  const created = await client.send(
    new CreateQueueCommand({
      QueueName: QUEUE_NAME,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        FifoThroughputLimit: 'perMessageQueueId',
        DeduplicationScope: 'messageGroup',
        VisibilityTimeout: '60',
      },
    }),
  );
  const queueUrl = created.QueueUrl as string;

  try {
    log(
      `SQS isolado (LocalStack) — ${MESSAGES} mensagens, concorrência ${CONCURRENCY}, ${GROUPS} grupos`,
    );
    log(`Fila: ${QUEUE_NAME}`);
    log();

    const publishResult = await publish(client, queueUrl);
    const consumeResult = await consume(client, queueUrl);

    const summary = {
      ok: publishResult.errors === 0 && consumeResult.errors === 0,
      environment: {
        endpoint: cfg.sqs.endpoint,
        messages: MESSAGES,
        concurrency: CONCURRENCY,
        groups: GROUPS,
        note: 'emulador LocalStack; não é o teto da AWS',
      },
      publish: summarize(publishResult),
      consume: summarize(consumeResult),
    };

    if (JSON_OUTPUT) {
      log(JSON.stringify(summary, null, 2));
      return;
    }

    const line = (label: string, value: string) => log(`  ${label.padEnd(22)} ${value}`);
    log('Publicação (SendMessageBatch, lote de 10)');
    line('Mensagens publicadas', String(summary.publish.messages));
    line('Throughput', `${summary.publish.throughputPerSecond} msg/s`);
    line(
      'Latência por lote',
      `p50 ${summary.publish.p50Ms} · p95 ${summary.publish.p95Ms} · p99 ${summary.publish.p99Ms} · máx ${summary.publish.maxMs} ms`,
    );
    line('Erros', String(summary.publish.errors));
    log();
    log('Consumo (ReceiveMessage + DeleteMessageBatch, lote de 10)');
    line('Mensagens consumidas', String(summary.consume.messages));
    line('Throughput', `${summary.consume.throughputPerSecond} msg/s`);
    line(
      'Latência por lote',
      `p50 ${summary.consume.p50Ms} · p95 ${summary.consume.p95Ms} · p99 ${summary.consume.p99Ms} · máx ${summary.consume.maxMs} ms`,
    );
    line('Erros', String(summary.consume.errors));
    log();
    log(`Veredito: ${summary.ok ? 'OK' : 'FALHOU (houve erros)'}`);
  } finally {
    await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
    client.destroy();
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
