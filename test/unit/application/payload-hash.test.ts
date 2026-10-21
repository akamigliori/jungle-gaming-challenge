import { describe, expect, test } from 'bun:test';
import type { WagerPayload } from '../../../src/application/wager/payload-hash';
import { canonicalJson, computePayloadHash } from '../../../src/application/wager/payload-hash';
import { InvalidMoneyError } from '../../../src/domain/shared/domain-error';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind';

const payload = (over: Partial<WagerPayload> = {}): WagerPayload => ({
  providerId: 'prov',
  externalTransactionId: 'ext-1',
  playerId: 'p-1',
  walletId: 'w-1',
  roundId: 'r-1',
  gameId: 'g-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
  ...over,
});

describe('payload hash', () => {
  test('key order does not change hash', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: WagerTransactionKind.Bet,
      gameId: 'g-1',
      roundId: 'r-1',
      walletId: 'w-1',
      playerId: 'p-1',
      externalTransactionId: 'ext-1',
      providerId: 'prov',
    } as WagerPayload;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload()));
  });

  test('different payload -> different hash (amount 25.00 vs 25.01)', () => {
    const other = payload({ money: { amount: '25.01', currency: 'BRL' } });
    expect(computePayloadHash(other)).not.toBe(computePayloadHash(payload()));
  });

  test('undefined reference is omitted: same hash as payload without the key', () => {
    const withUndefined = payload({ referenceExternalTransactionId: undefined });
    expect(computePayloadHash(withUndefined)).toBe(computePayloadHash(payload()));
    expect(canonicalJson(withUndefined)).not.toContain('referenceExternalTransactionId');
  });

  test('hash is 64 lowercase hex chars', () => {
    expect(computePayloadHash(payload())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('equivalent amounts hash identically ("25.5" = "25.50", "007.50" = "7.50")', () => {
    const h = (amount: string) =>
      computePayloadHash(payload({ money: { amount, currency: 'BRL' } }));
    expect(h('25.5')).toBe(h('25.50'));
    expect(h('007.50')).toBe(h('7.50'));
  });

  test('invalid money throws InvalidMoneyError', () => {
    expect(() =>
      computePayloadHash(payload({ money: { amount: '1.005', currency: 'BRL' } })),
    ).toThrow(InvalidMoneyError);
  });
});
