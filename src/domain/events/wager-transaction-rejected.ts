import { InvariantViolationError } from '../shared/domain-error';
import type { FailureCode } from '../shared/failure-code';
import type { MoneyProps } from '../shared/money';
import type { WagerTransaction } from '../wager/wager-transaction';
import type { WagerTransactionKind } from '../wager/wager-transaction-kind';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected' as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const failureCode = tx.failureCode;
    if (failureCode === undefined) {
      throw new InvariantViolationError('rejected transaction must have failureCode');
    }
    return new WagerTransactionRejected({
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
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode,
      },
    });
  }
}
