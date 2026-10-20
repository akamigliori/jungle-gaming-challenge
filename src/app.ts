import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './infrastructure/config/config';

/** Cria a aplicação Nest (sem escutar porta), usada pelo `main.ts` e pelos testes. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    bufferLogs: true,
    // erros de bootstrap são lançados ao chamador em vez de encerrar o processo
    abortOnError: false,
  });
  // logs do próprio Nest também saem em JSON pelo pino
  app.useLogger(app.get(Logger));
  return app;
}
