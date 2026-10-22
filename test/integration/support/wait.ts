const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 100;

/**
 * Repete `probe` até ele devolver verdadeiro, ou falha depois de `timeoutMs`. Usado no lugar de
 * esperas fixas quando o efeito acontece num loop em segundo plano (consumer, workers).
 */
export async function waitFor(
  probe: () => Promise<boolean> | boolean,
  description: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(intervalMs);
  }
}
