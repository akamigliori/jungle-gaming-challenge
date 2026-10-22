import { z } from 'zod';

export type Env = Record<string, string | undefined>;

export interface AppConfig {
  port: number;
  db: { host: string; port: number; user: string; password: string; name: string };
  sqs: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    queues: {
      transactions: string;
      transactionsDlq: string;
      events: string;
    };
  };
  outboxPublisher: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
  };
  consumer: {
    enabled: boolean;
    /** Laços de recebimento independentes por instância. */
    loops: number;
    /** Máximo de mensagens por recebimento (limite do SQS: 10). */
    batchSize: number;
    /** Duração do long polling (limite do SQS: 20 s). */
    waitTimeSeconds: number;
    /** Prazo para as mensagens em andamento terminarem no shutdown. */
    shutdownTimeoutMs: number;
  };
  logLevel: string;
}

/** Folga do timeout HTTP do long poll sobre o `WaitTimeSeconds`. */
export const LONG_POLL_TIMEOUT_MARGIN_MS = 5000;
const MS_PER_SECOND = 1000;

const fieldsSchema = z.object({
  DB_HOST: z.string().min(1).default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5433),
  DB_USER: z.string().min(1).default('wagering'),
  DB_PASSWORD: z.string().min(1).default('wagering'),
  DB_NAME: z.string().min(1).default('wagering'),
  SQS_ENDPOINT: z.string().min(1).default('http://localhost:4566'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_TRANSACTIONS_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().min(1).default('wagering-events.fifo'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().min(1).default('info'),
  // `stringbool` aceita "true"/"false" (e "1"/"0"); `coerce.boolean` trataria "false" como verdadeiro
  OUTBOX_PUBLISHER_ENABLED: z.stringbool().default(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  SQS_CONSUMER_ENABLED: z.stringbool().default(true),
  SQS_CONSUMER_LOOPS: z.coerce.number().int().positive().default(2),
  // 2 laços × 4 mensagens = 8 transações ao mesmo tempo, deixando conexões do pool de 10 para HTTP e workers
  SQS_RECEIVE_BATCH_SIZE: z.coerce.number().int().positive().max(10).default(4),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

// o shutdown espera o long poll em andamento terminar: o prazo tem de cobri-lo
const envSchema = fieldsSchema.superRefine((e, ctx) => {
  const longPollMs = e.SQS_WAIT_TIME_SECONDS * MS_PER_SECOND + LONG_POLL_TIMEOUT_MARGIN_MS;
  if (e.SHUTDOWN_TIMEOUT_MS < longPollMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['SHUTDOWN_TIMEOUT_MS'],
      message: `must be >= SQS_WAIT_TIME_SECONDS * 1000 + ${LONG_POLL_TIMEOUT_MARGIN_MS} (${longPollMs})`,
    });
  }
});

/** Lê e valida as variáveis de ambiente; os defaults servem ao ambiente local do docker-compose. */
export function loadConfig(env: Env = process.env): AppConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      name: e.DB_NAME,
    },
    sqs: {
      endpoint: e.SQS_ENDPOINT,
      region: e.AWS_REGION,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
      queues: {
        transactions: e.SQS_TRANSACTIONS_QUEUE,
        transactionsDlq: e.SQS_TRANSACTIONS_DLQ,
        events: e.SQS_EVENTS_QUEUE,
      },
    },
    outboxPublisher: {
      enabled: e.OUTBOX_PUBLISHER_ENABLED,
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
    },
    consumer: {
      enabled: e.SQS_CONSUMER_ENABLED,
      loops: e.SQS_CONSUMER_LOOPS,
      batchSize: e.SQS_RECEIVE_BATCH_SIZE,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    },
    logLevel: e.LOG_LEVEL,
  };
}

/** Token de injeção da configuração já validada. */
export const APP_CONFIG = Symbol('APP_CONFIG');
