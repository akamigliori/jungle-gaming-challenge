import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/shared/money';
import {
  OPENING_GAME_ID,
  OPENING_PROVIDER_ID,
  OPENING_ROUND_ID,
  WagerTransaction,
} from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { LedgerRepository } from '../ports/ledger.repository';
import type { OutboxRepository } from '../ports/outbox.repository';
import type { TransactionRunner } from '../ports/transaction-runner';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';
import { computePayloadHash } from '../wager/payload-hash';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletDeps {
  transactionRunner: TransactionRunner;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
}

/**
 * Cria a wallet e, se o saldo inicial for positivo, a transação `OPENING` já processada,
 * o lançamento `CREDIT` no ledger e os eventos na outbox — tudo numa única transação SQL.
 * Wallet duplicada (mesmo player e moeda) é detectada pela constraint `UNIQUE` do banco.
 */
export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDeps) {}

  async execute(cmd: CreateWalletCommand): Promise<Wallet> {
    // valida o valor antes de abrir a transação
    const initialBalance = Money.from(cmd.initialBalance);
    const { transactionRunner, wallets, ids, clock } = this.deps;

    return transactionRunner.run(async () => {
      const at = clock.now();
      const { wallet, openingEntry } = Wallet.open({
        id: ids.next(),
        playerId: cmd.playerId,
        initialBalance,
        openingTransactionId: ids.next(),
        openingEntryId: ids.next(),
        at,
      });
      await wallets.add(wallet);
      if (openingEntry) await this.recordOpening(wallet, openingEntry, cmd.correlationId, at);
      return wallet;
    });
  }

  /** Grava, nesta ordem, a transação OPENING, o lançamento do ledger e os dois eventos. */
  private async recordOpening(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    correlationId: string,
    at: Date,
  ): Promise<void> {
    const { transactions, ledger, outbox, ids } = this.deps;
    const payloadHash = computePayloadHash({
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: wallet.id,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: OPENING_ROUND_ID,
      gameId: OPENING_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: entry.money.toJSON(),
    });
    const opening = WagerTransaction.opening({
      id: entry.transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: entry.money,
      payloadHash,
      at,
    });
    opening.markProcessed({ at, balanceAfter: wallet.balance, walletVersionAfter: wallet.version });

    await transactions.add(opening);
    await ledger.append(entry);

    const context = () => ({ eventId: ids.next(), correlationId, occurredAt: at });
    await outbox.enqueue(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context())));
    await outbox.enqueue(
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context())),
    );
  }
}
