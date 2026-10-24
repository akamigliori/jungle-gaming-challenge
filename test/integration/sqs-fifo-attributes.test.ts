import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/infrastructure/config/config';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs.client';
import { createTestQueues, type TestQueues } from './support/queues';

let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  sqs = createSqsClient(loadConfig({ ...process.env, LOG_LEVEL: 'silent' }));
  queues = await createTestQueues({ visibilityTimeout: 30, maxReceiveCount: 10 });
});

afterAll(async () => {
  await queues.destroy();
  sqs.destroy();
});

async function attributesOf(queueUrl: string): Promise<Record<string, string> | undefined> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
  );
  return Attributes;
}

describe('SQS FIFO de alta vazão', () => {
  test('a fila de eventos e a de transações usam alta vazão (deduplicação por grupo)', async () => {
    for (const name of ['transactions', 'events'] as const) {
      const attrs = await attributesOf(queues.urls[name]);
      expect(attrs?.FifoQueue).toBe('true');
      expect(attrs?.FifoThroughputLimit).toBe('perMessageQueueId');
      expect(attrs?.DeduplicationScope).toBe('messageGroup');
    }
  });

  test('a DLQ permanece FIFO padrão (sem alta vazão)', async () => {
    const attrs = await attributesOf(queues.urls.transactionsDlq);
    expect(attrs?.FifoQueue).toBe('true');
    expect(attrs?.FifoThroughputLimit).toBe('perQueue');
  });
});
