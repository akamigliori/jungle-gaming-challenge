import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';

/** Nomes das constraints do schema que a aplicação traduz em erros de negócio. */
export const WALLETS_PLAYER_CURRENCY_UQ = 'wallets_player_currency_uq';
export const WAGER_TX_PROVIDER_IDEM_UQ = 'wager_tx_provider_idem_uq';
export const WAGER_TX_PROVIDER_EXTERNAL_UQ = 'wager_tx_provider_external_uq';
export const WAGER_TX_SINGLE_REVERSAL_UQ = 'wager_tx_single_reversal_uq';

const WAGER_UNIQUE_CONSTRAINTS = [
  WAGER_TX_PROVIDER_IDEM_UQ,
  WAGER_TX_PROVIDER_EXTERNAL_UQ,
  WAGER_TX_SINGLE_REVERSAL_UQ,
];

/** SQLSTATE de falhas que desaparecem ao refazer a transação inteira. */
const TRANSIENT_SQLSTATES = new Set([
  '55P03', // lock_not_available (lock_timeout estourado)
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '57014', // query_canceled (statement_timeout estourado)
]);

/** Códigos de erro de rede/Postgres que indicam banco indisponível (falha transitória). */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '08000',
  '08001',
  '08003',
  '08006',
]);

/** Verdadeiro se o erro é uma violação de `UNIQUE` (SQLSTATE 23505) da constraint indicada. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

/** Verdadeiro se o erro viola uma das constraints de unicidade das transações de aposta. */
export function isWagerUniqueViolation(error: unknown): boolean {
  return WAGER_UNIQUE_CONSTRAINTS.some((constraint) => isUniqueViolation(error, constraint));
}

/** Verdadeiro se o banco está indisponível (falha de conexão ou timeout do pool). */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'KnexTimeoutError') return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

/**
 * Verdadeiro se refazer a transação inteira pode dar certo: lock_timeout, deadlock,
 * falha de serialização ou falha de conexão.
 */
export function isTransientDbError(error: unknown): boolean {
  if (error instanceof LockWaitTimeoutException || error instanceof DeadlockException) return true;
  if (isConnectionError(error)) return true;
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && TRANSIENT_SQLSTATES.has(code);
}
