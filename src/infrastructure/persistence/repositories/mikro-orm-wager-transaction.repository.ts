import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { WagerTransactionRepository } from '../../../application/ports/wager-transaction.repository';
import type { WagerTransaction } from '../../../domain/wager/wager-transaction';
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
    referenceAttempts: 0,
    nextReferenceAttemptAt: null,
    balanceAfter: tx.balanceAfter?.toJSON().amount ?? null,
    walletVersionAfter: tx.walletVersionAfter ?? null,
    processedAt: tx.processedAt ?? null,
    createdAt: tx.createdAt,
    // a transação nasce já no estado inserido: a última alteração é o processamento, se houve
    updatedAt: tx.processedAt ?? tx.createdAt,
  };
}
