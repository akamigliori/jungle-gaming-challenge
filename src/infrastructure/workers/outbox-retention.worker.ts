import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../../application/ports/clock';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '../../application/ports/outbox.repository';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { safeError } from '../logging/safe-error';
import type { WorkerLogger } from './outbox-publisher.worker';

/**
 * Worker de retenção da outbox, um por instância: apaga, em lote, os eventos já publicados há mais
 * de `maxAgeMs`, na ordem de `published_at`. A deleção é idempotente e fora de qualquer caminho de
 * publicação (o publisher só enxerga `published_at IS NULL`), então apagar uma linha publicada não
 * afeta a entrega, que já aconteceu. Várias instâncias podem rodar juntas: cada `DELETE` é uma
 * transação própria e uma linha apagada por uma instância não volta para as outras.
 *
 * Mesmo esqueleto dos demais workers: ciclo, espera de `pollIntervalMs` (na hora, quando um lote
 * veio cheio) e parada em `beforeApplicationShutdown` aguardando o ciclo em andamento.
 */
@Injectable()
export class OutboxRetentionWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentCycle: Promise<void> | undefined;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(OutboxRetentionWorker.name) private readonly logger: WorkerLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outboxRetention.enabled) return;
    this.running = true;
    this.scheduleNext(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.currentCycle;
  }

  /** Um ciclo: calcula o corte (`now - maxAgeMs`) e apaga até um lote de publicadas antigas. */
  async runOnce(): Promise<{ deleted: number }> {
    const { batchSize, maxAgeMs } = this.config.outboxRetention;
    const cutoff = new Date(this.clock.now().getTime() - maxAgeMs);
    const deleted = await this.outbox.deletePublishedOlderThan(cutoff, batchSize);
    return { deleted };
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.currentCycle = this.cycle().finally(() => {
        this.currentCycle = undefined;
      });
    }, delayMs);
  }

  private async cycle(): Promise<void> {
    const { batchSize, pollIntervalMs } = this.config.outboxRetention;
    let delayMs = pollIntervalMs;
    try {
      const { deleted } = await this.runOnce();
      if (deleted > 0) {
        this.logger.info({ deleted }, 'outbox retention deleted published events');
      }
      // lote cheio: ainda pode haver mais para apagar, então volta na hora
      if (deleted >= batchSize) delayMs = 0;
    } catch (error) {
      this.logger.error({ err: safeError(error) }, 'outbox retention cycle failed');
    }
    if (this.running) this.scheduleNext(delayMs);
  }
}
