import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { InboxRepository } from '../../../application/ports/inbox.repository';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `INSERT ... ON CONFLICT DO NOTHING` na transação do processamento: a linha só existe se o
   * processamento fizer commit. Sem linha devolvida, a entrega já foi registrada; o hash decide
   * entre duplicata e conflito.
   */
  async register(message: InboxMessage): Promise<'new' | 'duplicate' | 'conflict'> {
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );
    if (inserted.length > 0) return 'new';

    const [existing] = await this.em.execute<{ payload_hash: string }[]>(
      'SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [message.consumerName, message.messageId],
    );
    return existing?.payload_hash === message.payloadHash ? 'duplicate' : 'conflict';
  }
}
