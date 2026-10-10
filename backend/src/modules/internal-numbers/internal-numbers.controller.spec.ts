import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { InternalNumbersController } from './internal-numbers.controller';
import { InternalNumbersService } from './internal-numbers.service';

function controllerWithService() {
  const service = {
    list: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 }),
    create: vi.fn().mockResolvedValue({ id: 'number-1' }),
    findById: vi.fn().mockResolvedValue({ id: 'number-1' }),
    update: vi.fn().mockResolvedValue({ id: 'number-1' }),
  };
  return {
    service,
    controller: new InternalNumbersController(
      service as InternalNumbersService,
    ),
  };
}

describe('InternalNumbersController', () => {
  it('requires ADMIN, so unauthenticated and VIEWER requests are rejected by global guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, InternalNumbersController)).toEqual([
      'ADMIN',
    ]);
  });

  it('rejects a VIEWER with the same 403 role guard used by the HTTP app', () => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => () => undefined,
      getClass: () => InternalNumbersController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: 'VIEWER' } }),
      }),
    } as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ status: 403, code: 'auth.insufficient_role' }),
    );
  });

  it('forwards list pagination to the service', async () => {
    const { controller, service } = controllerWithService();

    await controller.list({ page: 2, pageSize: 50 });

    expect(service.list).toHaveBeenCalledWith(2, 50);
  });

  it('forwards structural creation and detail lookup unchanged', async () => {
    const { controller, service } = controllerWithService();
    const body = {
      name: 'Recepção',
      phone: '+5592999990000',
      provider: 'META',
      sectorId: 'sector-1',
      routeToSector: true,
    };

    await controller.create(body);
    await controller.findById('number-1');

    expect(service.create).toHaveBeenCalledWith(body);
    expect(service.findById).toHaveBeenCalledWith('number-1');
  });

  it('forwards PATCH without granting connection or channel access', async () => {
    const { controller, service } = controllerWithService();
    const body = { channelId: 'channel-1' };

    await controller.update('number-1', body);

    expect(service.update).toHaveBeenCalledWith('number-1', body);
  });
});
