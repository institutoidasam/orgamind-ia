import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { LevelsController } from './levels.controller';
import type { LevelsService } from './levels.service';

type Handler = 'list' | 'create' | 'update' | 'reorder';
const HANDLERS = Object.getOwnPropertyNames(LevelsController.prototype).filter(
  (name) => name !== 'constructor',
) as Handler[];

function context(handler: Handler, role: string) {
  return {
    getHandler: () => LevelsController.prototype[handler],
    getClass: () => LevelsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('LevelsController — autorização', () => {
  it('todas as rotas exigem ADMIN e não há rota de apagar', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);

    expect([...HANDLERS].sort()).toEqual([
      'create',
      'list',
      'reorder',
      'update',
    ]);
    expect(reflector.get(ROLES_KEY, LevelsController)).toEqual(['ADMIN']);
    for (const handler of HANDLERS) {
      // Nenhuma rota sobrescreve o papel do controller.
      expect(
        reflector.get(ROLES_KEY, LevelsController.prototype[handler]),
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

describe('LevelsController — bindings', () => {
  it('encaminha o id, o corpo e a lista de ids ao serviço', async () => {
    const service = {
      list: vi.fn().mockResolvedValue({ items: [] }),
      create: vi.fn().mockResolvedValue({ id: 'level_new' }),
      update: vi.fn().mockResolvedValue({ id: 'level_leader' }),
      reorder: vi.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new LevelsController(
      service as unknown as LevelsService,
    );

    const req = { user: { sub: 'user_admin', role: 'ADMIN' } } as never;
    await controller.list();
    await controller.create({ name: 'Gerente' }, req);
    await controller.update('level_leader', { isActive: false }, req);
    await controller.reorder({ ids: ['level_leader'] }, req);

    expect(service.list).toHaveBeenCalledWith();
    expect(service.create).toHaveBeenCalledWith('user_admin', {
      name: 'Gerente',
    });
    expect(service.update).toHaveBeenCalledWith('user_admin', 'level_leader', {
      isActive: false,
    });
    expect(service.reorder).toHaveBeenCalledWith('user_admin', [
      'level_leader',
    ]);
  });
});
