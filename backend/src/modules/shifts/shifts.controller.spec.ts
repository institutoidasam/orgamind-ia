import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ShiftsController } from './shifts.controller';
import type { ShiftsService } from './shifts.service';

type Handler = 'list' | 'create' | 'update' | 'reorder';
const HANDLERS = Object.getOwnPropertyNames(ShiftsController.prototype).filter(
  (name) => name !== 'constructor',
) as Handler[];

function context(handler: Handler, role: string) {
  return {
    getHandler: () => ShiftsController.prototype[handler],
    getClass: () => ShiftsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('ShiftsController — autorização', () => {
  it('todas as rotas exigem ADMIN', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);

    expect([...HANDLERS].sort()).toEqual([
      'create',
      'list',
      'reorder',
      'update',
    ]);
    expect(reflector.get(ROLES_KEY, ShiftsController)).toEqual(['ADMIN']);
    for (const handler of HANDLERS) {
      // Nenhuma rota sobrescreve o papel do controller.
      expect(
        reflector.get(ROLES_KEY, ShiftsController.prototype[handler]),
      ).toBeUndefined();
      for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER']) {
        expect(() => guard.canActivate(context(handler, role))).toThrow(
          expect.objectContaining({
            status: 403,
            code: 'auth.insufficient_role',
          }),
        );
      }
      expect(guard.canActivate(context(handler, 'ADMIN'))).toBe(true);
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
