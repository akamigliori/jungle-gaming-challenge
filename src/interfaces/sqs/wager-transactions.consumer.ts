import { setTimeout as delay } from 'node:timers/promises';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../../application/ports/clock';
import {
  type ProcessWagerCommand,
  type ProcessWagerResult,
  ProcessWagerTransactionUseCase,
} from '../../application/wager/process-wager-transaction.use-case';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/config';
import { safeError } from '../../infrastructure/logging/safe-error';
import { SQS_CLIENT } from '../../infrastructure/sqs/sqs.client';
import { failureAction } from './message-failure-policy';
import { messageHash, parseWagerMessage, type WagerMessage } from './wager-message.schema';

export const CONSUMER_NAME = 'wager-transactions-consumer';

/** Espera depois de um ciclo de recebimento com erro (SQS fora do ar, fila inexistente). */
const RECEIVE_ERROR_BACKOFF_MS = 1000;
/** Folga do timeout HTTP do long poll sobre o `WaitTimeSeconds`. */
const LONG_POLL_TIMEOUT_MARGIN_MS = 5000;
const INVALID_PAYLOAD_CODE = 'INVALID_PAYLOAD';

/** Subconjunto do logger usado pelo consumer. */
export type ConsumerLogger = Pick<PinoLogger, 'info' | 'warn' | 'error'>;

interface QueueUrls {
  transactions: string;
  transactionsDlq: string;
}

/** Campos da mensagem que podem ir para o log: identificadores, nunca o payload nem valores. */
interface MessageLogContext {
  sqsMessageId: string | undefined;
  messageId?: string;
  walletId?: string;
  providerId?: string;
  receiveCount: number;
}

/**
 * Consumer da fila FIFO de transações de aposta: o adaptador de transporte do SQS, como o
 * controller é o do HTTP, chamando o mesmo caso de uso.
 *
 * `loops` laços independentes fazem long polling; cada lote é agrupado por `MessageGroupId`
 * (= wallet): grupos em paralelo, mensagens do mesmo grupo em sequência, preservando a ordem por
 * wallet. O ack (`DeleteMessage`) só acontece depois que o caso de uso resolveu, isto é, depois do
 * COMMIT de inbox, saldo, ledger e outbox. Falha permanente vai explicitamente para a DLQ; falha
 * transitória volta para a fila com backoff (`ChangeMessageVisibility`). Nenhum estado de mensagem
 * fica em memória: o contador de tentativas é o `ApproximateReceiveCount` do SQS.
 */
@Injectable()
export class WagerTransactionsConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly stop = new AbortController();
  private loops: Promise<void>[] = [];
  private queueUrls: Promise<QueueUrls> | undefined;

  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(WagerTransactionsConsumer.name) private readonly logger: ConsumerLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.consumer.enabled) return;
    this.loops = Array.from({ length: this.config.consumer.loops }, () => this.receiveLoop());
  }

  /** Para de receber (aborta o long poll) e espera os lotes em andamento terminarem. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await Promise.all(this.loops);
  }

  private get stopping(): boolean {
    return this.stop.signal.aborted;
  }

  private async receiveLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const urls = await this.resolveQueueUrls();
        const messages = await this.receive(urls.transactions);
        await this.processBatch(messages, urls);
      } catch (error) {
        if (this.stopping) return;
        this.logger.error({ err: safeError(error) }, 'wager transactions receive cycle failed');
        await delay(RECEIVE_ERROR_BACKOFF_MS, undefined, { signal: this.stop.signal }).catch(
          () => undefined,
        );
      }
    }
  }

  private async receive(queueUrl: string): Promise<Message[]> {
    const { batchSize, waitTimeSeconds } = this.config.consumer;
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: batchSize,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      // o timeout por chamada substitui o do cliente (1,5 s), que derrubaria o long poll
      {
        abortSignal: this.stop.signal,
        requestTimeout: waitTimeSeconds * 1000 + LONG_POLL_TIMEOUT_MARGIN_MS,
      },
    );
    return Messages;
  }

  /** Grupos (wallets) em paralelo; dentro do grupo, na ordem em que o SQS entregou. */
  private async processBatch(messages: Message[], urls: QueueUrls): Promise<void> {
    await Promise.all(
      [...groupByMessageGroup(messages).values()].map((group) => this.processGroup(group, urls)),
    );
  }

  private async processGroup(group: Message[], urls: QueueUrls): Promise<void> {
    for (const message of group) {
      await this.handle(message, urls);
    }
  }

  /**
   * Devolve se a mensagem saiu da fila principal (ack ou DLQ). Um erro do próprio SQS no ack,
   * no envio para a DLQ ou na troca de visibilidade só é logado: a mensagem reaparece depois do
   * visibility timeout e a inbox impede efeito duplicado.
   */
  private async handle(message: Message, urls: QueueUrls): Promise<boolean> {
    const context: MessageLogContext = {
      sqsMessageId: message.MessageId,
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
    };
    try {
      return await this.dispatch(message, urls, context);
    } catch (error) {
      this.logger.error(
        { ...context, err: safeError(error) },
        'wager message sqs operation failed',
      );
      return false;
    }
  }

  private async dispatch(
    message: Message,
    urls: QueueUrls,
    context: MessageLogContext,
  ): Promise<boolean> {
    const parsed = parseWagerMessage(message.Body ?? '');
    if (!parsed.ok) {
      await this.deadLetter(message, INVALID_PAYLOAD_CODE, urls);
      this.logger.warn(
        { ...context, failureCode: INVALID_PAYLOAD_CODE },
        'wager message dead-lettered',
      );
      return true;
    }

    const { messageId, data } = parsed.message;
    Object.assign(context, { messageId, walletId: data.walletId, providerId: data.providerId });

    let result: ProcessWagerResult;
    try {
      result = await this.processWager.execute(toCommand(parsed.message));
    } catch (error) {
      return this.handleFailure(message, error, urls, context);
    }

    await this.ack(message, urls.transactions);
    const { transaction, idempotentReplay } = result;
    this.logger.info(
      { ...context, transactionId: transaction.id, status: transaction.status, idempotentReplay },
      'wager message processed',
    );
    return true;
  }

  private async handleFailure(
    message: Message,
    error: unknown,
    urls: QueueUrls,
    context: MessageLogContext,
  ): Promise<boolean> {
    const action = failureAction(error, context.receiveCount);
    if (action.kind === 'dead-letter') {
      await this.deadLetter(message, action.failureCode, urls);
      this.logger.warn(
        { ...context, failureCode: action.failureCode },
        'wager message dead-lettered',
      );
      return true;
    }
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: urls.transactions,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: action.delaySeconds,
      }),
    );
    this.logger.warn(
      { ...context, err: safeError(error), retryInSeconds: action.delaySeconds },
      'wager message will be retried',
    );
    return false;
  }

  /**
   * Envia o mesmo corpo para a DLQ e só então dá ack na principal. Se o processo morrer entre os
   * dois, a mensagem volta, falha de novo e o reenvio é deduplicado pelo SQS (`MessageId` original).
   */
  private async deadLetter(message: Message, failureCode: string, urls: QueueUrls): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: urls.transactionsDlq,
        MessageBody: message.Body,
        MessageGroupId: message.Attributes?.MessageGroupId ?? message.MessageId,
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: failureCode },
          failedAt: { DataType: 'String', StringValue: this.clock.now().toISOString() },
        },
      }),
    );
    await this.ack(message, urls.transactions);
  }

  private async ack(message: Message, queueUrl: string): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  /** URLs resolvidas uma vez e reaproveitadas; uma falha não fica guardada. */
  private resolveQueueUrls(): Promise<QueueUrls> {
    const { transactions, transactionsDlq } = this.config.sqs.queues;
    this.queueUrls ??= Promise.all([this.queueUrl(transactions), this.queueUrl(transactionsDlq)])
      .then(([main, dlq]) => ({ transactions: main, transactionsDlq: dlq }))
      .catch((error: unknown) => {
        this.queueUrls = undefined;
        throw error;
      });
    return this.queueUrls;
  }

  private async queueUrl(name: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`queue url not found: ${name}`);
    return QueueUrl;
  }
}

/** Envelope validado → comando do caso de uso; a entrega é identificada pelo `messageId`. */
function toCommand({ messageId, data }: WagerMessage): ProcessWagerCommand {
  return {
    ...data,
    kind: data.kind as WagerTransactionKind,
    correlationId: messageId,
    inbox: { consumerName: CONSUMER_NAME, messageId, payloadHash: messageHash(data) },
  };
}

/** Agrupa preservando a ordem de entrega dentro de cada grupo. */
function groupByMessageGroup(messages: Message[]): Map<string, Message[]> {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const groupId = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
    const group = groups.get(groupId);
    if (group) group.push(message);
    else groups.set(groupId, [message]);
  }
  return groups;
}
