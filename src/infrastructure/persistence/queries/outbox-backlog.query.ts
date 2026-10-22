import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

/** Estado da outbox no momento da leitura. */
export interface OutboxBacklog {
  pending: number;
  /** Idade, em segundos, do evento não publicado mais antigo; 0 se não há pendentes. */
  oldestAgeSeconds: number;
}

/** Prazo da consulta no servidor: uma coleta não deve prender uma conexão do pool por mais que isso. */
const BACKLOG_STATEMENT_TIMEOUT = '1s';

/**
 * Pendência da outbox lida direto do banco, para os gauges de métricas. A consulta usa o índice
 * parcial dos eventos não publicados, a idade vem do relógio do banco e o `statement_timeout`
 * local à transação a cancela no servidor se demorar.
 */
@Injectable()
export class OutboxBacklogQuery {
  constructor(private readonly em: EntityManager) {}

  async read(): Promise<OutboxBacklog> {
    const connection = this.em.getConnection();
    const [row] = await connection.transactional(async (trx) => {
      await connection.execute(
        `SET LOCAL statement_timeout = '${BACKLOG_STATEMENT_TIMEOUT}'`,
        [],
        'run',
        trx,
      );
      return connection.execute<{ pending: number; oldest_age_seconds: number }[]>(
        `SELECT
           COUNT(*)::INT AS pending,
           COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))), 0)::FLOAT8 AS oldest_age_seconds
         FROM outbox_messages
         WHERE published_at IS NULL`,
        [],
        'all',
        trx,
      );
    });
    return { pending: row?.pending ?? 0, oldestAgeSeconds: row?.oldest_age_seconds ?? 0 };
  }
}
