import type { InboxMessage } from '../../domain/messaging/inbox-message';

/** Identifica a entrega de uma mensagem para um consumer, com o hash do corpo recebido. */
export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

/** Tabela inbox: deduplicação de mensagens consumidas, gravada na transação do processamento. */
export interface InboxRepository {
  /**
   * Registra a entrega na transação corrente. `'new'` grava a linha; `'duplicate'` já existia com
   * o mesmo `payloadHash`; `'conflict'` já existia com outro `payloadHash`.
   */
  register(message: InboxMessage): Promise<'new' | 'duplicate' | 'conflict'>;
}

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
