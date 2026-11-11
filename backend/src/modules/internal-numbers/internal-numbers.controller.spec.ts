import { describe, expect, it, vi } from 'vitest';
import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
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
    findById: vi.fn().mockResolvedValue({ id: 'number-1' }),
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

  it('forwards detail lookup unchanged', async () => {
    const { controller, service } = controllerWithService();

    await controller.findById('number-1');

    expect(service.findById).toHaveBeenCalledWith('number-1');
  });

  it('keeps only the GET routes: POST and PATCH /internal/numbers are retired (D4)', () => {
    const proto = InternalNumbersController.prototype as unknown as Record<
      string,
      unknown
    >;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        method: Reflect.getMetadata(
          METHOD_METADATA,
          proto[name] as object,
        ) as RequestMethod,
      }));

    expect(routes).toEqual([
      { name: 'list', method: RequestMethod.GET },
      { name: 'findById', method: RequestMethod.GET },
    ]);
  });
});
