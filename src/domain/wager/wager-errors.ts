import { DomainError, InvariantViolationError } from '../shared/domain-error';

/** Erro de programação: uma transição que a máquina de estados não permite. */
export class InvalidTransactionStateError extends InvariantViolationError {}

export class ReferenceRequiredError extends DomainError {
  readonly code = 'REFERENCE_REQUIRED' as const;
}

export class ReferenceNotAllowedError extends DomainError {
  readonly code = 'INVALID_PAYLOAD' as const;
}
