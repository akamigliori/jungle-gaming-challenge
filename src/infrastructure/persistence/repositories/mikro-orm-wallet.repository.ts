import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { WalletRepository } from '../../../application/ports/wallet.repository';
import { WalletAlreadyExistsError } from '../../../application/wallet/wallet-errors';
import { Money } from '../../../domain/shared/money';
import { Wallet } from '../../../domain/wallet/wallet';
import { isUniqueViolation, WALLETS_PLAYER_CURRENCY_UQ } from '../pg-errors';
import { type WalletRecord, WalletSchema } from '../schemas/wallet.schema';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  /** `INSERT` imediato; a unicidade (player, moeda) é garantida pela constraint do banco. */
  async add(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, toRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, WALLETS_PLAYER_CURRENCY_UQ)) {
        throw new WalletAlreadyExistsError(`player already has a ${wallet.currency} wallet`);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record ? toDomain(record) : null;
  }
}

function toRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.from({ amount: r.balance, currency: r.currency }),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}
