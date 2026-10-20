import type { ErrorCode } from '../../domain/shared/failure-code';

export interface ErrorHttpStatus {
  status: number;
  retryable: boolean;
}

const fail = (status: number, retryable = false): ErrorHttpStatus => ({ status, retryable });

/**
 * Mapeamento único de código de erro para status HTTP, usado por todos os endpoints.
 * O `Record` obriga o compilador a exigir uma entrada para cada código novo.
 */
const STATUS_BY_CODE: Record<ErrorCode, ErrorHttpStatus> = {
  // payload inválido: o provedor deve corrigir a requisição
  INVALID_PAYLOAD: fail(400),
  INVALID_MONEY: fail(400),
  REFERENCE_REQUIRED: fail(400),
  // autenticação
  UNAUTHORIZED: fail(401),
  // recurso inexistente
  NOT_FOUND: fail(404),
  WALLET_NOT_FOUND: fail(404),
  // conflito
  IDEMPOTENCY_CONFLICT: fail(409),
  WALLET_ALREADY_EXISTS: fail(409),
  // rejeições por regra de negócio
  CURRENCY_MISMATCH: fail(422),
  PLAYER_MISMATCH: fail(422),
  INSUFFICIENT_FUNDS: fail(422),
  REVERSAL_INSUFFICIENT_FUNDS: fail(422),
  REFERENCE_NOT_FOUND: fail(422),
  REFERENCE_MISMATCH: fail(422),
  INVALID_REFERENCE_KIND: fail(422),
  REFERENCE_NOT_PROCESSED: fail(422),
  ALREADY_REVERSED: fail(422),
  AMOUNT_MISMATCH: fail(422),
  // infraestrutura: transitória (pode reenviar) vs. permanente
  SERVICE_UNAVAILABLE: fail(503, true),
  INTERNAL_ERROR: fail(500),
};

export function statusFor(code: ErrorCode): ErrorHttpStatus {
  return STATUS_BY_CODE[code];
}
