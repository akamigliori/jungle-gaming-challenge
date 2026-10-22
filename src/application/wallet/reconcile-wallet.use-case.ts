import type { Clock } from '../ports/clock';
import type { Metrics } from '../ports/metrics';
import type { WalletLedgerReader } from '../ports/wallet-ledger-reader';
import { WalletNotFoundError } from './wallet-errors';
import { buildReport, type ReconciliationReport } from './wallet-reconciliation';

export interface ReconcileWalletDeps {
  reader: WalletLedgerReader;
  metrics: Metrics;
  clock: Clock;
}

/**
 * Confere o saldo gravado de uma wallet contra o seu ledger e relata o resultado. Só lê:
 * divergência é sinalizada e contada, nunca corrigida.
 */
export class ReconcileWalletUseCase {
  constructor(private readonly deps: ReconcileWalletDeps) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const { reader, metrics, clock } = this.deps;
    const snapshot = await reader.read(walletId);
    if (!snapshot) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    const report = buildReport(snapshot, clock.now());
    metrics.reconciliationChecked(report.consistent ? 'consistent' : 'divergent');
    return report;
  }
}
