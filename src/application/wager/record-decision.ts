import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerDecision } from '../../domain/wager/wager-decision';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import { JournalEntry } from '../../domain/wallet/journal-entry';
import { opposite } from '../../domain/wallet/ledger-direction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { IdGenerator } from '../ports/id-generator';
import type { JournalRepository } from '../ports/journal.repository';
import type { LedgerRepository } from '../ports/ledger.repository';
import type { OutboxRepository } from '../ports/outbox.repository';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';

export interface RecordDecisionDeps {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  journal: JournalRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
}

export interface RecordDecisionParams {
  tx: WagerTransaction;
  wallet: Wallet;
  decision: WagerDecision;
  expectedVersion: number;
  at: Date;
  correlationId: string;
  /** `insert` para transação nova; `update` para uma que estava `PENDING_REFERENCE`. */
  persist: 'insert' | 'update';
}

/**
 * Grava o resultado de uma decisão na transação SQL aberta pelo chamador (que mantém a wallet
 * travada), na ordem wallet → transação → ledger → outbox. Quando a transação termina
 * (`PROCESSED` ou `REJECTED`), acorda as pendentes que a referenciam.
 */
export async function recordDecision(
  deps: RecordDecisionDeps,
  p: RecordDecisionParams,
): Promise<void> {
  const { wallets, transactions, ledger, journal, outbox, ids } = deps;
  const { tx, wallet, decision } = p;
  const entry = decision.outcome === 'PROCESSED' ? decision.entry : null;

  if (entry) await wallets.save(wallet, p.expectedVersion);
  if (p.persist === 'insert') await transactions.add(tx);
  else await transactions.update(tx, p.at);
  if (entry) {
    await ledger.append(entry);
    // contrapartida da casa: igual e oposta à entrada da wallet, na mesma transação
    await journal.append(
      JournalEntry.create({
        id: ids.next(),
        transactionId: tx.id,
        accountId: JournalEntry.accountId(tx.providerId, entry.money.currency),
        direction: opposite(entry.direction),
        money: entry.money,
        createdAt: p.at,
      }),
    );
  }

  const context = () => ({ eventId: ids.next(), correlationId: p.correlationId, occurredAt: p.at });
  const events: OutboxMessage[] = [];
  switch (decision.outcome) {
    case 'PROCESSED':
      events.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, context())));
      if (entry)
        events.push(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, entry, context()),
            entry.walletVersion,
          ),
        );
      break;
    case 'REJECTED':
      events.push(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, context())));
      break;
    case 'PENDING_REFERENCE':
      // só a entrada em PENDING_REFERENCE vira evento; reagendar não, para não gerar ruído
      if (p.persist === 'insert') {
        events.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, context())));
      }
      await outbox.enqueueMany(events);
      return;
  }
  await outbox.enqueueMany(events);

  await transactions.wakeDependents({
    walletId: tx.walletId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    now: p.at,
  });
}
