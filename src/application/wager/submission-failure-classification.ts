import type { ErrorCode } from '../../domain/shared/failure-code';
import type { SubmissionFailureCategory } from '../ports/submission-failure.repository';

/**
 * Códigos que viram recusa auditável (não geram transação `REJECTED`). Rejeições de negócio
 * (`INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`...) já ficam gravadas em `wager_transactions` e não
 * entram aqui. `undefined` = não auditar (erro de programação ou infraestrutura transitória).
 */
const CATEGORY_BY_CODE: Partial<Record<ErrorCode, SubmissionFailureCategory>> = {
  INVALID_PAYLOAD: 'VALIDATION',
  INVALID_MONEY: 'VALIDATION',
  REFERENCE_REQUIRED: 'VALIDATION',
  IDEMPOTENCY_CONFLICT: 'CONFLICT',
  WALLET_NOT_FOUND: 'UNPROCESSABLE',
  CURRENCY_MISMATCH: 'UNPROCESSABLE',
  PLAYER_MISMATCH: 'UNPROCESSABLE',
};

export interface SubmissionFailureClassification {
  category: SubmissionFailureCategory;
  retryable: boolean;
}

/** Classifica o erro em categoria e se o provedor pode reenviar sem corrigir o payload. */
export function classifySubmissionFailure(code: ErrorCode): SubmissionFailureClassification | null {
  const category = CATEGORY_BY_CODE[code];
  // nenhuma recusa auditada aqui é resolvida só reenviando; a categoria orienta a correção
  return category ? { category, retryable: false } : null;
}
