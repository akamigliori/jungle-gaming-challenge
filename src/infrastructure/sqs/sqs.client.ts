import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/** Tempo máximo para abrir a conexão e para receber a resposta de cada chamada ao SQS. */
const CONNECTION_TIMEOUT_MS = 1000;
const REQUEST_TIMEOUT_MS = 1500;

/**
 * Cliente SQS apontando para o endpoint configurado (LocalStack em ambiente local).
 * Sem retry interno do SDK: quem chama decide se e quando tentar de novo, e um SQS fora
 * do ar falha rápido em vez de travar a requisição.
 */
export function createSqsClient(cfg: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: cfg.sqs.endpoint,
    region: cfg.sqs.region,
    credentials: { accessKeyId: cfg.sqs.accessKeyId, secretAccessKey: cfg.sqs.secretAccessKey },
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}
