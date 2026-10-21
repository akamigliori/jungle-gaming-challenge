/**
 * Executa um bloco de trabalho dentro de uma única transação SQL: commit se o bloco
 * terminar, rollback se ele lançar erro. Os repositórios chamados dentro do bloco
 * participam da mesma transação.
 */
export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
