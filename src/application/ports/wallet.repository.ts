import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  /** Insere a wallet; lança `WalletAlreadyExistsError` se o player já tem wallet nessa moeda. */
  add(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
  /**
   * Lê a wallet com `SELECT ... FOR UPDATE`, travando só essa linha até o fim da transação.
   * Só vale dentro de `TransactionRunner.run`. Espera no máximo o `lock_timeout` configurado
   * (erro transitório se estourar).
   */
  lockById(id: string): Promise<Wallet | null>;
  /**
   * Grava saldo e versão da wallet travada. Lança `InvariantViolationError` se a versão no banco
   * não for `expectedVersion` (indica uso sem o lock).
   */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
