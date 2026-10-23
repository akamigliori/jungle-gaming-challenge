import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { AuthenticatedRequest } from './auth-request';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from './provider-identity.port';
import { IS_PUBLIC_KEY } from './public.decorator';
import { REQUIRED_SCOPES_KEY } from './require-scope.decorator';

/**
 * Guard global de autenticação. Com `AUTH_ENABLED=false` (padrão), libera todas as requisições;
 * com `AUTH_ENABLED=true`, exige um bearer token válido, confere os escopos exigidos pela rota e
 * grava o `providerId` e os escopos do token em `request.auth` para os controllers conferirem
 * contra o corpo/caminho.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    if (!this.config.auth.enabled) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const resolved = await this.identity.resolve(request);
    if (!resolved) throw new UnauthorizedException();

    const requiredScopes = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredScopes?.some((scope) => !resolved.scopes.includes(scope))) {
      throw new ForbiddenException();
    }

    request.auth = resolved;
    return true;
  }
}
