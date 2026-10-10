import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/roles.guard';
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

describe('InternalSectorsController', () => {
  it('exige ADMIN para criar e editar, e o guard real rejeita os demais papéis', () => {
    const guard = new RolesGuard(new Reflector());
    for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER']) {
      expect(() => guard.canActivate(context('create', role))).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'auth.insufficient_role',
        }),
      );
      expect(() => guard.canActivate(context('update', role))).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'auth.insufficient_role',
        }),
      );
    }
    expect(guard.canActivate(context('create', 'ADMIN'))).toBe(true);
    expect(guard.canActivate(context('update', 'ADMIN'))).toBe(true);
  });

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
    await controller.create(create);
    await controller.get('sector-1');
    await controller.update('sector-1', update);
    await controller.members('sector-1', { eligible: true });

    expect(service.list).toHaveBeenCalledWith(2, 50, false);
    expect(service.create).toHaveBeenCalledWith(create);
    expect(service.get).toHaveBeenCalledWith('sector-1');
    expect(service.update).toHaveBeenCalledWith('sector-1', update);
    expect(service.members).toHaveBeenCalledWith('sector-1', true);
  });
});
