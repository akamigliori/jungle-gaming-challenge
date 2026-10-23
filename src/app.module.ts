import type { Writable } from 'node:stream';
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './infrastructure/auth/auth.guard';
import { AuthModule } from './infrastructure/auth/auth.module';
import type { AppConfig } from './infrastructure/config/config';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { MessagingModule } from './messaging.module';
import { MetricsModule } from './metrics.module';
import { PersistenceModule } from './persistence.module';
import { WageringModule } from './wagering.module';
import { WalletModule } from './wallet.module';

/** Módulo raiz: compõe a infraestrutura, os módulos de negócio, os controllers HTTP e o guard/filtro globais. */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logDestination?: Writable): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfrastructureModule.forRoot(config, logDestination),
        AuthModule,
        PersistenceModule,
        MetricsModule,
        WalletModule,
        WageringModule,
        MessagingModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
