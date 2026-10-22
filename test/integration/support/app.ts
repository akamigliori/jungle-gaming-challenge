import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { APP_OPTIONS, configureApp, createApp } from '../../../src/app';
import { AppModule } from '../../../src/app.module';
import { type AppConfig, type Env, loadConfig } from '../../../src/infrastructure/config/config';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * O nestjs-pino mantém um único logger raiz por processo, criado (com destino e nível) pela
 * primeira aplicação que sobe, e as demais o reaproveitam. Por isso toda aplicação de teste escreve
 * neste destino fixo, que repassa as linhas à captura da vez (se houver).
 */
const logSink = new (class extends Writable {
  target: Writable | undefined;

  override _write(chunk: Buffer | string, encoding: BufferEncoding, done: () => void): void {
    if (this.target) this.target.write(chunk, encoding, done);
    else done();
  }
})();

/** Permite substituir providers (ex.: um repositório que falha) antes de subir a aplicação. */
export type OverrideProviders = (builder: TestingModuleBuilder) => TestingModuleBuilder;

/**
 * Sobe a aplicação real numa porta livre, apontando para o banco `wagering_test`.
 * `overrides` troca variáveis de ambiente sem alterar `process.env`; `overrideProviders`
 * troca providers do container de DI. Logs ficam silenciosos, a menos que `TEST_LOG_LEVEL` seja
 * definido (o `LOG_LEVEL` do `.env` é ignorado aqui). O publisher da outbox, o consumer SQS e o worker
 * de referências pendentes ficam desligados, a menos que `overrides` os liguem. `logDestination`
 * recebe as linhas de log; o nível vem de `LOG_LEVEL` em `overrides` e vale até o `close()`.
 */
export async function createTestApp(
  overrides: Partial<Env> = {},
  overrideProviders?: OverrideProviders,
  logDestination?: Writable,
): Promise<TestApp> {
  const config = loadConfig({
    ...process.env,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DB_NAME: process.env.TEST_DB_NAME ?? 'wagering_test',
    // o publisher em segundo plano alteraria a outbox que as suítes conferem; quem precisa liga
    OUTBOX_PUBLISHER_ENABLED: 'false',
    // o consumer leria a fila padrão do ambiente local; a suíte do consumer liga com filas próprias
    SQS_CONSUMER_ENABLED: 'false',
    // o worker resolveria pendências que as suítes conferem paradas; quem precisa liga
    PENDING_REFERENCE_WORKER_ENABLED: 'false',
    ...overrides,
  });
  const app = overrideProviders
    ? await createAppWithOverrides(config, overrideProviders, logSink)
    : await createApp(config, logSink);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  // o logger raiz pode ser o de outra aplicação (ver `logSink`): captura e nível valem para esta
  const root = PinoLogger.root;
  const previousLevel = root?.level;
  if (logDestination && root) {
    logSink.target = logDestination;
    root.level = config.logLevel;
  }
  const close = async () => {
    await app.close();
    if (logDestination && root && previousLevel) {
      logSink.target = undefined;
      root.level = previousLevel;
    }
  };
  return { app, baseUrl: `http://127.0.0.1:${port}`, close };
}

async function createAppWithOverrides(
  config: AppConfig,
  overrideProviders: OverrideProviders,
  logDestination?: Writable,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config, logDestination)],
  });
  const moduleRef = await overrideProviders(builder).compile();
  return configureApp(moduleRef.createNestApplication(APP_OPTIONS));
}
