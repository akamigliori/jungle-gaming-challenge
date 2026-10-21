import { InvariantViolationError } from '../shared/domain-error';
import type { MoneyProps } from '../shared/money';
import type { WagerTransaction } from '../wager/wager-transaction';
import type { WagerTransactionKind } from '../wager/wager-transaction-kind';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed' as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const balanceAfter = tx.balanceAfter;
    if (balanceAfter === undefined) {
      throw new InvariantViolationError('processed transaction must have balanceAfter');
    }
    const referenceTransactionId = tx.referenceTransactionId;
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balanceAfter: balanceAfter.toJSON(),
        ...(referenceTransactionId !== undefined ? { referenceTransactionId } : {}),
      },
    });
  }
}
