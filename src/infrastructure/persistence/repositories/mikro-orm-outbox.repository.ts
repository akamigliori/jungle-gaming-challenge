import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type {
  ClaimDueParams,
  OutboxRepository,
} from '../../../application/ports/outbox.repository';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { type OutboxRecord, OutboxSchema } from '../schemas/outbox.schema';

/** Tamanho máximo do erro gravado em `last_error`. */
export const LAST_ERROR_MAX_LENGTH = 500;

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  /** `INSERT` na mesma transação da mudança: o evento só existe se ela fizer commit. */
  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxSchema, toRecord(message));
  }

  /**
   * `FOR UPDATE SKIP LOCKED`: duas instâncias reservando ao mesmo tempo nunca pegam a mesma
   * linha (uma pula as que a outra travou). No mesmo `COMMIT`, o `next_attempt_at` vai para
   * `now + lease`, o que tira o lote da consulta das demais sem precisar de coluna de dono.
   */
  async claimDue({ now, limit, leaseMs }: ClaimDueParams): Promise<OutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.em.transactional(async (em) => {
      const due = await em.execute<OutboxRow[]>(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts
           FROM outbox_messages
          WHERE published_at IS NULL AND next_attempt_at <= ?
          ORDER BY occurred_at, id
          LIMIT ?
            FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (due.length > 0) {
        await em.execute('UPDATE outbox_messages SET next_attempt_at = ? WHERE id IN (?)', [
          leaseUntil,
          due.map((row) => row.id),
        ]);
      }
      return due;
    });
    return rows.map((row) => toDomain(row, leaseUntil));
  }

  /** `published_at IS NULL` no filtro: a segunda marcação (corrida após lease vencido) é no-op. */
  async markPublished(id: string, at: Date): Promise<void> {
    await this.em.execute(
      'UPDATE outbox_messages SET published_at = ? WHERE id = ? AND published_at IS NULL',
      [at, id],
    );
  }

  /**
   * Escrita relativa e condicionada: `attempts + 1` no banco e `next_attempt_at <= claimedUntil`
   * no filtro. Se outra instância reservou a linha depois que o nosso lease venceu, o
   * `next_attempt_at` dela é posterior e a falha atrasada não sobrescreve nada.
   */
  async reschedule(
    message: OutboxMessage,
    { error, claimedUntil }: { error: string; claimedUntil: Date },
  ): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
        WHERE id = ? AND published_at IS NULL AND next_attempt_at <= ?`,
      [
        message.nextAttemptAt ?? message.occurredAt,
        error.slice(0, LAST_ERROR_MAX_LENGTH),
        message.id,
        claimedUntil,
      ],
    );
  }

  async postpone(
    ids: string[],
    { until, claimedUntil }: { until: Date; claimedUntil: Date },
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.em.execute(
      `UPDATE outbox_messages
          SET next_attempt_at = ?
        WHERE id IN (?) AND published_at IS NULL AND next_attempt_at <= ?`,
      [until, ids, claimedUntil],
    );
  }
}

/** Linha crua do `SELECT`: o driver devolve `TIMESTAMPTZ` como texto em consultas SQL diretas. */
interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string | Date;
  attempts: number;
}

function toDomain(row: OutboxRow, nextAttemptAt: Date): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt,
  });
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
