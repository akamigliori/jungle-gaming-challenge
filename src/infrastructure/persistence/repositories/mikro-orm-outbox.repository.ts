import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { OutboxRepository } from '../../../application/ports/outbox.repository';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { type OutboxRecord, OutboxSchema } from '../schemas/outbox.schema';

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  /** `INSERT` na mesma transação da mudança: o evento só existe se ela fizer commit. */
  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxSchema, toRecord(message));
  }
}

function toRecord(message: OutboxMessage): OutboxRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
    publishedAt: message.publishedAt ?? null,
    lastError: null,
  };
}
