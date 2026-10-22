import type { MoneyProps } from '../../domain/shared/money';
import type { WalletLedgerSnapshot } from '../ports/wallet-ledger-reader';

/** Códigos estáveis das divergências, para quem consome a resposta decidir sem ler texto. */
export type ReconciliationIssue =
  | 'BALANCE_DIFFERS_FROM_LAST_ENTRY'
  | 'BALANCE_DIFFERS_FROM_LEDGER_SUM'
  | 'VERSION_DIFFERS_FROM_LEDGER'
  | 'LEDGER_CHAIN_BROKEN'
  | 'LEDGER_VERSION_GAP';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** Saldo gravado menos o calculado; negativo quando o gravado é menor. */
  difference: MoneyProps;
  ledgerBalance: MoneyProps | null;
  version: number;
  ledgerVersion: number | null;
  /** Lançamentos conferidos. */
  checkedEntries: number;
  consistent: boolean;
  issues: ReconciliationIssue[];
  checkedAt: string;
}

/** Versão de uma wallet aberta com saldo zero: não há lançamento, mas a versão já é 1. */
const EMPTY_LEDGER_VERSION = 1;

/** Transforma o resumo lido do banco em divergências; não decide nada sobre dinheiro. */
export function findIssues(s: WalletLedgerSnapshot): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  if (!s.matchesLastEntry) issues.push('BALANCE_DIFFERS_FROM_LAST_ENTRY');
  if (s.difference !== ZERO_AMOUNT) issues.push('BALANCE_DIFFERS_FROM_LEDGER_SUM');
  if (s.version !== (s.ledgerVersion ?? EMPTY_LEDGER_VERSION)) {
    issues.push('VERSION_DIFFERS_FROM_LEDGER');
  }
  if (s.brokenLinks > 0) issues.push('LEDGER_CHAIN_BROKEN');
  if (s.versionGaps > 0) issues.push('LEDGER_VERSION_GAP');
  return issues;
}

/** `NUMERIC(20,2)` sempre sai do banco com duas casas, então a igualdade a zero é textual. */
const ZERO_AMOUNT = '0.00';

export function buildReport(s: WalletLedgerSnapshot, checkedAt: Date): ReconciliationReport {
  const money = (amount: string): MoneyProps => ({ amount, currency: s.currency });
  const issues = findIssues(s);
  return {
    walletId: s.walletId,
    storedBalance: money(s.storedBalance),
    calculatedBalance: money(s.calculatedBalance),
    difference: money(s.difference),
    ledgerBalance: s.ledgerBalance === null ? null : money(s.ledgerBalance),
    version: s.version,
    ledgerVersion: s.ledgerVersion,
    checkedEntries: s.entries,
    consistent: issues.length === 0,
    issues,
    checkedAt: checkedAt.toISOString(),
  };
}
