import type { WagerTransaction } from '../../domain/wager/wager-transaction';

export interface WagerTransactionRepository {
  add(tx: WagerTransaction): Promise<void>;
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /** Verdadeiro se existe um REFUND/ROLLBACK `PROCESSED` apontando para a transação. */
  isReversed(transactionId: string): Promise<boolean>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
