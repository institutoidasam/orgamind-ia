import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuditTrailController } from './audit-trail.controller';
import type { AuditTrailService } from './audit-trail.service';

type Handler = 'list' | 'personHistory';

function context(handler: Handler, role: string) {
  return {
    getHandler: () => AuditTrailController.prototype[handler],
    getClass: () => AuditTrailController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

const reflector = new Reflector();
const guard = new RolesGuard(reflector);

function rolesOf(handler: Handler): unknown {
  return reflector.get(ROLES_KEY, context(handler, 'ADMIN').getHandler());
}

function allowed(handler: Handler, role: string): boolean {
  try {
    return guard.canActivate(context(handler, role));
  } catch (error) {
    expect(error).toMatchObject({
      status: 403,
      code: 'auth.insufficient_role',
    });
    return false;
  }
}

describe('AuditTrailController — autorização por papel', () => {
  it('list: @Roles("ADMIN"); SUPERVISOR, OPERATOR e VIEWER → 403', () => {
    expect(rolesOf('list')).toEqual(['ADMIN']);
    expect(allowed('list', 'ADMIN')).toBe(true);
    for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER']) {
      expect(allowed('list', role)).toBe(false);
    }
  });

  it('personHistory: @Roles("ADMIN", "SUPERVISOR"); OPERATOR e VIEWER → 403', () => {
    expect(rolesOf('personHistory')).toEqual(['ADMIN', 'SUPERVISOR']);
    for (const role of ['ADMIN', 'SUPERVISOR']) {
      expect(allowed('personHistory', role)).toBe(true);
    }
    for (const role of ['OPERATOR', 'VIEWER']) {
      expect(allowed('personHistory', role)).toBe(false);
    }
  });
});

describe('AuditTrailController — bindings', () => {
  it('encaminha o ator do token, a pessoa e a consulta ao serviço', async () => {
    const service = {
      list: vi.fn().mockResolvedValue({}),
      personHistory: vi.fn().mockResolvedValue({}),
    };
    const controller = new AuditTrailController(
      service as unknown as AuditTrailService,
    );
    const req = { user: { sub: 'user_admin', role: 'ADMIN' } } as never;
    const query = { page: 1, pageSize: 50 };

    await controller.list(query, req);
    await controller.personHistory('user_ana', { page: 2, pageSize: 20 }, req);

    expect(service.list).toHaveBeenCalledWith('user_admin', query);
    expect(service.personHistory).toHaveBeenCalledWith(
      'user_admin',
      'user_ana',
      {
        page: 2,
        pageSize: 20,
      },
    );
  });
});
