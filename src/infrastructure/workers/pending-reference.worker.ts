import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../../application/ports/clock';
import {
  type ClaimedPendingReference,
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../../application/ports/wager-transaction.repository';
import { ResolvePendingReferenceUseCase } from '../../application/wager/resolve-pending-reference.use-case';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { safeError } from '../logging/safe-error';
import type { WorkerLogger } from './outbox-publisher.worker';

/**
 * Wallets processadas ao mesmo tempo por ciclo. Somado às 8 transações do consumer, ocupa o pool de
 * 10 conexões: o limite reduz a disputa. Quem encontra o pool cheio espera uma conexão antes de
 * abrir a transação, e nenhuma transação com o lock de uma wallet precisa de uma segunda conexão.
 */
export const PENDING_REFERENCE_PARALLEL_WALLETS = 2;

export interface PendingReferenceCycleResult {
  claimed: number;
}

/**
 * Loop das referências pendentes, um por instância, com o mesmo esqueleto do publisher da outbox:
 * reserva as pendências vencidas (claim com lease no banco, `FOR UPDATE SKIP LOCKED`), reavalia
 * cada uma pelo caso de uso e repete depois de `pollIntervalMs` (na hora, se o lote veio cheio).
 *
 * O lote é agrupado por wallet: dentro da wallet, um item por vez, na ordem do claim; wallets
 * diferentes em paralelo. Um item que falha é logado e fica para quando o lease vencer; os demais
 * seguem. Nenhum estado fica em memória: instância morta → as pendências voltam depois do lease.
 *
 * Para em `beforeApplicationShutdown` e espera o ciclo em andamento terminar.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentCycle: Promise<void> | undefined;

  constructor(
    private readonly resolvePending: ResolvePendingReferenceUseCase,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(PendingReferenceWorker.name) private readonly logger: WorkerLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.pendingReference.enabled) return;
    this.running = true;
    this.scheduleNext(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.currentCycle;
  }

  /** Um ciclo: reserva um lote e reavalia cada pendência. */
  async runOnce(): Promise<PendingReferenceCycleResult> {
    const { batchSize, leaseMs } = this.config.pendingReference;
    const batch = await this.transactions.claimDuePendingReferences({
      now: this.clock.now(),
      limit: batchSize,
      leaseMs,
    });
    const groups = groupByWallet(batch);
    const workers = Math.min(PENDING_REFERENCE_PARALLEL_WALLETS, groups.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let group = groups.shift(); group; group = groups.shift()) {
          await this.resolveGroup(group);
        }
      }),
    );
    return { claimed: batch.length };
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.currentCycle = this.cycle().finally(() => {
        this.currentCycle = undefined;
      });
    }, delayMs);
  }

  private async cycle(): Promise<void> {
    const { batchSize, pollIntervalMs } = this.config.pendingReference;
    let delayMs = pollIntervalMs;
    try {
      const { claimed } = await this.runOnce();
      // lote cheio: ainda pode haver pendências vencidas, então volta na hora
      if (claimed >= batchSize) delayMs = 0;
    } catch (error) {
      this.logger.error({ err: safeError(error) }, 'pending reference cycle failed');
    }
    if (this.running) this.scheduleNext(delayMs);
  }

  private async resolveGroup(group: ClaimedPendingReference[]): Promise<void> {
    for (const item of group) {
      try {
        const result = await this.resolvePending.execute({
          transactionId: item.id,
          walletId: item.walletId,
          claimToken: item.claimToken,
        });
        if (result.outcome === 'skipped') continue;
        this.logger.info(
          {
            transactionId: item.id,
            walletId: item.walletId,
            providerId: result.providerId,
            attempts: result.attempts,
            outcome: result.outcome,
          },
          'pending reference evaluated',
        );
      } catch (error) {
        // só ids e o erro, nunca valores; a pendência volta quando o lease vencer
        this.logger.error(
          { err: safeError(error), transactionId: item.id, walletId: item.walletId },
          'pending reference resolution failed',
        );
      }
    }
  }
}

/** Agrupa por wallet mantendo a ordem do claim dentro de cada grupo. */
function groupByWallet(batch: ClaimedPendingReference[]): ClaimedPendingReference[][] {
  const groups = new Map<string, ClaimedPendingReference[]>();
  for (const item of batch) {
    const group = groups.get(item.walletId);
    if (group) group.push(item);
    else groups.set(item.walletId, [item]);
  }
  return [...groups.values()];
}
