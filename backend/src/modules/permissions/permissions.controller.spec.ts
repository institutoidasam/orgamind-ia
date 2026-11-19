import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSION_KEY } from '../auth/decorators/require-permission.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsController } from './permissions.controller';
import type { PermissionsService } from './permissions.service';

type Handler = 'matrix' | 'save' | 'restoreDefaults';
const HANDLERS: Handler[] = ['matrix', 'save', 'restoreDefaults'];

function context(handler: Handler, role: Role) {
  return {
    getHandler: () => PermissionsController.prototype[handler],
    getClass: () => PermissionsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('PermissionsController — autorização', () => {
  it('a classe exige @Roles(ADMIN) e nenhuma rota usa @RequirePermission', () => {
    const reflector = new Reflector();

    expect(reflector.get(ROLES_KEY, PermissionsController)).toEqual(['ADMIN']);
    for (const handler of HANDLERS) {
      const route = PermissionsController.prototype[handler];
      expect(reflector.get(PERMISSION_KEY, route)).toBeUndefined();
      expect(reflector.get(ROLES_KEY, route)).toBeUndefined();
    }
  });

  it('só o ADMIN lê e grava a matriz; SUPERVISOR, OPERATOR e VIEWER recebem 403 auth.insufficient_role', () => {
    const guard = new RolesGuard(new Reflector());

    for (const handler of HANDLERS) {
      expect(guard.canActivate(context(handler, 'ADMIN'))).toBe(true);
      for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER'] as const) {
        expect(() => guard.canActivate(context(handler, role))).toThrow(
          expect.objectContaining({
            status: 403,
            code: 'auth.insufficient_role',
          }),
        );
      }
    }
  });
});

describe('PermissionsController — bindings', () => {
  it('encaminha o ator do token (req.user.sub) ao PUT e ao restore-defaults', async () => {
    const matrix = { keys: [] };
    const service = {
      matrix: vi.fn().mockResolvedValue(matrix),
      save: vi.fn().mockResolvedValue(matrix),
      restoreDefaults: vi.fn().mockResolvedValue(matrix),
    };
    const controller = new PermissionsController(
      service as unknown as PermissionsService,
    );
    const req = { user: { sub: 'admin-1' } } as never;
    const dto = { roles: { SUPERVISOR: [], OPERATOR: [] } } as never;

    await expect(controller.matrix()).resolves.toBe(matrix);
    await expect(controller.save(dto, req)).resolves.toBe(matrix);
    await expect(controller.restoreDefaults(req)).resolves.toBe(matrix);

    expect(service.matrix).toHaveBeenCalledWith();
    expect(service.save).toHaveBeenCalledWith('admin-1', dto);
    expect(service.restoreDefaults).toHaveBeenCalledWith('admin-1');
  });
});
