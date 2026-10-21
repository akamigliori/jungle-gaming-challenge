import { UniqueConstraintViolationException } from '@mikro-orm/core';

/** Nomes das constraints do schema que a aplicação traduz em erros de negócio. */
export const WALLETS_PLAYER_CURRENCY_UQ = 'wallets_player_currency_uq';

/** Verdadeiro se o erro é uma violação de `UNIQUE` (SQLSTATE 23505) da constraint indicada. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}
