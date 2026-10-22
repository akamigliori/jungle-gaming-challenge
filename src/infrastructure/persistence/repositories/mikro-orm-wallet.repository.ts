import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { WalletRepository } from '../../../application/ports/wallet.repository';
import { WalletAlreadyExistsError } from '../../../application/wallet/wallet-errors';
import { InvariantViolationError } from '../../../domain/shared/domain-error';
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

  /**
   * `lock_timeout` e `FOR UPDATE` passam pelo `EntityManager` global, que dentro de
   * `TransactionRunner.run` usa a conexão da transação: o lock dura até o commit/rollback.
   * `SET LOCAL` também vale só até o fim da transação.
   */
  async lockById(id: string): Promise<Wallet | null> {
    await this.em.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const rows = await this.em.execute<WalletRow[]>(
      'SELECT id, player_id, currency, balance, version, created_at, updated_at FROM wallets WHERE id = ? FOR UPDATE',
      [id],
    );
    const row = rows[0];
    return row ? toDomain(fromRow(row)) : null;
  }

  /** O `WHERE version = ?` é a segunda defesa: se o lock faltou, nenhuma linha é alterada. */
  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (updated === 0) {
      throw new InvariantViolationError('wallet version changed under lock');
    }
  }
}

/** Tempo máximo esperando o lock de uma wallet antes de falhar com erro transitório. */
const LOCK_TIMEOUT = '2s';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function fromRow(r: WalletRow): WalletRecord {
  return {
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: r.balance,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
