import 'reflect-metadata';
import { createApp } from './app';
import { loadConfig } from './infrastructure/config/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  // SIGTERM/SIGINT disparam os hooks de shutdown (fecha HTTP, pool do Postgres e cliente SQS)
  app.enableShutdownHooks();
  await app.listen(config.port);
}

void bootstrap();
