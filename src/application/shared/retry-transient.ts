import { DomainError } from '../../domain/shared/domain-error';

/**
 * As tentativas se esgotaram numa falha transitória de infraestrutura (lock ocupado, deadlock,
 * banco fora). O cliente pode reenviar a mesma requisição. A mensagem é genérica de propósito:
 * o erro original fica só em `cause`, para o log, e nunca vai para a resposta.
 */
export class TransientFailureError extends DomainError {
  readonly code = 'SERVICE_UNAVAILABLE' as const;
  readonly retryable = true;

  constructor(cause: unknown) {
    super('Service temporarily unavailable');
    this.cause = cause;
  }
}

export interface RetryPolicy {
  isTransient: (error: unknown) => boolean;
  /** Total de execuções, contando a primeira. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Chamado a cada erro transitório, inclusive o da última tentativa. */
  onTransient?: (error: unknown) => void;
  /** Chamado quando uma nova tentativa vai acontecer. */
  onRetry?: () => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Executa `work` de novo, do zero, enquanto o erro for transitório e houver tentativas.
 * A espera antes da próxima tentativa é `random() * baseDelayMs * 2^tentativa` (backoff
 * exponencial com jitter, para que instâncias em disputa não tentem todas ao mesmo tempo).
 * Erro não transitório é relançado na hora; esgotadas as tentativas, lança `TransientFailureError`.
 * Só é seguro porque cada execução de `work` é uma transação inteira: a anterior já foi desfeita.
 */
export async function retryTransient<T>(work: () => Promise<T>, p: RetryPolicy): Promise<T> {
  const random = p.random ?? Math.random;
  const sleep = p.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!p.isTransient(error)) throw error;
      p.onTransient?.(error);
      if (attempt >= p.maxAttempts) throw new TransientFailureError(error);
      p.onRetry?.();
      await sleep(random() * p.baseDelayMs * 2 ** attempt);
    }
  }
}
