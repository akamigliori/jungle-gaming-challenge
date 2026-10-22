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
import {
  APP_CONFIG,
  type AppConfig,
  LONG_POLL_TIMEOUT_MARGIN_MS,
} from '../../infrastructure/config/config';
import { safeError } from '../../infrastructure/logging/safe-error';
import { wagerOutcomeFields } from '../../infrastructure/logging/wager-log';
import { SQS_CLIENT } from '../../infrastructure/sqs/sqs.client';
import { failureAction } from './message-failure-policy';
import { messageHash, parseWagerMessage, type WagerMessage } from './wager-message.schema';

export const CONSUMER_NAME = 'wager-transactions-consumer';

/** Espera depois de um ciclo de recebimento com erro (SQS fora do ar, fila inexistente). */
const RECEIVE_ERROR_BACKOFF_MS = 1000;
const INVALID_PAYLOAD_CODE = 'INVALID_PAYLOAD';
/** Visibilidade 0: a mensagem devolvida no shutdown fica disponível na hora para outra instância. */
const RELEASE_NOW_SECONDS = 0;

/** Subconjunto do logger usado pelo consumer. */
export type ConsumerLogger = Pick<PinoLogger, 'info' | 'warn' | 'error'>;

interface QueueUrls {
  transactions: string;
  transactionsDlq: string;
}

/**
 * Resultado de uma mensagem: saiu da fila principal (ack ou DLQ) ou ficou nela. `retryInSeconds`
 * é o atraso aplicado a ela, quando conhecido; as seguintes do grupo recebem o mesmo.
 */
type HandleOutcome = { left: true } | { left: false; retryInSeconds?: number };

/** Campos da mensagem que podem ir para o log: identificadores, nunca o payload nem valores. */
interface MessageLogContext {
  sqsMessageId: string | undefined;
  /** Mesmo valor de `messageId`: a entrega é o id de correlação do fluxo. */
  correlationId?: string;
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
 *
 * Uma mensagem que não sai da fila encerra o grupo no lote: as seguintes da mesma wallet voltam
 * para a fila sem serem processadas, para que nenhuma ultrapasse a que falhou.
 */
@Injectable()
export class WagerTransactionsConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  /** Sinaliza o desligamento; também interrompe a espera de back-off depois de um erro. */
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

  /**
   * Para de iniciar novos long polls e deixa o que está em andamento terminar (no máximo
   * `waitTimeSeconds`). As mensagens que ele devolver e as recebidas que ainda não começaram voltam
   * à fila com visibilidade 0 pelo próprio grupo (`processGroup`); as em andamento são esperadas por
   * até `shutdownTimeoutMs`. O long poll não é abortado porque o SQS pode responder a uma requisição
   * que o cliente já abandonou: a mensagem ficaria escondida até o visibility timeout, com uma
   * recepção a mais na contagem para a DLQ. Estourado o prazo, o shutdown segue: a transação aberta
   * é desfeita quando o pool fecha e a mensagem reaparece depois do visibility timeout.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    const { shutdownTimeoutMs } = this.config.consumer;
    const deadline = new AbortController();
    const finished = await Promise.race([
      Promise.all(this.loops).then(() => true),
      delay(shutdownTimeoutMs, false, { signal: deadline.signal }),
    ]);
    deadline.abort();
    if (!finished) {
      this.logger.warn(
        { shutdownTimeoutMs },
        'wager consumer shutdown timed out with messages in progress',
      );
    }
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
      // o timeout por chamada substitui o do cliente (1,5 s), que derrubaria o long poll; sem
      // abortSignal: no shutdown o long poll em andamento termina normalmente
      { requestTimeout: waitTimeSeconds * 1000 + LONG_POLL_TIMEOUT_MARGIN_MS },
    );
    return Messages;
  }

  /** Grupos (wallets) em paralelo; dentro do grupo, na ordem em que o SQS entregou. */
  private async processBatch(messages: Message[], urls: QueueUrls): Promise<void> {
    await Promise.all(
      [...groupByMessageGroup(messages).values()].map((group) => this.processGroup(group, urls)),
    );
  }

  /**
   * Mensagens do grupo uma de cada vez. A primeira que fica na fila encerra o grupo neste lote:
   * as seguintes voltam com o mesmo atraso dela e são recebidas de novo atrás dela, na ordem FIFO.
   * No shutdown, as que ainda não começaram voltam com visibilidade 0 assim que o grupo chega nelas.
   */
  private async processGroup(group: Message[], urls: QueueUrls): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (this.stopping) {
        await this.release(group.slice(index), RELEASE_NOW_SECONDS, urls);
        return;
      }
      const outcome = await this.handle(message, urls);
      if (!outcome.left) {
        // sem atraso conhecido (erro do SQS), as seguintes esperam o próprio visibility timeout
        if (outcome.retryInSeconds !== undefined) {
          await this.release(group.slice(index + 1), outcome.retryInSeconds, urls);
        }
        return;
      }
    }
  }

  /** Devolve mensagens não processadas à fila, visíveis depois de `seconds`. */
  private async release(messages: Message[], seconds: number, urls: QueueUrls): Promise<void> {
    for (const message of messages) {
      try {
        await this.changeVisibility(message, seconds, urls);
      } catch (error) {
        // a mensagem volta sozinha quando o visibility timeout vencer
        this.logger.error(
          { sqsMessageId: message.MessageId, err: safeError(error) },
          'wager message release failed',
        );
      }
    }
  }

  /**
   * Um erro do próprio SQS no ack, no envio para a DLQ ou na troca de visibilidade só é logado:
   * a mensagem reaparece depois do visibility timeout e a inbox impede efeito duplicado.
   */
  private async handle(message: Message, urls: QueueUrls): Promise<HandleOutcome> {
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
      return { left: false };
    }
  }

  private async dispatch(
    message: Message,
    urls: QueueUrls,
    context: MessageLogContext,
  ): Promise<HandleOutcome> {
    const parsed = parseWagerMessage(message.Body ?? '');
    if (!parsed.ok) {
      await this.deadLetter(message, INVALID_PAYLOAD_CODE, urls);
      this.logger.warn(
        { ...context, failureCode: INVALID_PAYLOAD_CODE },
        'wager message dead-lettered',
      );
      return { left: true };
    }

    const { messageId, data } = parsed.message;
    Object.assign(context, {
      correlationId: messageId,
      messageId,
      walletId: data.walletId,
      providerId: data.providerId,
    });

    const startedAt = performance.now();
    let result: ProcessWagerResult;
    try {
      result = await this.processWager.execute(toCommand(parsed.message));
    } catch (error) {
      return this.handleFailure(message, error, urls, context);
    }

    await this.ack(message, urls.transactions);
    const { transaction, idempotentReplay } = result;
    this.logger.info(
      { ...context, ...wagerOutcomeFields(transaction, idempotentReplay, startedAt) },
      'wager message processed',
    );
    return { left: true };
  }

  private async handleFailure(
    message: Message,
    error: unknown,
    urls: QueueUrls,
    context: MessageLogContext,
  ): Promise<HandleOutcome> {
    const action = failureAction(error, context.receiveCount);
    if (action.kind === 'dead-letter') {
      await this.deadLetter(message, action.failureCode, urls);
      this.logger.warn(
        { ...context, failureCode: action.failureCode },
        'wager message dead-lettered',
      );
      return { left: true };
    }
    await this.changeVisibility(message, action.delaySeconds, urls);
    this.logger.warn(
      { ...context, err: safeError(error), retryInSeconds: action.delaySeconds },
      'wager message will be retried',
    );
    return { left: false, retryInSeconds: action.delaySeconds };
  }

  private async changeVisibility(
    message: Message,
    seconds: number,
    urls: QueueUrls,
  ): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: urls.transactions,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
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
