import { TransientFailureError } from '../../application/shared/retry-transient';
import { DomainError } from '../../domain/shared/domain-error';

export const RETRY_BASE_SECONDS = 1;
export const RETRY_MAX_SECONDS = 300;
export const UNEXPECTED_ERROR_MAX_RECEIVES = 3;

/** Erros que nunca mudam de resultado se a mensagem for reprocessada. */
export const PERMANENT_ERROR_CODES: readonly string[] = [
  'INVALID_PAYLOAD',
  'INVALID_MONEY',
  'REFERENCE_REQUIRED',
  'WALLET_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
];

const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
const MIN_JITTER_FACTOR = 0.5;

export type MessageAction =
  | { kind: 'retry'; delaySeconds: number }
  | { kind: 'dead-letter'; failureCode: string };

/**
 * Decide o destino de uma mensagem cujo processamento lançou erro: o que foi gravado recebe ack;
 * o que não pode ser gravado vai para a DLQ; bug não segura o grupo FIFO por mais de ~3 entregas.
 * Transitório nunca vai para a DLQ aqui: o limite de entregas dele é o redrive da fila.
 */
export function failureAction(
  error: unknown,
  receiveCount: number,
  random: () => number = Math.random,
): MessageAction {
  if (error instanceof DomainError && PERMANENT_ERROR_CODES.includes(error.code)) {
    return { kind: 'dead-letter', failureCode: error.code };
  }
  const isTransient = error instanceof TransientFailureError;
  if (!isTransient && receiveCount >= UNEXPECTED_ERROR_MAX_RECEIVES) {
    return { kind: 'dead-letter', failureCode: INTERNAL_ERROR_CODE };
  }
  return { kind: 'retry', delaySeconds: backoffSeconds(receiveCount, random) };
}

/** Equal jitter: metade do atraso exponencial é fixa e a outra metade é sorteada. */
function backoffSeconds(receiveCount: number, random: () => number): number {
  const exponential = Math.min(RETRY_BASE_SECONDS * 2 ** (receiveCount - 1), RETRY_MAX_SECONDS);
  const jittered = exponential * (MIN_JITTER_FACTOR + random() * (1 - MIN_JITTER_FACTOR));
  return Math.max(1, Math.round(jittered));
}
