import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSION_KEY } from '../auth/decorators/require-permission.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { PermissionsService } from '../permissions/permissions.service';
import {
  permissionsWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import { PERMISSION_DENIED_TEXT } from '../../shared/authz/permissions';
import { ShiftsController } from './shifts.controller';
import type { ShiftsService } from './shifts.service';

type Handler = 'list' | 'create' | 'update' | 'reorder';
const HANDLERS = Object.getOwnPropertyNames(ShiftsController.prototype).filter(
  (name) => name !== 'constructor',
) as Handler[];
const DENIED = {
  status: 403,
  code: 'auth.permission_denied',
  detail: PERMISSION_DENIED_TEXT['estrutura.manter'],
};

function context(handler: Handler, role: Role) {
  return {
    getHandler: () => ShiftsController.prototype[handler],
    getClass: () => ShiftsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

/** Cadeia do app: `RolesGuard`, depois `PermissionsGuard`; `change` ajusta a matriz do papel. */
async function passesGuards(
  handler: Handler,
  role: Role,
  change: PermissionChange = {},
) {
  const reflector = new Reflector();
  const permissions = {
    effectiveFor: (r: Role) => Promise.resolve(permissionsWith(r, change)),
  } as unknown as PermissionsService;
  const ctx = context(handler, role);
  return (
    new RolesGuard(reflector).canActivate(ctx) &&
    (await new PermissionsGuard(reflector, permissions).canActivate(ctx))
  );
}

describe('ShiftsController — autorização', () => {
  it('a classe exige estrutura.manter, sem @Roles em classe nem em rota', () => {
    const reflector = new Reflector();

    expect([...HANDLERS].sort()).toEqual([
      'create',
      'list',
      'reorder',
      'update',
    ]);
    expect(reflector.get(PERMISSION_KEY, ShiftsController)).toBe(
      'estrutura.manter',
    );
    expect(reflector.get(ROLES_KEY, ShiftsController)).toBeUndefined();
    for (const handler of HANDLERS) {
      const route = ShiftsController.prototype[handler];
      expect(reflector.get(ROLES_KEY, route)).toBeUndefined();
      expect(reflector.get(PERMISSION_KEY, route)).toBeUndefined();
    }
  });

  it('com a matriz inicial só o ADMIN passa; SUPERVISOR, OPERATOR e VIEWER recebem 403 auth.permission_denied', async () => {
    for (const handler of HANDLERS) {
      await expect(passesGuards(handler, 'ADMIN')).resolves.toBe(true);
      for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER'] as const) {
        await expect(passesGuards(handler, role)).rejects.toMatchObject(DENIED);
      }
    }
  });

  it('com estrutura.manter liberada ao SUPERVISOR, ele passa em todas as rotas e o OPERATOR segue negado', async () => {
    const grant = { grant: ['estrutura.manter'] } as const;
    for (const handler of HANDLERS) {
      await expect(passesGuards(handler, 'SUPERVISOR', grant)).resolves.toBe(
        true,
      );
      await expect(passesGuards(handler, 'OPERATOR')).rejects.toMatchObject(
        DENIED,
      );
    }
  });
});

describe('ShiftsController — bindings', () => {
  it('encaminha o ator do token, o id e o corpo ao serviço', async () => {
    const service = {
      list: vi.fn().mockResolvedValue({ items: [] }),
      create: vi.fn().mockResolvedValue({ id: 'shift_new' }),
      update: vi.fn().mockResolvedValue({ id: 'shift_first' }),
      reorder: vi.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new ShiftsController(
      service as unknown as ShiftsService,
    );
    const req = { user: { sub: 'admin-1' } } as never;
    const create = { name: 'Noite', startTime: '22:00', endTime: '06:00' };

    await controller.list();
    await controller.create(create, req);
    await controller.update('shift_first', { isActive: false }, req);
    await controller.reorder({ ids: ['shift_first'] }, req);

    expect(service.list).toHaveBeenCalledWith();
    expect(service.create).toHaveBeenCalledWith('admin-1', create);
    expect(service.update).toHaveBeenCalledWith('admin-1', 'shift_first', {
      isActive: false,
    });
    expect(service.reorder).toHaveBeenCalledWith('admin-1', {
      ids: ['shift_first'],
    });
  });
});
