import { DomainError } from '../shared/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS' as const;
}

export class ReversalInsufficientFundsError extends DomainError {
  readonly code = 'REVERSAL_INSUFFICIENT_FUNDS' as const;
}

/** O crédito levaria o saldo além do máximo que cabe em NUMERIC(20,2). */
export class BalanceLimitExceededError extends DomainError {
  readonly code = 'BALANCE_LIMIT_EXCEEDED' as const;
}
