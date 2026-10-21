import type { WagerTransaction } from '../../domain/wager/wager-transaction';

export interface WagerTransactionRepository {
  add(tx: WagerTransaction): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
