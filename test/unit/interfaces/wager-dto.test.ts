import { describe, expect, test } from 'bun:test';
import {
  idempotencyKeySchema,
  submitWagerBodySchema,
} from '../../../src/interfaces/http/wagering/wager.dto';

const UPPER_WALLET = '0192F291-27DD-7D3F-8071-5F8685DEEF37';
const UPPER_PLAYER = '0192F28F-5DC0-7D58-BDB2-814AD6A0F4A1';

const body = (over: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: UPPER_PLAYER,
  walletId: UPPER_WALLET,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...over,
});

describe('submitWagerBodySchema', () => {
  test('lowercases walletId and playerId', () => {
    const parsed = submitWagerBodySchema.parse(body());
    expect(parsed.walletId).toBe(UPPER_WALLET.toLowerCase());
    expect(parsed.playerId).toBe(UPPER_PLAYER.toLowerCase());
  });

  test('rejects unknown keys inside money', () => {
    expect(() =>
      submitWagerBodySchema.parse(body({ money: { amount: '1.00', currency: 'BRL', extra: 1 } })),
    ).toThrow();
  });

  test('rejects unknown keys', () => {
    expect(() => submitWagerBodySchema.parse(body({ extra: 1 }))).toThrow();
  });

  test('rejects a numeric money amount', () => {
    expect(() =>
      submitWagerBodySchema.parse(body({ money: { amount: 25, currency: 'BRL' } })),
    ).toThrow();
  });

  test('rejects an unknown kind and the reserved OPENING kind', () => {
    expect(() => submitWagerBodySchema.parse(body({ kind: 'TIP' }))).toThrow();
    expect(() => submitWagerBodySchema.parse(body({ kind: 'OPENING' }))).toThrow();
  });

  test('accepts an optional reference and rejects an empty one', () => {
    expect(
      submitWagerBodySchema.parse(body({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }))
        .referenceExternalTransactionId,
    ).toBe('bet-1');
    expect(() =>
      submitWagerBodySchema.parse(body({ referenceExternalTransactionId: '' })),
    ).toThrow();
  });
});

describe('idempotencyKeySchema', () => {
  test('trims and accepts 1 to 255 chars', () => {
    expect(idempotencyKeySchema.parse('  k  ')).toBe('k');
    expect(idempotencyKeySchema.parse('a'.repeat(255))).toHaveLength(255);
  });

  test('rejects missing, blank and too long', () => {
    expect(() => idempotencyKeySchema.parse(undefined)).toThrow();
    expect(() => idempotencyKeySchema.parse('   ')).toThrow();
    expect(() => idempotencyKeySchema.parse('a'.repeat(256))).toThrow();
  });
});
