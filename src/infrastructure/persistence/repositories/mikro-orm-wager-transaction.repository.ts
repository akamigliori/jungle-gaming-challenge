import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type {
  ClaimDuePendingReferencesParams,
  ClaimedPendingReference,
  WagerTransactionRepository,
  WakeDependentsParams,
} from '../../../application/ports/wager-transaction.repository';
import { InvariantViolationError } from '../../../domain/shared/domain-error';
import type { FailureCode } from '../../../domain/shared/failure-code';
import { Money } from '../../../domain/shared/money';
import { WagerTransaction } from '../../../domain/wager/wager-transaction';
import type { WagerTransactionKind } from '../../../domain/wager/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../../domain/wager/wager-transaction-status';
import {
  type WagerTransactionRecord,
  WagerTransactionSchema,
} from '../schemas/wager-transaction.schema';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  /** `INSERT` imediato; idempotência garantida pelas constraints `UNIQUE` do banco. */
  async add(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, toRecord(tx));
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, { id });
    return record ? toDomain(record) : null;
  }

  async findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      idempotencyKey: key,
    });
    return record ? toDomain(record) : null;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return record ? toDomain(record) : null;
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId: transactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  /**
   * Só as colunas que mudam depois do `INSERT`. O filtro `status = 'PENDING_REFERENCE'` garante
   * que nunca sobrescrevemos uma decisão já tomada; 0 linhas significa que o chamador trabalhou
   * sobre um estado velho, o que o lock da wallet deveria ter impedido.
   */
  async update(tx: WagerTransaction, at: Date): Promise<void> {
    const record = toRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id, status: 'PENDING_REFERENCE' },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        referenceAttempts: record.referenceAttempts,
        nextReferenceAttemptAt: record.nextReferenceAttemptAt,
        balanceAfter: record.balanceAfter,
        walletVersionAfter: record.walletVersionAfter,
        processedAt: record.processedAt,
        updatedAt: at,
      },
    );
    if (affected !== 1) {
      throw new InvariantViolationError(`wager transaction ${tx.id} is no longer pending`);
    }
  }

  /**
   * O filtro `> now` evita escrever em linhas que já estão vencidas. Não mexe em
   * `reference_attempts`: acordar não é uma tentativa.
   */
  async wakeDependents({
    walletId,
    providerId,
    externalTransactionId,
    now,
  }: WakeDependentsParams): Promise<void> {
    await this.em.execute(
      `UPDATE wager_transactions
          SET next_reference_attempt_at = ?, updated_at = ?
        WHERE status = 'PENDING_REFERENCE'
          AND wallet_id = ?
          AND provider_id = ?
          AND reference_external_transaction_id = ?
          AND next_reference_attempt_at > ?`,
      [now, now, walletId, providerId, externalTransactionId, now],
      'run',
    );
  }

  /**
   * Mesmo padrão da outbox: `FOR UPDATE SKIP LOCKED` faz duas instâncias nunca reservarem a
   * mesma linha, e o lease gravado no mesmo `COMMIT` tira o lote da consulta das demais.
   */
  async claimDuePendingReferences({
    now,
    limit,
    leaseMs,
  }: ClaimDuePendingReferencesParams): Promise<ClaimedPendingReference[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.em.transactional(async (em) => {
      const due = await em.execute<{ id: string; wallet_id: string }[]>(
        `SELECT id, wallet_id
           FROM wager_transactions
          WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
          ORDER BY next_reference_attempt_at, created_at
          LIMIT ?
            FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (due.length > 0) {
        // o lease é coordenação entre instâncias, não mudança de negócio: não toca em `updated_at`
        await em.execute(
          'UPDATE wager_transactions SET next_reference_attempt_at = ? WHERE id IN (?)',
          [leaseUntil, due.map((row) => row.id)],
        );
      }
      return due;
    });
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }
}

function toDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode as FailureCode | null) ?? undefined,
    processedAt: r.processedAt ?? undefined,
    balanceAfter: r.balanceAfter
      ? Money.from({ amount: r.balanceAfter, currency: r.currency })
      : undefined,
    walletVersionAfter: r.walletVersionAfter ?? undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
  });
}

function toRecord(tx: WagerTransaction): WagerTransactionRecord {
  const money = tx.money.toJSON();
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: money.amount,
    currency: money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
    balanceAfter: tx.balanceAfter?.toJSON().amount ?? null,
    walletVersionAfter: tx.walletVersionAfter ?? null,
    processedAt: tx.processedAt ?? null,
    createdAt: tx.createdAt,
    // a transação nasce já no estado inserido: a última alteração é o processamento, se houve
    updatedAt: tx.processedAt ?? tx.createdAt,
  };
}
