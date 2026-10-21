import { InvariantViolationError } from '../shared/domain-error';
import type { WagerTransaction } from '../wager/wager-transaction';
import type { WagerTransactionKind } from '../wager/wager-transaction-kind';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const reference = tx.referenceExternalTransactionId;
    if (reference === undefined) {
      throw new InvariantViolationError('pending-reference transaction must have a reference');
    }
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: reference,
      },
    });
  }
}
