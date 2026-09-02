import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ForbiddenError } from '../../shared/errors/domain.error';

function makeContext(user: { role?: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('allows when no roles required', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const ctx = makeContext({ role: 'OPERATOR' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when role matches required', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
    const ctx = makeContext({ role: 'ADMIN' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenError when role does not match', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
    const ctx = makeContext({ role: 'OPERATOR' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
  });

  it('throws ForbiddenError when user is missing', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
    const ctx = makeContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
  });

  it('throws ForbiddenError with code auth.insufficient_role', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
    const ctx = makeContext({ role: 'OPERATOR' });
    try {
      guard.canActivate(ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe('auth.insufficient_role');
    }
  });
});
