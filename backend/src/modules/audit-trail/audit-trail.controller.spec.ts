import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_KEY } from '../auth/decorators/require-permission.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { PermissionsService } from '../permissions/permissions.service';
import {
  permissionsWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import { PERMISSION_DENIED_TEXT } from '../../shared/authz/permissions';
import { AuditTrailController } from './audit-trail.controller';
import type { AuditTrailService } from './audit-trail.service';

type Handler = 'list' | 'personHistory';

function context(handler: Handler, role: Role) {
  return {
    getHandler: () => AuditTrailController.prototype[handler],
    getClass: () => AuditTrailController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

const reflector = new Reflector();

function rolesOf(handler: Handler): unknown {
  return reflector.get(ROLES_KEY, context(handler, 'ADMIN').getHandler());
}

function permissionOf(handler: Handler): unknown {
  return reflector.get(PERMISSION_KEY, context(handler, 'ADMIN').getHandler());
}

/** Cadeia do app: `RolesGuard`, depois `PermissionsGuard`; `change` ajusta a matriz do papel. */
async function passesGuards(
  handler: Handler,
  role: Role,
  change: PermissionChange = {},
) {
  const permissions = {
    effectiveFor: (r: Role) => Promise.resolve(permissionsWith(r, change)),
  } as unknown as PermissionsService;
  const ctx = context(handler, role);
  return (
    new RolesGuard(reflector).canActivate(ctx) &&
    (await new PermissionsGuard(reflector, permissions).canActivate(ctx))
  );
}

const DENIED = {
  status: 403,
  code: 'auth.permission_denied',
  detail: PERMISSION_DENIED_TEXT['trilha.consultar'],
};

describe('AuditTrailController — personHistory por permissão', () => {
  it('personHistory: @RequirePermission("trilha.consultar") e nenhum @Roles', () => {
    expect(permissionOf('personHistory')).toBe('trilha.consultar');
    expect(rolesOf('personHistory')).toBeUndefined();
  });

  it('matriz inicial: ADMIN e SUPERVISOR passam; OPERATOR e VIEWER → 403 auth.permission_denied', async () => {
    for (const role of ['ADMIN', 'SUPERVISOR'] as const) {
      await expect(passesGuards('personHistory', role)).resolves.toBe(true);
    }
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      await expect(passesGuards('personHistory', role)).rejects.toMatchObject(
        DENIED,
      );
    }
  });

  it('OPERATOR com trilha.consultar passa; SUPERVISOR sem a chave → 403 auth.permission_denied', async () => {
    await expect(
      passesGuards('personHistory', 'OPERATOR', {
        grant: ['trilha.consultar'],
      }),
    ).resolves.toBe(true);
    await expect(
      passesGuards('personHistory', 'SUPERVISOR', {
        revoke: ['trilha.consultar'],
      }),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('AuditTrailController — autorização por papel', () => {
  it('list: @Roles("ADMIN") sem permissão; SUPERVISOR, OPERATOR e VIEWER → 403 auth.insufficient_role', async () => {
    expect(rolesOf('list')).toEqual(['ADMIN']);
    expect(permissionOf('list')).toBeUndefined();
    await expect(passesGuards('list', 'ADMIN')).resolves.toBe(true);
    for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER'] as const) {
      await expect(passesGuards('list', role)).rejects.toMatchObject({
        status: 403,
        code: 'auth.insufficient_role',
      });
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
