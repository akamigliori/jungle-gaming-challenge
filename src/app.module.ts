import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './infrastructure/auth/auth.guard';
import type { AppConfig } from './infrastructure/config/config';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';

/** Módulo raiz: compõe a infraestrutura, os controllers HTTP e o guard/filtro globais. */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [InfrastructureModule.forRoot(config)],
      controllers: [HealthController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
