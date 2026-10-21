import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Grava o evento na tabela outbox, na mesma transação da mudança que o originou. */
export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
