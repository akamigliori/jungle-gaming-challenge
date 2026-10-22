import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { SQS_CLIENT } from './sqs.client';

/**
 * Publica na fila FIFO de eventos. `MessageGroupId` = wallet (ordem por wallet dentro da fila);
 * `MessageDeduplicationId` = `eventId`, então o SQS descarta reenvios do mesmo evento dentro da
 * sua janela de deduplicação (5 min). Fora dela, o consumidor deduplica pelo `eventId`.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  /** URL da fila resolvida uma vez e reaproveitada (não muda enquanto o processo vive). */
  private queueUrl: Promise<string> | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageBody: JSON.stringify(message.payload),
      }),
    );
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.config.sqs.queues.events }))
      .then(({ QueueUrl }) => {
        if (!QueueUrl) throw new Error('events queue url not found');
        return QueueUrl;
      })
      .catch((error: unknown) => {
        // não guarda a falha: a próxima publicação tenta resolver de novo
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}
