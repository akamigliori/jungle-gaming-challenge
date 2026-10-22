import { describe, expect, test } from 'bun:test';
import { createWalletBodySchema } from '../../../src/interfaces/http/wallets/wallet.dto';

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

describe('createWalletBodySchema', () => {
  test('accepts a well-formed body', () => {
    expect(() =>
      createWalletBodySchema.parse({
        playerId: PLAYER_ID,
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }),
    ).not.toThrow();
  });

  test('rejects unknown keys inside initialBalance', () => {
    expect(() =>
      createWalletBodySchema.parse({
        playerId: PLAYER_ID,
        initialBalance: { amount: '1.00', currency: 'BRL', extra: 1 },
      }),
    ).toThrow();
  });
});
