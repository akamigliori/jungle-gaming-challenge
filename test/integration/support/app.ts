import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { APP_OPTIONS, configureApp, createApp } from '../../../src/app';
import { AppModule } from '../../../src/app.module';
import { type AppConfig, type Env, loadConfig } from '../../../src/infrastructure/config/config';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/** Permite substituir providers (ex.: um repositório que falha) antes de subir a aplicação. */
export type OverrideProviders = (builder: TestingModuleBuilder) => TestingModuleBuilder;

/**
 * Sobe a aplicação real numa porta livre, apontando para o banco `wagering_test`.
 * `overrides` troca variáveis de ambiente sem alterar `process.env`; `overrideProviders`
 * troca providers do container de DI. Logs ficam silenciosos, a menos que `TEST_LOG_LEVEL` seja
 * definido (o `LOG_LEVEL` do `.env` é ignorado aqui). O publisher da outbox e o consumer SQS ficam
 * desligados, a menos que `overrides` os liguem.
 */
export async function createTestApp(
  overrides: Partial<Env> = {},
  overrideProviders?: OverrideProviders,
): Promise<TestApp> {
  const config = loadConfig({
    ...process.env,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DB_NAME: process.env.TEST_DB_NAME ?? 'wagering_test',
    // o publisher em segundo plano alteraria a outbox que as suítes conferem; quem precisa liga
    OUTBOX_PUBLISHER_ENABLED: 'false',
    // o consumer leria a fila padrão do ambiente local; a suíte do consumer liga com filas próprias
    SQS_CONSUMER_ENABLED: 'false',
    ...overrides,
  });
  const app = overrideProviders
    ? await createAppWithOverrides(config, overrideProviders)
    : await createApp(config);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}

async function createAppWithOverrides(
  config: AppConfig,
  overrideProviders: OverrideProviders,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] });
  const moduleRef = await overrideProviders(builder).compile();
  return configureApp(moduleRef.createNestApplication(APP_OPTIONS));
}
