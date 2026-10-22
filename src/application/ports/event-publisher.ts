import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Publica um evento da outbox no broker. Lança erro se a publicação não for confirmada. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
