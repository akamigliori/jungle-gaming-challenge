import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { OutboxBacklog } from '../../metrics/prometheus-metrics';

/**
 * Pendência da outbox lida direto do banco, para os gauges de métricas. A consulta usa o índice
 * parcial dos eventos não publicados e a idade vem do relógio do banco.
 */
@Injectable()
export class OutboxBacklogQuery {
  constructor(private readonly em: EntityManager) {}

  async read(): Promise<OutboxBacklog> {
    const [row] = await this.em
      .getConnection()
      .execute<{ pending: number; oldest_age_seconds: number }[]>(`
      SELECT
        COUNT(*)::INT AS pending,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))), 0)::FLOAT8 AS oldest_age_seconds
      FROM outbox_messages
      WHERE published_at IS NULL`);
    return { pending: row?.pending ?? 0, oldestAgeSeconds: row?.oldest_age_seconds ?? 0 };
  }
}
