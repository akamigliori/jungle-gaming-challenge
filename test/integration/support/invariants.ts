import type { MikroORM } from '@mikro-orm/postgresql';

interface DivergentWallet {
  id: string;
  balance: string;
  version: number;
  ledger_sum: string;
  entries: string;
  min_version: number | null;
  max_version: number | null;
}

/**
 * Confere, em SQL (aritmética `numeric`, sem ponto flutuante), para toda wallet:
 * - saldo = Σ CREDIT − Σ DEBIT do ledger;
 * - versões do ledger contínuas e terminando na versão da wallet. Começam em 1 quando a wallet
 *   abriu com saldo (crédito de abertura) ou em 2 quando abriu zerada (a versão 1 é a criação
 *   sem lançamento); sem lançamentos, a wallet está na versão 1 com saldo 0.
 * - cadeia de saldos: o `balance_before` de cada lançamento é o `balance_after` do anterior, e o
 *   primeiro parte de 0.
 * Lança um erro listando as wallets divergentes.
 */
export async function assertLedgerInvariant(orm: MikroORM): Promise<void> {
  const divergent = await orm.em.getConnection().execute<DivergentWallet[]>(`
    WITH totals AS (
      SELECT w.id, w.balance, w.version,
             COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS ledger_sum,
             COUNT(l.id) AS entries,
             COUNT(DISTINCT l.wallet_version) AS distinct_versions,
             MIN(l.wallet_version) AS min_version,
             MAX(l.wallet_version) AS max_version,
             EXISTS (
               SELECT 1 FROM wager_transactions t WHERE t.wallet_id = w.id AND t.kind = 'OPENING'
             ) AS has_opening,
             COUNT(*) FILTER (WHERE l.balance_before <> COALESCE(l.prev_after, 0)) AS broken_links
        FROM wallets w
        LEFT JOIN (
               SELECT e.*,
                      LAG(e.balance_after) OVER (PARTITION BY e.wallet_id ORDER BY e.wallet_version) AS prev_after
                 FROM wallet_ledger_entries e
             ) l ON l.wallet_id = w.id
       GROUP BY w.id, w.balance, w.version
    )
    SELECT id, balance, version, ledger_sum::TEXT, entries::TEXT, min_version, max_version
      FROM totals
     WHERE balance <> ledger_sum
        OR (entries = 0 AND (version <> 1 OR balance <> 0))
        OR (entries > 0 AND NOT (
              distinct_versions = entries
          AND max_version = version
          AND max_version - min_version + 1 = entries
          AND min_version = CASE WHEN has_opening THEN 1 ELSE 2 END
          AND broken_links = 0
        ))`);
  if (divergent.length > 0) {
    throw new Error(`ledger invariant violated for wallets: ${JSON.stringify(divergent)}`);
  }
}
