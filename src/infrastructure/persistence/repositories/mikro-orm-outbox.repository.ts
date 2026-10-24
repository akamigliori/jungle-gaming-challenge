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
   *
   * O filtro `NOT EXISTS` garante a ordem estrita por wallet: um `WalletBalanceChanged` só é
   * elegível quando nenhuma versão anterior da mesma wallet ainda está não publicada. Enquanto a
   * cabeça (menor `wallet_version`) está em voo — mesmo travada por outra instância —, as versões
   * seguintes não aparecem para ninguém, então nenhum publisher as ultrapassa.
   *
   * A ordem por `next_attempt_at` (em vez de `occurred_at`) usa o índice parcial
   * `outbox_unpublished_idx` e evita ordenar todo o backlog pendente a cada ciclo; como a ordem
   * por wallet já vem do `NOT EXISTS`, `occurred_at` é redundante aqui.
   */
  async claimDue({ now, limit, leaseMs }: ClaimDueParams): Promise<OutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.em.transactional(async (em) => {
      const due = await em.execute<OutboxRow[]>(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, wallet_version
           FROM outbox_messages o
          WHERE o.published_at IS NULL AND o.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM outbox_messages prev
              WHERE prev.aggregate_id = o.aggregate_id
                AND prev.published_at IS NULL
                AND prev.wallet_version IS NOT NULL
                AND o.wallet_version IS NOT NULL
                AND prev.wallet_version < o.wallet_version
            )
          ORDER BY o.next_attempt_at, o.id
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

  /**
   * Deleção em lote, do mais antigo para o mais novo, dentro de uma transação curta: `LIMIT` no
   * `IN` evita apagar muita coisa de uma vez e estourar o `statement_timeout`. Só toca linhas já
   * publicadas (`published_at IS NOT NULL`), nunca eventos ainda em retry.
   */
  async deletePublishedOlderThan(cutoff: Date, limit: number): Promise<number> {
    const deleted = await this.em.execute<{ id: string }[]>(
      `DELETE FROM outbox_messages
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NOT NULL AND published_at < ?
           ORDER BY published_at
           LIMIT ?
        )
        RETURNING id`,
      [cutoff, limit],
    );
    return deleted.length;
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
  wallet_version: number | null;
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
    walletVersion: row.wallet_version ?? undefined,
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
    walletVersion: message.walletVersion ?? null,
  };
}
