import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard global de autenticação, com a autenticação desligada: libera todas as requisições.
 *
 * Rotas marcadas com `@Public()` (health checks) são sempre abertas; as demais são o ponto de
 * extensão para validar o bearer token de um IdP externo (desenho descrito no ARCHITECTURE.md).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // autenticação desligada: rotas protegidas também são liberadas
    return true;
  }
}
