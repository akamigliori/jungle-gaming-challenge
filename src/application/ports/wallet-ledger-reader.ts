/**
 * Leitura da wallet junto com o resumo do seu ledger, tirada de um único snapshot consistente.
 * As comparações de dinheiro já vêm feitas pelo banco em `NUMERIC`; aqui os valores são strings.
 */
export interface WalletLedgerSnapshot {
  walletId: string;
  currency: string;
  /** Saldo gravado em `wallets`. */
  storedBalance: string;
  /** Soma assinada dos lançamentos (crédito +, débito −), a partir de zero. */
  calculatedBalance: string;
  /** `storedBalance − calculatedBalance`, calculado em `NUMERIC`; pode ser negativo. */
  difference: string;
  /** `balance_after` do último lançamento; `null` se o ledger está vazio. */
  ledgerBalance: string | null;
  /** O saldo gravado é igual ao `balance_after` do último lançamento (ou a zero, sem lançamentos). */
  matchesLastEntry: boolean;
  /** O saldo gravado é igual à soma assinada dos lançamentos. */
  matchesLedgerSum: boolean;
  /** Versão gravada em `wallets`. */
  version: number;
  /** Maior `wallet_version` do ledger; `null` se o ledger está vazio. */
  ledgerVersion: number | null;
  entries: number;
  /** Lançamentos cujo `balance_before` não é o `balance_after` do anterior (o primeiro parte de zero). */
  brokenLinks: number;
  /** Lançamentos cuja versão não é a do anterior + 1. */
  versionGaps: number;
}

export interface WalletLedgerReader {
  /** `null` se a wallet não existe. */
  read(walletId: string): Promise<WalletLedgerSnapshot | null>;
}

export const WALLET_LEDGER_READER = Symbol('WALLET_LEDGER_READER');
