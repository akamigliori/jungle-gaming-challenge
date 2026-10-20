import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';
import { CLOCK } from '../application/ports/clock';
import { ID_GENERATOR } from '../application/ports/id-generator';
import { APP_CONFIG, type AppConfig } from './config/config';
import { UuidV7IdGenerator } from './ids/uuid-v7.id-generator';
import { createLoggerModule } from './logging/logger.module';
import { createOrmConfig } from './persistence/mikro-orm.config';
import { createSqsClient, SQS_CLIENT } from './sqs/sqs.client';
import { SystemClock } from './time/system.clock';

/**
 * Módulo global com os adaptadores de infraestrutura: configuração, logs, MikroORM,
 * cliente SQS, gerador de ids e relógio. Recebe a configuração pronta para que testes
 * possam sobrescrever variáveis de ambiente sem mexer em `process.env`.
 */
@Module({})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: InfrastructureModule,
      global: true,
      imports: [
        createLoggerModule(config),
        MikroOrmModule.forRootAsync({
          // sem `ensureDatabase`: a aplicação sobe mesmo com o Postgres fora do ar
          // (o readiness reporta `down`); criar o banco é papel das migrations
          useFactory: () => ({ ...createOrmConfig(config), ensureDatabase: false }),
        }),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
        { provide: CLOCK, useClass: SystemClock },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
      ],
      exports: [APP_CONFIG, ID_GENERATOR, CLOCK, SQS_CLIENT],
    };
  }

  /** O MikroOrmModule fecha o pool do Postgres; aqui liberamos as conexões do SQS. */
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
