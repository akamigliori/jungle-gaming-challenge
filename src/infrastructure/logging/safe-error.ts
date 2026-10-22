/** Profundidade máxima da cadeia de `cause` percorrida no log. */
const MAX_CAUSE_DEPTH = 3;

export interface SafeError {
  type: string;
  message?: string;
  stack?: string;
  code?: string;
  constraint?: string;
  table?: string;
  cause?: SafeError;
}

/**
 * Reduz um erro aos campos que podem ir para o log. Erros do driver (com SQLSTATE `code`) trazem
 * a query com os valores já interpolados na mensagem e na stack, e `detail` com a linha inteira:
 * por isso, neles, só nome, código, constraint e tabela são mantidos.
 */
export function safeError(error: unknown, depth = 0): SafeError {
  if (!(error instanceof Error)) return { type: typeof error };
  const { code, constraint, table } = error as unknown as Record<string, unknown>;
  const isDriverError = typeof code === 'string' || typeof constraint === 'string';
  const safe: SafeError = { type: error.name };
  if (typeof code === 'string') safe.code = code;
  if (typeof constraint === 'string') safe.constraint = constraint;
  if (typeof table === 'string') safe.table = table;
  if (!isDriverError) {
    safe.message = error.message;
    safe.stack = error.stack;
  }
  const { cause } = error;
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) safe.cause = safeError(cause, depth + 1);
  return safe;
}
