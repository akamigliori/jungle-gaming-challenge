import { DomainError } from '../../domain/shared/domain-error';

/** A chave de idempotência (ou o id externo) já foi usada com outro payload: não é replay. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;
}
