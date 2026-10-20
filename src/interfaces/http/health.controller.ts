import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Public } from '../../infrastructure/auth/public.decorator';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/config';
import { SQS_CLIENT } from '../../infrastructure/sqs/sqs.client';

/** Tempo máximo de cada verificação de readiness. */
export const READINESS_TIMEOUT_MS = 2000;

type CheckStatus = 'up' | 'down';

interface StatusResponse {
  status(code: number): unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Health checks: abertos (sem autenticação), conforme exigido. */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: o processo responde; não consulta dependências externas. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: Postgres e SQS alcançáveis, verificados em paralelo e com timeout. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: StatusResponse) {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.getConnection().execute('SELECT 1')),
      this.check((signal) => this.checkQueues(signal)),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    if (!ok) res.status(503);
    return { status: ok ? 'ok' : 'error', checks: { postgres, sqs } };
  }

  private async checkQueues(abortSignal: AbortSignal): Promise<void> {
    const names = Object.values(this.config.sqs.queues);
    await Promise.all(
      names.map((QueueName) =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName }), { abortSignal }),
      ),
    );
  }

  private async check(run: (signal: AbortSignal) => Promise<unknown>): Promise<CheckStatus> {
    const controller = new AbortController();
    try {
      await withTimeout(run(controller.signal), READINESS_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    } finally {
      controller.abort();
    }
  }
}
