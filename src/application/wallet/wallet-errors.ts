import { DomainError } from '../../domain/shared/domain-error';

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS' as const;
}

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND' as const;
}
