import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/** Ledger append-only: só existe inserção. */
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
