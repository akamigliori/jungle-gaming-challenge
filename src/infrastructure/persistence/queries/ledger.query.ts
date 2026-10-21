import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '../../../domain/shared/money';
import { type LedgerEntryRecord, LedgerEntrySchema } from '../schemas/ledger-entry.schema';

export interface LedgerItemDto {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItemDto[];
  /** Versão do último item, se existir uma próxima página; senão `null`. */
  nextVersion: number | null;
}

/**
 * Leitura paginada do ledger direto do banco (sem passar pelo agregado). A ordem é a
 * `wallet_version`, que é única e sequencial por wallet: a paginação é estável mesmo
 * com novos lançamentos chegando.
 */
@Injectable()
export class LedgerQuery {
  constructor(private readonly em: EntityManager) {}

  async page(walletId: string, afterVersion: number | null, limit: number): Promise<LedgerPage> {
    // busca um item a mais só para saber se existe próxima página
    const records = await this.em.find(
      LedgerEntrySchema,
      afterVersion === null ? { walletId } : { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit: limit + 1, disableIdentityMap: true },
    );
    const hasMore = records.length > limit;
    const items = records.slice(0, limit).map(toDto);
    const last = items.at(-1);
    return { items, nextVersion: hasMore && last ? last.walletVersion : null };
  }
}

function toDto(r: LedgerEntryRecord): LedgerItemDto {
  const money = (amount: string) => Money.from({ amount, currency: r.currency }).toJSON();
  return {
    id: r.id,
    transactionId: r.transactionId,
    direction: r.direction,
    money: money(r.amount),
    balanceBefore: money(r.balanceBefore),
    balanceAfter: money(r.balanceAfter),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt.toISOString(),
  };
}
