import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type {
  WalletLedgerReader,
  WalletLedgerSnapshot,
} from '../../../application/ports/wallet-ledger-reader';

interface SnapshotRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  difference: string;
  ledger_balance: string | null;
  matches_last_entry: boolean;
  matches_ledger_sum: boolean;
  version: number;
  ledger_version: number | null;
  entries: number;
  broken_links: number;
  version_gaps: number;
}

/**
 * Todas as somas e comparações de dinheiro acontecem aqui, em `NUMERIC`, e saem como texto. A
 * cadeia do ledger usa `LAG`: cada lançamento deve partir do `balance_after` do anterior (o
 * primeiro parte de zero) e ter a versão do anterior + 1.
 */
const SNAPSHOT_SQL = `
  WITH entries AS (
    SELECT
      direction,
      amount,
      balance_before,
      balance_after,
      wallet_version,
      LAG(balance_after) OVER (ORDER BY wallet_version) AS previous_after,
      LAG(wallet_version) OVER (ORDER BY wallet_version) AS previous_version,
      ROW_NUMBER() OVER (ORDER BY wallet_version DESC) AS reverse_position
    FROM wallet_ledger_entries
    WHERE wallet_id = ?
  ),
  totals AS (
    SELECT
      COUNT(*)::INT AS entries,
      COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::NUMERIC(20,2) AS calculated,
      MAX(wallet_version) AS ledger_version,
      MAX(balance_after) FILTER (WHERE reverse_position = 1) AS last_balance_after,
      COUNT(*) FILTER (WHERE balance_before <> COALESCE(previous_after, 0))::INT AS broken_links,
      COUNT(*) FILTER (WHERE previous_version IS NOT NULL AND wallet_version <> previous_version + 1)::INT AS version_gaps
    FROM entries
  )
  SELECT
    w.id AS wallet_id,
    w.currency,
    w.balance::TEXT AS stored_balance,
    t.calculated::TEXT AS calculated_balance,
    (w.balance - t.calculated)::TEXT AS difference,
    t.last_balance_after::TEXT AS ledger_balance,
    (w.balance = COALESCE(t.last_balance_after, 0)) AS matches_last_entry,
    (w.balance = t.calculated) AS matches_ledger_sum,
    w.version,
    t.ledger_version,
    t.entries,
    t.broken_links,
    t.version_gaps
  FROM wallets w
  CROSS JOIN totals t
  WHERE w.id = ?`;

/**
 * Lê a wallet e o resumo do seu ledger com uma única instrução SQL. No Postgres uma instrução vê
 * um snapshot único mesmo em `READ COMMITTED`, então saldo e ledger são sempre consistentes entre
 * si e a leitura não trava quem escreve. Leitura direta, sem passar pelo agregado.
 */
@Injectable()
export class WalletLedgerQuery implements WalletLedgerReader {
  constructor(private readonly em: EntityManager) {}

  async read(walletId: string): Promise<WalletLedgerSnapshot | null> {
    const [row] = await this.em
      .getConnection()
      .execute<SnapshotRow[]>(SNAPSHOT_SQL, [walletId, walletId], 'all');
    return row ? toSnapshot(row) : null;
  }
}

function toSnapshot(r: SnapshotRow): WalletLedgerSnapshot {
  return {
    walletId: r.wallet_id,
    currency: r.currency,
    storedBalance: r.stored_balance,
    calculatedBalance: r.calculated_balance,
    difference: r.difference,
    ledgerBalance: r.ledger_balance,
    matchesLastEntry: r.matches_last_entry,
    matchesLedgerSum: r.matches_ledger_sum,
    version: r.version,
    ledgerVersion: r.ledger_version,
    entries: r.entries,
    brokenLinks: r.broken_links,
    versionGaps: r.version_gaps,
  };
}
