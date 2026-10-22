import 'reflect-metadata';
import type { Writable } from 'node:stream';
import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './infrastructure/config/config';

export const APP_OPTIONS: NestApplicationOptions = {
  bufferLogs: true,
  // erros de bootstrap são lançados ao chamador em vez de encerrar o processo
  abortOnError: false,
};

/** Ajustes aplicados à aplicação já criada (produção e testes). */
export function configureApp(app: INestApplication): INestApplication {
  // logs do próprio Nest também saem em JSON pelo pino
  app.useLogger(app.get(Logger));
  return app;
}

/** Cria a aplicação Nest (sem escutar porta), usada pelo `main.ts` e pelos testes. */
export async function createApp(
  config: AppConfig,
  logDestination?: Writable,
): Promise<INestApplication> {
  return configureApp(
    await NestFactory.create(AppModule.forRoot(config, logDestination), APP_OPTIONS),
  );
}
