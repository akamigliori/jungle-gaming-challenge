import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  /** Insere a wallet; lança `WalletAlreadyExistsError` se o player já tem wallet nessa moeda. */
  add(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
