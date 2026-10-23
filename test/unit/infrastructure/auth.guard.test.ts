import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../../../src/infrastructure/auth/auth.guard';
import type { ProviderIdentityPort } from '../../../src/infrastructure/auth/provider-identity.port';
import { IS_PUBLIC_KEY, Public } from '../../../src/infrastructure/auth/public.decorator';
import { RequireScope } from '../../../src/infrastructure/auth/require-scope.decorator';
import { SCOPE_WAGERS_SUBMIT } from '../../../src/infrastructure/auth/scopes';
import type { AppConfig } from '../../../src/infrastructure/config/config';

class Controller {
  @Public()
  open() {}

  @RequireScope(SCOPE_WAGERS_SUBMIT)
  submit() {}

  closed() {}
}

const contextFor = (handler: () => void, request: unknown = {}) =>
  ({
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const authConfig = (enabled: boolean): AppConfig =>
  ({
    auth: { enabled, oidcIssuer: '', oidcAudience: '', oidcJwksUri: '' },
  }) as unknown as AppConfig;

const noIdentity: ProviderIdentityPort = { resolve: async () => null };
const identityOf = (providerId: string): ProviderIdentityPort => ({
  resolve: async () => ({ providerId, scopes: [] }),
});

describe('Public', () => {
  test('marks the handler as public', () => {
    expect(new Reflector().get(IS_PUBLIC_KEY, Controller.prototype.open)).toBe(true);
    expect(new Reflector().get(IS_PUBLIC_KEY, Controller.prototype.closed)).toBeUndefined();
  });
});

describe('AuthGuard', () => {
  test('allows public routes even with auth enabled', async () => {
    const guard = new AuthGuard(new Reflector(), authConfig(true), noIdentity);
    expect(await guard.canActivate(contextFor(Controller.prototype.open))).toBe(true);
  });

  test('allows non-public routes while auth is disabled', async () => {
    const guard = new AuthGuard(new Reflector(), authConfig(false), noIdentity);
    expect(await guard.canActivate(contextFor(Controller.prototype.closed))).toBe(true);
  });

  test('rejects a request without a valid token when auth is enabled', async () => {
    const guard = new AuthGuard(new Reflector(), authConfig(true), noIdentity);
    await expect(guard.canActivate(contextFor(Controller.prototype.closed))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  test('attaches the resolved identity to the request', async () => {
    const guard = new AuthGuard(new Reflector(), authConfig(true), identityOf('provider-a'));
    const request: Record<string, unknown> = {};
    expect(await guard.canActivate(contextFor(Controller.prototype.closed, request))).toBe(true);
    expect(request.auth).toEqual({ providerId: 'provider-a', scopes: [] });
  });

  test('rejects a missing scope with 403 when auth is enabled', async () => {
    const guard = new AuthGuard(new Reflector(), authConfig(true), identityOf('provider-a'));
    await expect(guard.canActivate(contextFor(Controller.prototype.submit))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test('allows a request whose token carries the required scope', async () => {
    const identity: ProviderIdentityPort = {
      resolve: async () => ({ providerId: 'provider-a', scopes: [SCOPE_WAGERS_SUBMIT] }),
    };
    const guard = new AuthGuard(new Reflector(), authConfig(true), identity);
    expect(await guard.canActivate(contextFor(Controller.prototype.submit))).toBe(true);
  });
});
