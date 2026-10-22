import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '../../../domain/shared/money';
import {
  type WagerTransactionRecord,
  WagerTransactionSchema,
} from '../schemas/wager-transaction.schema';

export interface WagerTransactionDto {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

/** Consultas de transações de aposta direto do banco (sem passar pelo agregado). */
@Injectable()
export class WagerTransactionQuery {
  constructor(private readonly em: EntityManager) {}

  async findById(transactionId: string): Promise<WagerTransactionDto | null> {
    return this.findOne({ id: transactionId });
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionDto | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  private async findOne(
    where: Partial<Pick<WagerTransactionRecord, 'id' | 'providerId' | 'externalTransactionId'>>,
  ): Promise<WagerTransactionDto | null> {
    const record = await this.em.findOne(WagerTransactionSchema, where, {
      disableIdentityMap: true,
    });
    return record ? toDto(record) : null;
  }
}

function toDto(r: WagerTransactionRecord): WagerTransactionDto {
  const money = (amount: string) => Money.from({ amount, currency: r.currency }).toJSON();
  return {
    transactionId: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind,
    money: money(r.amount),
    status: r.status,
    failureCode: r.failureCode,
    referenceTransactionId: r.referenceTransactionId,
    balanceAfter: r.balanceAfter === null ? null : money(r.balanceAfter),
    createdAt: r.createdAt.toISOString(),
    processedAt: r.processedAt?.toISOString() ?? null,
  };
}
