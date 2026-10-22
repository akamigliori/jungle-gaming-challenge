import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Clock } from '../ports/clock';
import type { EventPublisher } from '../ports/event-publisher';
import type { OutboxRepository } from '../ports/outbox.repository';

export interface PublishOutboxDeps {
  outbox: OutboxRepository;
  publisher: EventPublisher;
  clock: Clock;
  /** Máximo de mensagens reservadas por ciclo. */
  batchSize: number;
  /** Por quanto tempo a reserva de um lote impede outra instância de pegá-lo. */
  leaseMs: number;
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
 * Um ciclo do publisher da outbox: reserva um lote de eventos já confirmados no banco,
 * publica cada um fora de qualquer transação e registra o resultado.
 *
 * - Sucesso → `published_at`. Falha → nova tentativa com backoff (`scheduleRetry`); uma
 *   mensagem com erro não impede as outras wallets do lote.
 * - Mensagens da mesma wallet saem em sequência, na ordem do lote; wallets diferentes em paralelo.
 *   Se uma mensagem falha, as seguintes da mesma wallet ficam para o próximo ciclo, junto com ela.
 * - Garantia at-least-once: se o processo morrer entre publicar e marcar, a mensagem é publicada
 *   de novo depois do lease, com o mesmo `eventId` (o consumidor deduplica por ele).
 */
export class PublishOutboxUseCase {
  constructor(private readonly deps: PublishOutboxDeps) {}

  async runOnce(): Promise<PublishOutboxResult> {
    const { outbox, clock, batchSize, leaseMs } = this.deps;
    const batch = await outbox.claimDue({ now: clock.now(), limit: batchSize, leaseMs });

    const outcomes = await Promise.allSettled(
      groupByAggregate(batch).map((group) => this.publishGroup(group)),
    );

    const result: PublishOutboxResult = { published: 0, failed: 0, failures: [] };
    for (const outcome of outcomes) {
      // rejeição aqui é erro do banco ao registrar o resultado: sobe para o ciclo logar
      if (outcome.status === 'rejected') throw outcome.reason;
      result.published += outcome.value.published;
      result.failed += outcome.value.failed;
      result.failures.push(...outcome.value.failures);
    }
    return result;
  }

  /**
   * Publica as mensagens de uma wallet em ordem. Na primeira falha, para a wallet neste ciclo:
   * a que falhou ganha backoff e as seguintes são adiadas para o mesmo horário, para que nenhuma
   * saia antes dela.
   */
  private async publishGroup(group: OutboxMessage[]): Promise<PublishOutboxResult> {
    const { outbox } = this.deps;
    const result: PublishOutboxResult = { published: 0, failed: 0, failures: [] };
    for (const [index, message] of group.entries()) {
      // reserva feita pelo claim; usada para não sobrescrever uma reserva de outra instância
      const claimedUntil = message.nextAttemptAt ?? message.occurredAt;
      const failure = await this.publishOne(message, claimedUntil);
      if (!failure) {
        result.published += 1;
        continue;
      }
      result.failed += 1;
      result.failures.push(failure);
      const rest = group.slice(index + 1).map((m) => m.id);
      const until = message.nextAttemptAt ?? claimedUntil;
      await outbox.postpone(rest, { until, claimedUntil });
      break;
    }
    return result;
  }

  /** `undefined` quando publicou; senão, a falha (a mensagem já foi reagendada). */
  private async publishOne(
    message: OutboxMessage,
    claimedUntil: Date,
  ): Promise<PublishFailure | undefined> {
    const { outbox, publisher, clock, random } = this.deps;
    try {
      await publisher.publish(message);
    } catch (error) {
      message.scheduleRetry(clock.now(), random);
      await outbox.reschedule(message, { error: describeError(error), claimedUntil });
      return {
        eventId: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        attempts: message.attempts,
        error,
      };
    }
    await outbox.markPublished(message.id, clock.now());
    return undefined;
  }
}

/** Agrupa por wallet mantendo a ordem do lote dentro de cada grupo. */
function groupByAggregate(batch: OutboxMessage[]): OutboxMessage[][] {
  const groups = new Map<string, OutboxMessage[]>();
  for (const message of batch) {
    const group = groups.get(message.aggregateId);
    if (group) group.push(message);
    else groups.set(message.aggregateId, [message]);
  }
  return [...groups.values()];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
