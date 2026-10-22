import 'reflect-metadata';
import { createApp } from './app';
import { loadConfig } from './infrastructure/config/config';

/** Folga sobre o prazo do consumer para o resto do shutdown (HTTP, pool, cliente SQS). */
const FORCED_EXIT_MARGIN_MS = 5000;
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  const forcedExitMs = config.consumer.shutdownTimeoutMs + FORCED_EXIT_MARGIN_MS;
  let shuttingDown = false;

  /**
   * Os sinais são tratados aqui, e não pelo `enableShutdownHooks` do Nest, porque ele reenvia o
   * sinal ao terminar e o processo sairia com 143 mesmo num desligamento limpo. `app.close()` roda
   * os mesmos hooks (consumer, workers, HTTP, pool do Postgres, cliente SQS) e o processo sai com 0.
   */
  const shutdown = (): void => {
    // um segundo sinal durante o desligamento não inicia outro `close`
    if (shuttingDown) return;
    shuttingDown = true;
    // se algum hook travar, o processo sai mesmo assim; `unref` para o timer não manter vivo um
    // processo que já terminou
    setTimeout(() => process.exit(EXIT_FAILURE), forcedExitMs).unref();
    app.close().then(
      () => process.exit(EXIT_OK),
      (error: unknown) => {
        console.error('shutdown failed', error);
        process.exit(EXIT_FAILURE);
      },
    );
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, shutdown);

  await app.listen(config.port);
}

void bootstrap();
