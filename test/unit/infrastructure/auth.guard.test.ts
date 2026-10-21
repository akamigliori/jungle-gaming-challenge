import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../../../src/infrastructure/auth/auth.guard';
import { IS_PUBLIC_KEY, Public } from '../../../src/infrastructure/auth/public.decorator';

class Controller {
  @Public()
  open() {}

  closed() {}
}

const contextFor = (handler: () => void) =>
  ({ getHandler: () => handler, getClass: () => Controller }) as unknown as ExecutionContext;

describe('Public', () => {
  test('marks the handler as public', () => {
    expect(new Reflector().get(IS_PUBLIC_KEY, Controller.prototype.open)).toBe(true);
    expect(new Reflector().get(IS_PUBLIC_KEY, Controller.prototype.closed)).toBeUndefined();
  });
});

describe('AuthGuard (no-op)', () => {
  const guard = new AuthGuard(new Reflector());

  test('allows public routes', async () => {
    expect(await guard.canActivate(contextFor(Controller.prototype.open))).toBe(true);
  });

  test('allows non-public routes while no identity provider is wired', async () => {
    expect(await guard.canActivate(contextFor(Controller.prototype.closed))).toBe(true);
  });
});
