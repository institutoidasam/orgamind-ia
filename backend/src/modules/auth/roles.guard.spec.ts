import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { ForbiddenError } from '../../shared/errors/domain.error';
import { ROLES_KEY, Roles } from './decorators/roles.decorator';
import { RequirePermission } from './decorators/require-permission.decorator';

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
    key === ROLES_KEY ? roles : undefined,
  );
}

@Roles('ADMIN')
class RolesOnClass {
  @RequirePermission('pessoas.editar')
  withPermission() {}
}

@RequirePermission('pessoas.editar')
class PermissionOnClass {
  plain() {}
  @Roles('ADMIN')
  withRoles() {}
}

class Bare {
  plain() {}
}

/** Rota real (classe e handler decorados), para o Reflector ler os metadados de verdade. */
function routeContext(
  controller: new () => object,
  handler: string,
  role: Role,
): ExecutionContext {
  const proto = controller.prototype as Record<string, () => void>;
  return {
    getClass: () => controller,
    getHandler: () => proto[handler],
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard com @RequirePermission (DB3)', () => {
  const guard = new RolesGuard(new Reflector());

  it('@RequirePermission no handler passa mesmo com @Roles na classe', () => {
    const ctx = routeContext(RolesOnClass, 'withPermission', 'SUPERVISOR');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('@RequirePermission na classe e handler sem @Roles passa para SUPERVISOR', () => {
    const ctx = routeContext(PermissionOnClass, 'plain', 'SUPERVISOR');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('@RequirePermission na classe e @Roles(ADMIN) no handler: o @Roles do handler vale e SUPERVISOR recebe 403', () => {
    const supervisor = routeContext(
      PermissionOnClass,
      'withRoles',
      'SUPERVISOR',
    );
    const admin = routeContext(PermissionOnClass, 'withRoles', 'ADMIN');

    expect(() => guard.canActivate(supervisor)).toThrow(ForbiddenError);
    expect(guard.canActivate(admin)).toBe(true);
  });
});

describe('RolesGuard sem @RequirePermission (DB3)', () => {
  const guard = new RolesGuard(new Reflector());

  it('rota sem nada continua só ADMIN e OPERATOR', () => {
    const allowed = (['ADMIN', 'OPERATOR'] as Role[]).map((role) =>
      guard.canActivate(routeContext(Bare, 'plain', role)),
    );
    const denied = (['SUPERVISOR', 'VIEWER'] as Role[]).map(
      (role) => () => guard.canActivate(routeContext(Bare, 'plain', role)),
    );

    expect(allowed).toEqual([true, true]);
    for (const attempt of denied) expect(attempt).toThrow(ForbiddenError);
  });
});

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
