import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { BatchPublishResult, EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { SQS_CLIENT } from './sqs.client';

/**
 * Publica na fila FIFO de eventos. `MessageGroupId` = wallet (ordem por wallet dentro da fila);
 * `MessageDeduplicationId` = `eventId`, então o SQS descarta reenvios do mesmo evento dentro da
 * sua janela de deduplicação (5 min). Fora dela, o consumidor deduplica pelo `eventId`.
 *
 * O envio é em lote (`SendMessageBatch`, até 10 por chamada); o resultado vem por entrada, sem
 * lançar. Lança só quando a chamada em si não acontece (rede), para o caso de uso tratar o lote
 * inteiro como falho.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  /** URL da fila resolvida uma vez e reaproveitada (não muda enquanto o processo vive). */
  private queueUrl: Promise<string> | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async publishBatch(messages: OutboxMessage[]): Promise<BatchPublishResult> {
    const { Successful = [], Failed = [] } = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.resolveQueueUrl(),
        Entries: messages.map((message, index) => ({
          Id: String(index),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageBody: JSON.stringify(message.payload),
        })),
      }),
    );
    return {
      published: Successful.map((entry) => messages[Number(entry.Id)]?.id).filter(
        (id): id is string => id !== undefined,
      ),
      failed: Failed.map((entry) => ({
        id: messages[Number(entry.Id)]?.id ?? entry.Id ?? 'unknown',
        error: entry.Message ?? 'send failed',
      })),
    };
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
