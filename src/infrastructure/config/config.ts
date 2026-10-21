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
      transactions: 'wager-transactions.fifo';
      transactionsDlq: 'wager-transactions-dlq.fifo';
      events: 'wagering-events.fifo';
    };
  };
  logLevel: string;
}

const envSchema = z.object({
  DB_HOST: z.string().min(1).default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5433),
  DB_USER: z.string().min(1).default('wagering'),
  DB_PASSWORD: z.string().min(1).default('wagering'),
  DB_NAME: z.string().min(1).default('wagering'),
  SQS_ENDPOINT: z.string().min(1).default('http://localhost:4566'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().min(1).default('info'),
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
        transactions: 'wager-transactions.fifo',
        transactionsDlq: 'wager-transactions-dlq.fifo',
        events: 'wagering-events.fifo',
      },
    },
    logLevel: e.LOG_LEVEL,
  };
}

/** Token de injeção da configuração já validada. */
export const APP_CONFIG = Symbol('APP_CONFIG');
