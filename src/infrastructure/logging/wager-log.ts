import type { WagerTransaction } from '../../domain/wager/wager-transaction';

/**
 * Campos de log do resultado de uma transação de aposta: só identificadores e estado, nunca o
 * valor nem o payload. `walletId` e `providerId` entram pelo contexto de quem loga.
 */
export function wagerOutcomeFields(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
  startedAt: number,
) {
  return {
    transactionId: transaction.id,
    kind: transaction.kind,
    status: transaction.status,
    failureCode: transaction.failureCode,
    idempotentReplay,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
