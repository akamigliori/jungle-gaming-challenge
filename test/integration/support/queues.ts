import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../../src/infrastructure/config/config';
import { createSqsClient } from '../../../src/infrastructure/sqs/sqs.client';

export type TestQueueName = 'transactions' | 'transactionsDlq' | 'events';

export interface TestQueues {
  /** Nomes das filas, para as variáveis `SQS_*_QUEUE` do app de teste. */
  transactions: string;
  transactionsDlq: string;
  events: string;
  urls: Record<TestQueueName, string>;
  /** Envia para a fila de transações; `dedupId` padrão = `messageId` do corpo (ou um uuid). */
  send(body: unknown, opts: { groupId: string; dedupId?: string }): Promise<void>;
  /** Drena a fila: lê e apaga tudo o que estiver visível, com atributos de sistema e de mensagem. */
  receiveAll(queue: TestQueueName): Promise<Message[]>;
  /** Mensagens na fila, visíveis ou em processamento. */
  depth(queue: TestQueueName): Promise<number>;
  destroy(): Promise<void>;
}

/**
 * Cria filas FIFO próprias da suíte (`t-<uuid>-…fifo`) no LocalStack: DLQ, fila de transações com
 * redrive para ela e fila de eventos. Nada é compartilhado com outras suítes nem com o ambiente local.
 */
export async function createTestQueues(opts: {
  visibilityTimeout: number;
  maxReceiveCount: number;
}): Promise<TestQueues> {
  const sqs = createSqsClient(loadConfig({ ...process.env, LOG_LEVEL: 'silent' }));
  const prefix = `t-${crypto.randomUUID()}`;
  const names: Record<TestQueueName, string> = {
    transactions: `${prefix}-transactions.fifo`,
    transactionsDlq: `${prefix}-transactions-dlq.fifo`,
    events: `${prefix}-events.fifo`,
  };

  const dlqUrl = await createFifo(sqs, names.transactionsDlq, {});
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const urls: Record<TestQueueName, string> = {
    transactionsDlq: dlqUrl,
    transactions: await createFifo(sqs, names.transactions, {
      VisibilityTimeout: String(opts.visibilityTimeout),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes?.QueueArn,
        maxReceiveCount: opts.maxReceiveCount,
      }),
    }),
    events: await createFifo(sqs, names.events, {}),
  };

  return {
    ...names,
    urls,
    async send(body, { groupId, dedupId }) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: urls.transactions,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: groupId,
          MessageDeduplicationId: dedupId ?? messageIdOf(body) ?? crypto.randomUUID(),
        }),
      );
    },
    async receiveAll(queue) {
      const received: Message[] = [];
      for (;;) {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: urls[queue],
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
            MessageSystemAttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
        );
        if (Messages.length === 0) return received;
        received.push(...Messages);
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: urls[queue],
            Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
          }),
        );
      }
    },
    async depth(queue) {
      const { Attributes: attrs } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: urls[queue],
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return (
        Number(attrs?.ApproximateNumberOfMessages ?? 0) +
        Number(attrs?.ApproximateNumberOfMessagesNotVisible ?? 0)
      );
    },
    async destroy() {
      for (const url of Object.values(urls)) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
      sqs.destroy();
    },
  };
}

async function createFifo(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }),
  );
  if (!QueueUrl) throw new Error(`queue ${name} was not created`);
  return QueueUrl;
}

function messageIdOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('messageId' in body)) return undefined;
  return typeof body.messageId === 'string' ? body.messageId : undefined;
}
