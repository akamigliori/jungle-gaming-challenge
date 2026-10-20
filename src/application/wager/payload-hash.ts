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

/** JSON with keys sorted recursively; undefined object properties are dropped. */
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

/** Normalizes money first, so "25.5" and "25.50" are the same payload. Invalid money throws. */
export function computePayloadHash(p: WagerPayload): string {
  return createHash('sha256')
    .update(canonicalJson({ ...p, money: Money.from(p.money).toJSON() }))
    .digest('hex');
}
