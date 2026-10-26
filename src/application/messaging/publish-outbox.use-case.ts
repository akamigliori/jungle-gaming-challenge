import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Clock } from '../ports/clock';
import type { BatchPublishResult, EventPublisher } from '../ports/event-publisher';
import type { Metrics } from '../ports/metrics';
import type { OutboxRepository } from '../ports/outbox.repository';

/** Limite do SQS por chamada de `SendMessageBatch`. */
export const SEND_BATCH_MAX = 10;

export interface PublishOutboxDeps {
  outbox: OutboxRepository;
  publisher: EventPublisher;
  clock: Clock;
  metrics: Metrics;
  /** Máximo de mensagens reservadas por ciclo. */
  batchSize: number;
  /** Por quanto tempo a reserva de um lote impede outra instância de pegá-lo. */
  leaseMs: number;
  /** Máximo de chamadas `SendMessageBatch` simultâneas num ciclo. */
  concurrency: number;
  random?: () => number;
}

/** Mensagem que não saiu neste ciclo: identificadores e o erro, nunca o conteúdo do evento. */
export interface PublishFailure {
  eventId: string;
  eventType: string;
  aggregateId: string;
  /** Tentativas já feitas, contando esta. */
  attempts: number;
  error: unknown;
}

export interface PublishOutboxResult {
  published: number;
  failed: number;
  failures: PublishFailure[];
}

/**
 * Um ciclo do publisher da outbox: reserva um lote de eventos já confirmados no banco e publica
 * tudo em chamadas em lote de até `SEND_BATCH_MAX`, fora de qualquer transação, marcando as
 * publicadas numa única escrita no fim do ciclo. Os pedaços são enviados com concorrência limitada
 * a `concurrency`, sobrepondo a latência do `SendMessageBatch` sem disparar todo o lote de uma vez.
 *
 * - Sucesso → `published_at` (em lote). Falha → nova tentativa com backoff (`scheduleRetry`); a
 *   ordem por wallet continua garantida pelo claim (cabeça por wallet), não por este código.
 * - Uma chamada em lote que nem chega a acontecer (rede) marca o lote inteiro como falho.
 * - Garantia at-least-once: se o processo morrer entre publicar e marcar, a mensagem é publicada
 *   de novo depois do lease, com o mesmo `eventId` (o consumidor deduplica por ele).
 */
export class PublishOutboxUseCase {
  constructor(private readonly deps: PublishOutboxDeps) {}

  async runOnce(): Promise<PublishOutboxResult> {
    const { outbox, clock, batchSize, leaseMs, concurrency } = this.deps;
    const batch = await outbox.claimDue({ now: clock.now(), limit: batchSize, leaseMs });

    const chunks: OutboxMessage[][] = [];
    for (let i = 0; i < batch.length; i += SEND_BATCH_MAX) {
      chunks.push(batch.slice(i, i + SEND_BATCH_MAX));
    }

    const results = await this.publishInParallel(chunks, concurrency);

    const result: PublishOutboxResult = { published: 0, failed: 0, failures: [] };
    const publishedIds: string[] = [];
    for (const chunk of results) {
      publishedIds.push(...chunk.published);
      result.published += chunk.published.length;
      result.failed += chunk.failures.length;
      result.failures.push(...chunk.failures);
    }
    if (publishedIds.length > 0) {
      await outbox.markPublished(publishedIds, clock.now());
    }
    return result;
  }

  /**
   * Envia os pedaços do lote com concorrência limitada a `concurrency`, preservando a ordem dos
   * resultados (índice do pedaço). O limite capa o número de chamadas simultâneas quando o lote é
   * grande, sem abrir mão de sobrepor a latência do `SendMessageBatch` — o gargalo medido.
   */
  private async publishInParallel(
    chunks: OutboxMessage[][],
    concurrency: number,
  ): Promise<Array<{ published: string[]; failures: PublishFailure[] }>> {
    const results = new Array<{ published: string[]; failures: PublishFailure[] }>(chunks.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        if (!chunk) return;
        results[index] = await this.publishChunk(chunk);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Envia um lote (até `SEND_BATCH_MAX`) e registra o resultado: publicadas são devolvidas para o
   * `markPublished`; falhas ganham backoff e `reschedule`, valendo só enquanto o lease é nosso.
   */
  private async publishChunk(
    chunk: OutboxMessage[],
  ): Promise<{ published: string[]; failures: PublishFailure[] }> {
    const { outbox, publisher, clock, metrics, random } = this.deps;
    let outcome: BatchPublishResult;
    try {
      outcome = await publisher.publishBatch(chunk);
    } catch (error) {
      outcome = {
        published: [],
        failed: chunk.map((message) => ({ id: message.id, error: describeError(error) })),
      };
    }

    const failures: PublishFailure[] = [];
    for (const failure of outcome.failed) {
      const message = chunk.find((candidate) => candidate.id === failure.id);
      if (!message) continue;
      // a reserva (lease) é lida antes do backoff, que reescreve o nextAttemptAt da mensagem
      const claimedUntil = message.nextAttemptAt ?? message.occurredAt;
      metrics.retryScheduled('outbox_publish');
      message.scheduleRetry(clock.now(), random);
      await outbox.reschedule(message, { error: failure.error, claimedUntil });
      failures.push({
        eventId: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        attempts: message.attempts,
        error: new Error(failure.error),
      });
    }
    return { published: outcome.published, failures };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
