import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/shared/money';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** JSON com as chaves ordenadas recursivamente; propriedades de objeto com valor undefined são descartadas. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Normaliza o valor monetário antes, para que "25.5" e "25.50" sejam o mesmo payload. Valor monetário inválido lança erro. */
export function computePayloadHash(p: WagerPayload): string {
  return createHash('sha256')
    .update(canonicalJson({ ...p, money: Money.from(p.money).toJSON() }))
    .digest('hex');
}
