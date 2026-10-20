import { DomainError } from '../shared/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS' as const;
}

export class ReversalInsufficientFundsError extends DomainError {
  readonly code = 'REVERSAL_INSUFFICIENT_FUNDS' as const;
}
