import type { ErrorCode } from './failure-code';

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY' as const;
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH' as const;
}

export class InvalidPayloadError extends DomainError {
  readonly code = 'INVALID_PAYLOAD' as const;
}

/** Erro de programação (invariante quebrada), não um erro de negócio. Mapeia para HTTP 500. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}
