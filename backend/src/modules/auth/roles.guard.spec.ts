import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ForbiddenError } from '../../shared/errors/domain.error';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

function makeContext(user: { role?: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function mockRoles(reflector: Reflector, roles: string[] | undefined): void {
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
    key === IS_PUBLIC_KEY ? undefined : roles,
  );
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('allows public routes without a request user', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValueOnce(true);
    expect(guard.canActivate(makeContext(undefined))).toBe(true);
  });

  it('keeps legacy unannotated routes available to ADMIN and OPERATOR', () => {
    mockRoles(reflector, undefined);
    const ctx = makeContext({ role: 'OPERATOR' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies a SUPERVISOR on an unannotated legacy route', () => {
    mockRoles(reflector, undefined);
    expect(() =>
      guard.canActivate(makeContext({ role: 'SUPERVISOR' })),
    ).toThrow(ForbiddenError);
  });

  it('denies a VIEWER on an unannotated legacy route', () => {
    mockRoles(reflector, undefined);
    expect(() => guard.canActivate(makeContext({ role: 'VIEWER' }))).toThrow(
      ForbiddenError,
    );
  });

  it('allows when role matches required', () => {
    mockRoles(reflector, ['ADMIN']);
    const ctx = makeContext({ role: 'ADMIN' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenError when role does not match', () => {
    mockRoles(reflector, ['ADMIN']);
    const ctx = makeContext({ role: 'OPERATOR' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
  });

  it('throws ForbiddenError when user is missing', () => {
    mockRoles(reflector, ['ADMIN']);
    const ctx = makeContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
  });

  it('throws ForbiddenError with code auth.insufficient_role', () => {
    mockRoles(reflector, ['ADMIN']);
    const ctx = makeContext({ role: 'OPERATOR' });
    try {
      guard.canActivate(ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe('auth.insufficient_role');
    }
  });
});
