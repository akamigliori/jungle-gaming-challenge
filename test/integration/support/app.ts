import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/app';
import { type Env, loadConfig } from '../../../src/infrastructure/config/config';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Sobe a aplicação real numa porta livre, apontando para o banco `wagering_test`.
 * `overrides` troca variáveis de ambiente sem alterar `process.env`. Logs ficam
 * silenciosos, a menos que `LOG_LEVEL` seja definido.
 */
export async function createTestApp(overrides: Partial<Env> = {}): Promise<TestApp> {
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    ...process.env,
    DB_NAME: process.env.TEST_DB_NAME ?? 'wagering_test',
    ...overrides,
  });
  const app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}
