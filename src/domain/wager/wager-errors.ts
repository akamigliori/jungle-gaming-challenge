import { DomainError, InvariantViolationError } from '../shared/domain-error';

/** Programming error: a transition that the state machine does not allow. */
export class InvalidTransactionStateError extends InvariantViolationError {}

export class ReferenceRequiredError extends DomainError {
  readonly code = 'REFERENCE_REQUIRED' as const;
}

export class ReferenceNotAllowedError extends DomainError {
  readonly code = 'INVALID_PAYLOAD' as const;
}
