import { Global, Module } from '@nestjs/common';
import { METRICS } from './application/ports/metrics';
import { PrometheusMetrics } from './infrastructure/metrics/prometheus-metrics';
import { OutboxBacklogQuery } from './infrastructure/persistence/queries/outbox-backlog.query';
import { MetricsController } from './interfaces/http/metrics.controller';

/** Prazo da consulta da outbox na coleta: uma coleta lenta não pode travar o scrape. */
export const BACKLOG_TIMEOUT_MS = 1000;

/**
 * Métricas Prometheus: o adaptador atende a porta `Metrics` dos casos de uso e do consumer, e o
 * controller expõe o registry em `/metrics`. Global para que os módulos de negócio injetem a porta.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    OutboxBacklogQuery,
    {
      provide: PrometheusMetrics,
      inject: [OutboxBacklogQuery],
      useFactory: (backlog: OutboxBacklogQuery) =>
        new PrometheusMetrics(() => backlog.read(), BACKLOG_TIMEOUT_MS),
    },
    { provide: METRICS, useExisting: PrometheusMetrics },
  ],
  exports: [METRICS],
})
export class MetricsModule {}
