import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { PublishOutboxUseCase } from '../../application/messaging/publish-outbox.use-case';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { safeError } from '../logging/safe-error';

/** Subconjunto do logger usado pelo worker. */
export type WorkerLogger = Pick<PinoLogger, 'info' | 'warn' | 'error'>;

/**
 * Loop do publisher da outbox, um por instância: roda um ciclo, espera `pollIntervalMs` e repete.
 * Lote cheio publicado → o próximo ciclo começa na hora (ainda há fila); ciclo com falhas espera o
 * intervalo, para não varrer a outbox em ritmo de banco enquanto o SQS está fora. Um ciclo com
 * erro é logado e o loop segue. Não guarda estado de mensagens em memória: a coordenação entre
 * instâncias é toda no banco.
 *
 * Para em `beforeApplicationShutdown`, antes de o pool do Postgres e o cliente SQS serem fechados,
 * e espera o ciclo em andamento terminar (nada fica publicado sem ser marcado por causa do shutdown).
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentCycle: Promise<void> | undefined;

  constructor(
    private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(OutboxPublisherWorker.name) private readonly logger: WorkerLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outboxPublisher.enabled) return;
    this.running = true;
    this.scheduleNext(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.currentCycle;
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.currentCycle = this.cycle().finally(() => {
        this.currentCycle = undefined;
      });
    }, delayMs);
  }

  private async cycle(): Promise<void> {
    const { batchSize, pollIntervalMs } = this.config.outboxPublisher;
    let delayMs = pollIntervalMs;
    try {
      const { published, failures } = await this.publishOutbox.runOnce();
      for (const { error, ...ids } of failures) {
        // ids do evento e só o erro seguro, nunca o conteúdo
        this.logger.warn({ ...ids, err: safeError(error) }, 'outbox message failed to publish');
      }
      // só lote cheio de sucessos volta na hora; com falhas (SQS fora) espera o intervalo
      if (published >= batchSize) delayMs = 0;
    } catch (error) {
      // só o erro (banco/SQS), nunca o conteúdo dos eventos
      this.logger.error({ err: safeError(error) }, 'outbox publish cycle failed');
    }
    if (this.running) this.scheduleNext(delayMs);
  }
}
