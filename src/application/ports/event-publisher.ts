import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Falha individual de uma entrada de um lote enviado. */
export interface BatchPublishFailure {
  id: string;
  error: string;
}

/** Resultado de `publishBatch`: ids confirmados e as entradas que falharam, sem lançar. */
export interface BatchPublishResult {
  published: string[];
  failed: BatchPublishFailure[];
}

/**
 * Publica eventos da outbox no broker, em lote (até 10 mensagens por chamada do SQS). Devolve o
 * resultado por entrada em vez de lançar; só lança se a chamada em si não aconteceu (rede).
 */
export interface EventPublisher {
  publishBatch(messages: OutboxMessage[]): Promise<BatchPublishResult>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
