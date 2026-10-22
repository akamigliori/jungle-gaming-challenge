import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { InboxReceipt, InboxRepository } from '../../../application/ports/inbox.repository';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `INSERT ... ON CONFLICT DO NOTHING` na transação do processamento: a linha só existe se o
   * processamento fizer commit, então `received_at` e `processed_at` são o mesmo instante.
   * Sem linha devolvida, a entrega já foi registrada; o hash decide entre duplicata e conflito.
   */
  async register(receipt: InboxReceipt, at: Date): Promise<'new' | 'duplicate' | 'conflict'> {
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [receipt.consumerName, receipt.messageId, receipt.payloadHash, at, at],
    );
    if (inserted.length > 0) return 'new';

    const [existing] = await this.em.execute<{ payload_hash: string }[]>(
      'SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [receipt.consumerName, receipt.messageId],
    );
    return existing?.payload_hash === receipt.payloadHash ? 'duplicate' : 'conflict';
  }
}
