import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface ClaimDueParams {
  now: Date;
  limit: number;
  leaseMs: number;
}

/** Tabela outbox: gravação na transação da mudança e reserva/baixa pelo publisher. */
export interface OutboxRepository {
  /** Grava o evento na mesma transação da mudança que o originou. */
  enqueue(message: OutboxMessage): Promise<void>;

  /**
   * Em transação própria e curta, reserva até `limit` mensagens pendentes e vencidas (mais
   * antigas primeiro), ignorando as que outra instância está reservando, e empurra o
   * `nextAttemptAt` delas para `now + leaseMs`. Se quem reservou morrer, elas voltam a ficar
   * disponíveis quando esse prazo vence.
   */
  claimDue(params: ClaimDueParams): Promise<OutboxMessage[]>;

  /** Marca como publicada; não faz nada se outra instância já marcou. */
  markPublished(id: string, at: Date): Promise<void>;

  /**
   * Registra uma tentativa que falhou: soma 1 em `attempts`, grava o `nextAttemptAt` da mensagem
   * (backoff) e o erro. Só vale enquanto a reserva ainda é de quem chama (`next_attempt_at` não
   * passou de `claimedUntil`): se o lease venceu e outra instância reservou a linha de novo, não
   * altera nada.
   */
  reschedule(message: OutboxMessage, p: { error: string; claimedUntil: Date }): Promise<void>;

  /**
   * Apaga até `limit` eventos já publicados e com `published_at` anterior a `cutoff`, do mais
   * antigo para o mais novo. Devolve quantos apagou. Apagar uma linha publicada não afeta a
   * entrega (o publisher só enxerga `published_at IS NULL`).
   */
  deletePublishedOlderThan(cutoff: Date, limit: number): Promise<number>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
