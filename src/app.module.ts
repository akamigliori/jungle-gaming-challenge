import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './infrastructure/auth/auth.guard';
import type { AppConfig } from './infrastructure/config/config';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { WalletModule } from './wallet.module';

/** Módulo raiz: compõe a infraestrutura, os módulos de negócio, os controllers HTTP e o guard/filtro globais. */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [InfrastructureModule.forRoot(config), WalletModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
