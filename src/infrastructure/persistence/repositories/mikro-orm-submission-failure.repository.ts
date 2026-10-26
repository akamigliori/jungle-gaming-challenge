import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type {
  SubmissionFailureRecord,
  SubmissionFailureRepository,
} from '../../../application/ports/submission-failure.repository';

/** Detalhe truncado: o suficiente para diagnóstico, sem crescer a coluna. */
const DETAIL_MAX_LENGTH = 500;

@Injectable()
export class MikroOrmSubmissionFailureRepository implements SubmissionFailureRepository {
  constructor(private readonly em: EntityManager) {}

  /** `INSERT` puro: a tabela é append-only, então não há `UPDATE` nem `ON CONFLICT`. */
  async insert(failure: SubmissionFailureRecord): Promise<void> {
    await this.em.execute(
      `INSERT INTO wager_submission_failures
         (id, channel, provider_id, external_transaction_id, idempotency_key, wallet_id, message_id,
          payload_hash, reason_code, category, retryable, correlation_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        failure.id,
        failure.channel,
        failure.providerId,
        failure.externalTransactionId,
        failure.idempotencyKey,
        failure.walletId,
        failure.messageId,
        failure.payloadHash,
        failure.reasonCode,
        failure.category,
        failure.retryable,
        failure.correlationId,
        failure.detail === null ? null : failure.detail.slice(0, DETAIL_MAX_LENGTH),
        failure.createdAt,
      ],
    );
  }
}
