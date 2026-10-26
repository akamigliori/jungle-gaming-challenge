import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

export interface SubmissionFailureDto {
  reasonCode: string;
  category: string;
  retryable: boolean;
  channel: string;
  messageId: string | null;
  correlationId: string | null;
  detail: string | null;
  createdAt: string;
}

interface SubmissionFailureRow {
  reason_code: string;
  category: string;
  retryable: boolean;
  channel: string;
  message_id: string | null;
  correlation_id: string;
  detail: string | null;
  created_at: string | Date;
}

/** Recusas auditadas de uma transação, mais recentes primeiro. */
@Injectable()
export class SubmissionFailureQuery {
  constructor(private readonly em: EntityManager) {}

  async listByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    limit = 50,
  ): Promise<SubmissionFailureDto[]> {
    const rows = await this.em.execute<SubmissionFailureRow[]>(
      `SELECT reason_code, category, retryable, channel, message_id, correlation_id, detail, created_at
         FROM wager_submission_failures
        WHERE provider_id = ? AND external_transaction_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [providerId, externalTransactionId, limit],
    );
    return rows.map(toDto);
  }
}

function toDto(row: SubmissionFailureRow): SubmissionFailureDto {
  return {
    reasonCode: row.reason_code,
    category: row.category,
    retryable: row.retryable,
    channel: row.channel,
    messageId: row.message_id,
    correlationId: row.correlation_id,
    detail: row.detail,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
