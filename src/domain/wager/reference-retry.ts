/** Política de novas tentativas para resolver uma referência que ainda não chegou. */
export interface ReferenceRetryPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export const DEFAULT_REFERENCE_RETRY: ReferenceRetryPolicy = {
  baseMs: 2_000,
  maxMs: 60_000,
  maxAttempts: 10,
};

/** Espera exponencial (base · 2^tentativas), limitada a `maxMs`. */
export function referenceRetryDelayMs(attempts: number, policy: ReferenceRetryPolicy): number {
  return Math.min(policy.baseMs * 2 ** attempts, policy.maxMs);
}
