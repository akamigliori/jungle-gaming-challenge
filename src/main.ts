import 'reflect-metadata';
import { createApp } from './app';
import { loadConfig } from './infrastructure/config/config';

/** Folga sobre o prazo do consumer para o resto do shutdown (HTTP, pool, cliente SQS). */
const FORCED_EXIT_MARGIN_MS = 5000;
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  // SIGTERM/SIGINT disparam os hooks de shutdown (fecha HTTP, pool do Postgres e cliente SQS)
  app.enableShutdownHooks();
  // se algum hook travar, o processo sai mesmo assim; `once` para não segurar o sinal que o Nest
  // reenvia ao terminar, e `unref` para o timer não manter vivo um processo que já acabou
  const forcedExitMs = config.consumer.shutdownTimeoutMs + FORCED_EXIT_MARGIN_MS;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      setTimeout(() => process.exit(1), forcedExitMs).unref();
    });
  }
  await app.listen(config.port);
}

void bootstrap();
