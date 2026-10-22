import type { WagerTransaction } from '../../domain/wager/wager-transaction';

export interface ClaimDuePendingReferencesParams {
  now: Date;
  limit: number;
  leaseMs: number;
}

/** Pendência reservada pelo worker: basta o id e a wallet que precisa ser travada. */
export interface ClaimedPendingReference {
  id: string;
  walletId: string;
}

export interface WakeDependentsParams {
  walletId: string;
  providerId: string;
  /** Id externo da transação que acabou de chegar a um estado terminal. */
  externalTransactionId: string;
  now: Date;
}

export interface WagerTransactionRepository {
  add(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /** Verdadeiro se existe um REFUND/ROLLBACK `PROCESSED` apontando para a transação. */
  isReversed(transactionId: string): Promise<boolean>;

  /**
   * Grava o novo estado de uma transação que estava `PENDING_REFERENCE` (reagendada ou
   * resolvida). Se a linha não estiver mais pendente, lança `InvariantViolationError`.
   */
  update(tx: WagerTransaction): Promise<void>;

  /**
   * Antecipa para `now` a próxima tentativa das transações pendentes da mesma wallet e provedor
   * que referenciam `externalTransactionId`. Roda na transação da decisão terminal.
   */
  wakeDependents(params: WakeDependentsParams): Promise<void>;

  /**
   * Em transação própria e curta, reserva até `limit` pendências vencidas (mais antigas
   * primeiro), ignorando as que outra instância está reservando, e empurra a próxima tentativa
   * delas para `now + leaseMs`. Se quem reservou morrer, elas voltam quando o prazo vence.
   */
  claimDuePendingReferences(
    params: ClaimDuePendingReferencesParams,
  ): Promise<ClaimedPendingReference[]>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
