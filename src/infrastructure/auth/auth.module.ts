import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { JwtProviderIdentity } from './jwt-provider-identity';
import { JwtVerifier } from './jwt-verifier';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from './provider-identity.port';

/** Identidade nula usada enquanto a autenticação está desligada. */
const noopIdentity: ProviderIdentityPort = { resolve: async () => null };

/**
 * Liga a porta `ProviderIdentityPort`: com `AUTH_ENABLED=true`, valida o bearer token contra o
 * IdP; desligada, resolve sempre `null` (o guard ignora o resultado nesse caso).
 */
@Module({
  providers: [
    {
      provide: PROVIDER_IDENTITY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ProviderIdentityPort =>
        config.auth.enabled
          ? new JwtProviderIdentity(
              new JwtVerifier({
                issuer: config.auth.oidcIssuer,
                audience: config.auth.oidcAudience,
                jwksUri: config.auth.oidcJwksUri,
              }),
            )
          : noopIdentity,
    },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
