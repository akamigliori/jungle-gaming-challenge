import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { WagerTransactionRepository } from '../../../application/ports/wager-transaction.repository';
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
