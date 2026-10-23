import { describe, expect, test } from 'bun:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../../src/infrastructure/auth/auth.module';
import { JwtProviderIdentity } from '../../../src/infrastructure/auth/jwt-provider-identity';
import { PROVIDER_IDENTITY } from '../../../src/infrastructure/auth/provider-identity.port';
import { APP_CONFIG } from '../../../src/infrastructure/config/config';

const configFor = (enabled: boolean) =>
  ({
    auth: { enabled, oidcIssuer: 'i', oidcAudience: 'a', oidcJwksUri: 'https://idp/jwks' },
  }) as never;

/** Disponibiliza a configuração globalmente, como o `InfrastructureModule` faz no app real. */
function configModule(enabled: boolean) {
  @Global()
  @Module({
    providers: [{ provide: APP_CONFIG, useValue: configFor(enabled) }],
    exports: [APP_CONFIG],
  })
  class ConfigModule {}
  return ConfigModule;
}

describe('AuthModule', () => {
  test('com a autenticação desligada, resolve uma identidade nula (sem montar o JwtVerifier)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [configModule(false), AuthModule],
    }).compile();

    const identity = moduleRef.get(PROVIDER_IDENTITY);
    expect(await identity.resolve({})).toBeNull();
  });

  test('com a autenticação ligada, resolve o JwtProviderIdentity', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [configModule(true), AuthModule],
    }).compile();

    expect(moduleRef.get(PROVIDER_IDENTITY)).toBeInstanceOf(JwtProviderIdentity);
  });
});
