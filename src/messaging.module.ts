import { Module } from '@nestjs/common';
import { PublishOutboxUseCase } from './application/messaging/publish-outbox.use-case';
import { CLOCK, type Clock } from './application/ports/clock';
import { EVENT_PUBLISHER, type EventPublisher } from './application/ports/event-publisher';
import { METRICS, type Metrics } from './application/ports/metrics';
import { OUTBOX_REPOSITORY, type OutboxRepository } from './application/ports/outbox.repository';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/config';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';

/**
 * Publicação dos eventos da outbox: caso de uso (montado por factory, sem decorators na
 * aplicação), adaptador SQS e o worker que roda o ciclo em segundo plano.
 */
@Module({
  providers: [
    { provide: EVENT_PUBLISHER, useClass: SqsEventPublisher },
    {
      provide: PublishOutboxUseCase,
      inject: [OUTBOX_REPOSITORY, EVENT_PUBLISHER, CLOCK, METRICS, APP_CONFIG],
      useFactory: (
        outbox: OutboxRepository,
        publisher: EventPublisher,
        clock: Clock,
        metrics: Metrics,
        config: AppConfig,
      ) =>
        new PublishOutboxUseCase({
          outbox,
          publisher,
          clock,
          metrics,
          batchSize: config.outboxPublisher.batchSize,
          leaseMs: config.outboxPublisher.leaseMs,
        }),
    },
    OutboxPublisherWorker,
  ],
})
export class MessagingModule {}
