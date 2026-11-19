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
import { InternalSectorsController } from './internal-sectors.controller';
import { InternalSectorsService } from './internal-sectors.service';

function controllerWithService() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn().mockResolvedValue({ id: 'sector-1' }),
    get: vi.fn().mockResolvedValue({ id: 'sector-1' }),
    update: vi.fn().mockResolvedValue({ id: 'sector-1' }),
    members: vi.fn().mockResolvedValue({ items: [] }),
  };
  return {
    service,
    controller: new InternalSectorsController(
      service as InternalSectorsService,
    ),
  };
}

function context(method: keyof InternalSectorsController, role?: string) {
  return {
    getHandler: () => InternalSectorsController.prototype[method],
    getClass: () => InternalSectorsController,
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : {} }),
    }),
  } as ExecutionContext;
}

const ACTOR = { user: { sub: 'sup-1', role: 'SUPERVISOR' } } as Parameters<
  InternalSectorsController['create']
>[1];
const GATED = ['create', 'get', 'update'] as const;
const OPEN = ['list', 'members'] as const;
const DENIED = {
  status: 403,
  code: 'auth.permission_denied',
  detail: PERMISSION_DENIED_TEXT['estrutura.manter'],
};

/** Cadeia do app: `RolesGuard`, depois `PermissionsGuard`; `change` ajusta a matriz do papel. */
async function passesGuards(
  method: (typeof GATED)[number],
  role: Role,
  change: PermissionChange = {},
) {
  const reflector = new Reflector();
  const permissions = {
    effectiveFor: (r: Role) => Promise.resolve(permissionsWith(r, change)),
  } as unknown as PermissionsService;
  const ctx = context(method, role);
  return (
    new RolesGuard(reflector).canActivate(ctx) &&
    (await new PermissionsGuard(reflector, permissions).canActivate(ctx))
  );
}

describe('InternalSectorsController — estrutura.manter em criar, ler e editar (DB5)', () => {
  it('create, get e update trocam @Roles pela chave; list e members seguem com @Roles A4', () => {
    const reflector = new Reflector();
    const handler = (name: keyof InternalSectorsController) =>
      InternalSectorsController.prototype[name];

    for (const name of GATED) {
      expect(reflector.get(PERMISSION_KEY, handler(name))).toBe(
        'estrutura.manter',
      );
      expect(reflector.get(ROLES_KEY, handler(name))).toBeUndefined();
    }
    for (const name of OPEN) {
      expect(reflector.get(PERMISSION_KEY, handler(name))).toBeUndefined();
      expect(reflector.get(ROLES_KEY, handler(name))).toEqual([
        'ADMIN',
        'SUPERVISOR',
        'OPERATOR',
        'VIEWER',
      ]);
    }
  });

  it('com a matriz inicial só o ADMIN passa; SUPERVISOR, OPERATOR e VIEWER recebem 403 auth.permission_denied', async () => {
    for (const name of GATED) {
      await expect(passesGuards(name, 'ADMIN')).resolves.toBe(true);
      for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER'] as const) {
        await expect(passesGuards(name, role)).rejects.toMatchObject(DENIED);
      }
    }
  });

  it('com estrutura.manter liberada ao SUPERVISOR, ele passa em criar, ler e editar e o OPERATOR segue negado', async () => {
    const grant = { grant: ['estrutura.manter'] } as const;
    for (const name of GATED) {
      await expect(passesGuards(name, 'SUPERVISOR', grant)).resolves.toBe(true);
      await expect(passesGuards(name, 'OPERATOR')).rejects.toMatchObject(
        DENIED,
      );
    }
  });
});

describe('InternalSectorsController', () => {
  it('mantém lista e membros disponíveis aos quatro papéis internos', () => {
    const guard = new RolesGuard(new Reflector());
    for (const role of ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER']) {
      expect(guard.canActivate(context('list', role))).toBe(true);
      expect(guard.canActivate(context('members', role))).toBe(true);
    }
  });

  it('encaminha os bindings de listagem, detalhe, criação, edição e membros', async () => {
    const { controller, service } = controllerWithService();
    const create = { name: 'Compras', code: 'COM' };
    const update = { isActive: false };

    await controller.list({ page: 2, pageSize: 50, activeOnly: false });
    await controller.create(create, ACTOR);
    await controller.get('sector-1', ACTOR);
    await controller.update('sector-1', update, ACTOR);
    await controller.members('sector-1', { eligible: true }, ACTOR);

    expect(service.list).toHaveBeenCalledWith(2, 50, false);
    expect(service.create).toHaveBeenCalledWith(create, 'sup-1', 'SUPERVISOR');
    expect(service.get).toHaveBeenCalledWith('sector-1', 'SUPERVISOR');
    expect(service.update).toHaveBeenCalledWith(
      'sector-1',
      update,
      'sup-1',
      'SUPERVISOR',
    );
    expect(service.members).toHaveBeenCalledWith(
      'sector-1',
      true,
      'SUPERVISOR',
    );
  });
});
