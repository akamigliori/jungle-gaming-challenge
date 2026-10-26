/** Canal de entrada da submissão auditada. */
export type SubmissionChannel = 'HTTP' | 'SQS';
/** Natureza da recusa, para o provedor decidir o que fazer. */
export type SubmissionFailureCategory =
  | 'VALIDATION'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'INFRASTRUCTURE';

/** Dados de uma submissão que não virou resultado de negócio. */
export interface SubmissionFailureInput {
  channel: SubmissionChannel;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  /** Id do envelope SQS; nulo no canal HTTP. */
  messageId: string | null;
  /** Hash estável do payload submetido (para correlacionar tentativas). */
  payloadHash: string;
  reasonCode: string;
  category: SubmissionFailureCategory;
  retryable: boolean;
  correlationId: string;
  /** Mensagem segura e truncada do erro; nunca o payload financeiro. */
  detail: string | null;
}

/** Linha já persistida. */
export interface SubmissionFailureRecord extends SubmissionFailureInput {
  id: string;
  createdAt: Date;
}

export interface SubmissionFailureRepository {
  insert(failure: SubmissionFailureRecord): Promise<void>;
}

export const SUBMISSION_FAILURE_REPOSITORY = Symbol('SUBMISSION_FAILURE_REPOSITORY');
